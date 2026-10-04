const assert = require('node:assert/strict');
const http = require('node:http');
const {chromium} = require('playwright');
const {withPage} = require('../../tmp/browser-test.cjs');
(async()=>{
 let blockedHits=0;
 const blocked=http.createServer((req,res)=>{blockedHits++;res.end('forbidden');});
 await new Promise(r=>blocked.listen(0,'127.0.0.1',r));
 const forbidden=`http://127.0.0.1:${blocked.address().port}`;
 const allowed=http.createServer((req,res)=>{
  const targets={'/direct':forbidden,'/chain':'/direct','/valid':'/document','/loop':'/loop'};
  if(targets[req.url]){res.writeHead(302,{Location:targets[req.url]});res.end();}
  else {res.setHeader('Content-Type','text/html');res.end('<html><body>legitimate history</body></html>');}
 });
 await new Promise(r=>allowed.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${allowed.address().port}`;
 let browser;
 try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  await context.addCookies([{name:'synthetic_session',value:'test-only',domain:'127.0.0.1',path:'/'}]);
  const options={validateNavigation:url=>{if(new URL(url).origin!==origin)throw Error('Forbidden origin');return url;}};
  for(const path of ['/direct','/chain','/loop'])await assert.rejects(withPage(context,origin+path,p=>p.textContent('body'),options));
  assert.equal(blockedHits,0,'forbidden destination must receive zero requests');
  assert.equal(await withPage(context,origin+'/valid',p=>p.textContent('body'),options),'legitimate history');
  assert.equal(await withPage(context,origin+'/document',p=>p.textContent('body'),options),'legitimate history');
  console.log('PASS: direct/multi-hop redirects blocked before request; allowed redirect and direct page work.');
 }finally{await browser?.close();await Promise.all([new Promise(r=>allowed.close(r)),new Promise(r=>blocked.close(r))]);}
})().catch(e=>{console.error(e);process.exitCode=1;});
