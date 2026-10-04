import { spawn } from 'node:child_process';
import path from 'node:path';
import { cancellationSignal } from './cancellation';
export interface ScraplingTable { headers: string[]; rows: {cells: string[]; insiderUrl: string; filingUrl: string}[]; }
export const useScrapling = () => process.env.SCRAPLING_ENABLED === '1';
/** CI opts in explicitly. A bounded Python process replaces transport; original TS financial parsers remain authoritative. */
export function scraplingTable(url: string, selectors: string[]): Promise<ScraplingTable> {
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',[path.resolve('scripts/scrapling/fetch.py')],{stdio:['pipe','pipe','pipe']});
    let output='';let settled=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Public source timed out'));},25_000);
    function finish(error?:Error,data?:ScraplingTable){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(data!);}
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4_000_000){child.kill('SIGKILL');finish(new Error('Public source too large'));}});
    child.stderr.resume(); // Library request details never become frontend data.
    child.on('error',()=>finish(new Error('Public source fetch unavailable')));
    child.on('close',code=>{if(code!==0)return finish(new Error('Public source fetch failed'));try{const data=JSON.parse(output) as ScraplingTable;if(!Array.isArray(data.headers)||!Array.isArray(data.rows))throw new Error();finish(undefined,data);}catch{finish(new Error('Public source response invalid'));}});
    child.stdin.on('error',()=>undefined);child.stdin.end(JSON.stringify({url,selectors}));
  });
}

/** Optional runner transport. Packaged desktop uses native fetch unless explicitly configured. */
export function scraplingHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = cancellationSignal();
    const child = spawn(process.env.SCRAPLING_PYTHON || 'python3', [path.resolve('scripts/scrapling/fetch.py')], {stdio:['pipe','pipe','pipe'], windowsHide:true});
    let output = '', settled = false;
    const abort = () => { child.kill(); finish(new Error('Public source cancelled')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Public source timed out')); }, 8000);
    function finish(error?: Error, html?: string) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(html!);
    }
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8_000_000) { child.kill(); finish(new Error('Public source too large')); } });
    child.stderr.resume();
    child.on('error', () => finish(new Error('Public source fetch unavailable')));
    child.on('close', code => {
      try {
        const data = JSON.parse(output);
        if (code !== 0 || typeof data.html !== 'string') {
          const error = Object.assign(new Error('Public source unavailable'), {status:data.status}); finish(error); return;
        }
        finish(undefined, data.html);
      }
      catch { finish(new Error('Public source unavailable or blocked')); }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({url, mode:'html'}));
  });
}
