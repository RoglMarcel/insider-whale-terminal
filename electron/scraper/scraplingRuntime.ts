import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cancellationSignal, checkCancelled } from './cancellation';

export function scraplingCommand(resources = (process as NodeJS.Process & {resourcesPath?:string}).resourcesPath): {binary:string; args:string[]} {
  if (process.env.SCRAPLING_BINARY) return {binary:process.env.SCRAPLING_BINARY,args:[]};
  if (resources) {
    const binary=path.join(resources,'scrapling-runtime',process.platform==='win32'?'scrapling-fetch.exe':'scrapling-fetch');
    if (fs.existsSync(binary)) return {binary,args:[]};
  }
  return {binary:process.env.SCRAPLING_PYTHON || (process.platform==='win32'?'python':'python3'),args:[path.resolve('scripts/scrapling/fetch.py')]};
}
export function scraplingEnabled(): boolean {
  if (process.env.SCRAPLING_ENABLED === '0') return false;
  return process.env.SCRAPLING_ENABLED === '1' || scraplingCommand().args.length === 0;
}
export function runScrapling<T>(request: object, timeout = 8000): Promise<T> {
  checkCancelled();
  return new Promise((resolve,reject)=>{
    const signal=cancellationSignal(),command=scraplingCommand();
    const child=spawn(command.binary,command.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='',settled=false;
    function finish(error?:Error,data?:T){
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      error?reject(error):resolve(data!);
    }
    const abort=()=>{child.kill();finish(new Error('Scrapling request cancelled'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Scrapling request timed out'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>12_000_000){child.kill();finish(new Error('Scrapling response too large'));}});
    child.stderr.resume();
    child.on('error',()=>finish(new Error('Scrapling runtime unavailable')));
    child.on('close',code=>{
      try {const data=JSON.parse(output);if(code!==0){finish(Object.assign(new Error('Scrapling public fetch failed'),{status:data.status}));return;}finish(undefined,data);}
      catch {finish(new Error('Invalid Scrapling response'));}
    });
    child.stdin.on('error',()=>undefined);child.stdin.end(JSON.stringify(request));
  });
}
