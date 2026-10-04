/* Real installation/update test only on a disposable GitHub Windows runner. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {_electron}=require('playwright');
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='win32')throw Error('Requires a disposable GitHub Windows runner');
const executable=process.env.INSTALLED_APP;
if(!executable||!path.resolve(executable).startsWith(path.resolve(process.env.RUNNER_TEMP)+path.sep))throw Error('Installation must stay in runner temporary directory');
const out=path.resolve('tmp/release-update-verification');fs.mkdirSync(out,{recursive:true});
const report={from:'1.6.6',to:'1.6.7',steps:[]};
let instance;
async function main(){
  instance=await _electron.launch({executablePath:executable,args:['--disable-gpu'],timeout:60000});
  instance.process().stdout?.on('data',data=>process.stdout.write(data));
  instance.process().stderr?.on('data',data=>process.stderr.write(data));
  let window=await instance.firstWindow();await window.waitForLoadState('domcontentloaded');
  assert.equal(await window.evaluate(()=>window.api.app.getVersion()),'1.6.6');
  report.steps.push('Previous installer and actual application started');
  await window.waitForFunction(async()=> (await window.api.app.getUpdateStatus()).status==='downloaded',undefined,{timeout:180000,polling:1000});
  assert.equal((await window.evaluate(()=>window.api.app.getUpdateStatus())).version,'1.6.7');
  report.steps.push('Automatic startup check recognized and downloaded 1.6.7');
  // The normal user action opens the interactive NSIS wizard. On this
  // unattended runner, keep the real IPC/updater/installer path but select
  // its supported silent mode, so installation does not wait for wizard clicks.
  await instance.evaluate(()=>{
    const updater=process.mainModule.require('electron-updater').autoUpdater;
    const install=updater.quitAndInstall.bind(updater);
    updater.quitAndInstall=()=>install(true,false);
  });
  report.installationMode='Real updater and NSIS installer, unattended silent mode';
  // A packaged app can leave child-process streams open after its main process
  // quits. Check the actual installed executable rather than Playwright's
  // connection-close event, which is not the installation contract.
  await window.evaluate(()=>window.api.app.quitAndInstall()).catch(e=>{if(!/closed|destroyed/i.test(e.message))throw e;});
  const version=()=>cp.execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Item -LiteralPath '${executable.replace(/'/g,"''")}').VersionInfo.ProductVersion`],{encoding:'utf8',windowsHide:true}).trim();
  const deadline=Date.now()+120000;
  while(version()!=='1.6.7'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2000));
  report.installedVersion=version();
  assert.equal(report.installedVersion,'1.6.7');report.steps.push('Actual updater installed 1.6.7');
  instance=undefined;
  // Installer may relaunch the app; its single-instance process is already
  // active. Stop only this isolated application's exact executable before
  // attaching the second verification session.
  cp.execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process | Where-Object { $_.Path -eq '${executable.replace(/'/g,"''")}' } | Stop-Process`],{windowsHide:true});
  instance=await _electron.launch({executablePath:executable,args:['--disable-gpu'],timeout:60000});
  window=await instance.firstWindow();await window.waitForLoadState('domcontentloaded');
  assert.equal(await window.evaluate(()=>window.api.app.getVersion()),'1.6.7');
  await window.evaluate(()=>window.api.app.checkForSoftwareUpdates());
  await window.waitForFunction(async()=> (await window.api.app.getUpdateStatus()).status==='current',undefined,{timeout:60000,polling:1000});
  await window.screenshot({path:path.join(out,'installed-1.6.7.png')});
  report.steps.push('Installed application starts, manual software check reports current');
  const worker=path.join(path.dirname(executable),'resources','scrapling-runtime','scrapling-fetch.exe');
  const health=JSON.parse(cp.execFileSync(worker,[],{input:'{"mode":"health"}',encoding:'utf8',windowsHide:true,timeout:15000}));
  assert.deepEqual(health,{engine:'scrapling',version:'0.4.15',frozen:true});
  const runtime=JSON.parse(fs.readFileSync(path.join(path.dirname(worker),'runtime.json'),'utf8'));
  const hash=require('node:crypto').createHash('sha256').update(fs.readFileSync('scripts/scrapling/fetch.py')).digest('hex');assert.equal(runtime.sourceSha256,hash);
  report.steps.push('Actually installed Scrapling runtime and source hash verified');
  report.success=true;report.at=new Date().toISOString();console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{report.error=e.message;console.error(e);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));if(instance)await instance.close().catch(()=>undefined);});
