const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'build/scrapling-runtime/scrapling-fetch');
const binary=path.join(dir,process.platform==='win32'?'scrapling-fetch.exe':'scrapling-fetch');
const sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'scripts/scrapling/fetch.py'))).digest('hex');
let fresh=false;
try {fresh=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json'))).sourceSha256===sourceSha256;}catch{}
if(!fresh || !fs.existsSync(binary)) {
 const r=cp.spawnSync(process.env.SCRAPLING_BUILD_PYTHON || (process.platform==='win32'?'python':'python3'),['scripts/scrapling/build-runtime.py'],{cwd:root,stdio:'inherit',windowsHide:true});
 if(r.error || r.status!==0)throw new Error('Cannot build the bundled Scrapling engine; install scripts/scrapling/build-requirements.txt with the build Python.');
}
const r=cp.spawnSync(binary,[],{input:JSON.stringify({mode:'health'}),encoding:'utf8',timeout:15000,windowsHide:true});
if(r.status!==0)throw new Error('Bundled Scrapling health check failed');
const health=JSON.parse(r.stdout);if(health.engine!=='scrapling'||health.version!=='0.4.15'||health.frozen!==true)throw new Error('Incorrect bundled Scrapling engine');
console.log('Bundled Scrapling 0.4.15 verified; no user-installed Python required.');
