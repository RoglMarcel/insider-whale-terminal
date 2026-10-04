import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { LOGIN_PLATFORMS } from '../src/types';
const fake = vi.hoisted(()=>({files:new Map<string,Buffer>(),available:true,failRename:false,closed:0,writes:0}));
vi.mock('electron',()=>({app:{getPath:()=>'/synthetic-user'},safeStorage:{isEncryptionAvailable:()=>fake.available,encryptString:(s:string)=>Buffer.from(s).reverse(),decryptString:(b:Buffer)=>Buffer.from(b).reverse().toString()}}));
const sample={cookies:[{name:'test',value:'synthetic',domain:'example.test',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]};
vi.mock('playwright',()=>({chromium:{launch:async()=>({newContext:async()=>({addInitScript:async()=>{},newPage:async()=>({goto:async()=>{}}),pages:()=>[],storageState:async()=>sample}),on:()=>{},close:async()=>{fake.closed++;}})}}));
vi.mock('../electron/scraper/browser',()=>({USER_AGENT:'test',exportIndexedDBString:'',restoreIndexedDBScript:''}));
vi.mock('node:fs',()=>({default:{mkdirSync:()=>{},statSync:(p:string)=>{if(!fake.files.has(p))throw Error('missing');return {mtimeMs:1,mtime:new Date(0)};},readFileSync:(p:string)=>{const b=fake.files.get(p);if(!b)throw Error('missing');return b;},writeFileSync:(p:string,b:Buffer)=>{fake.writes++;fake.files.set(p,b);},renameSync:(a:string,b:string)=>{if(fake.failRename)throw Error('disk');fake.files.set(b,fake.files.get(a)!);fake.files.delete(a);},rmSync:(p:string)=>{fake.files.delete(p);}}}));
const key=LOGIN_PLATFORMS[0].key;
const file=path.join('/synthetic-user','sessions',key+'.session');
beforeEach(()=>{vi.resetModules();fake.files.clear();fake.available=true;fake.failRename=false;fake.closed=0;fake.writes=0;});
describe('real auth persistence boundary with synthetic storage',()=>{
 it('migrates legacy plaintext before using it and refuses use if atomic replacement fails',async()=>{
  const auth=await import('../electron/auth');const raw=Buffer.from('RAW:'+JSON.stringify(sample));fake.files.set(file,raw);fake.failRename=true;
  expect(auth.isLoggedIn(key)).toBe(false);expect(fake.files.get(file)).toEqual(raw);
  fake.failRename=false;expect(auth.isLoggedIn(key)).toBe(true);expect(fake.files.get(file)?.subarray(0,4).toString()).toBe('ENC:');
 });
 it('never writes when secure storage is unavailable and leaves login open for retry',async()=>{
  const auth=await import('../electron/auth');expect((await auth.startLogin(key)).ok).toBe(true);fake.available=false;
  expect((await auth.saveLogin(key)).ok).toBe(false);expect(fake.writes).toBe(0);expect(fake.closed).toBe(0);
  fake.available=true;expect((await auth.saveLogin(key)).ok).toBe(true);expect(fake.closed).toBe(1);expect(auth.isLoggedIn(key)).toBe(true);
  await auth.logout(key);expect(auth.isLoggedIn(key)).toBe(false);
 });
 it('rejects traversal before any deletion',async()=>{
  const auth=await import('../electron/auth');fake.files.set(path.join('/synthetic-user','outside.session'),Buffer.from('sentinel'));
  await expect(auth.logout('../outside')).rejects.toThrow('Unknown');expect(fake.files.size).toBe(1);
 });
});
