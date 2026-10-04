import { describe, expect, it } from 'vitest';
import { encodeSession, decodeSession, type EncryptionProvider } from '../electron/sessionCodec';
import { requirePlatform, requireHistoryUrl, trustedRenderer, externalWebUrl } from '../electron/securityBoundary';
import { LOGIN_PLATFORMS } from '../src/types';
const state={cookies:[{name:'synthetic',value:'test-only',domain:'openinsider.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax' as const}],origins:[]};
const provider: EncryptionProvider={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()};
describe('secure session storage',()=>{
 it('roundtrips encrypted sessions and produces encrypted legacy migration bytes',()=>{
  const encoded=encodeSession(state,provider);expect(encoded.subarray(0,4).toString()).toBe('ENC:');expect(decodeSession(encoded,provider).state).toEqual(state);
  for(const prefix of ['RAW:','']){const decoded=decodeSession(Buffer.from(prefix+JSON.stringify(state)),provider);expect(decoded.migration?.subarray(0,4).toString()).toBe('ENC:');expect(decoded.state).toEqual(state);}
 });
 it('never falls back to plaintext on unavailable storage, encryption exceptions or Linux basic_text',()=>{
  expect(()=>encodeSession(state,{...provider,isEncryptionAvailable:()=>false})).toThrow();
  expect(()=>encodeSession(state,{...provider,encryptString:()=>{throw Error('locked');}})).toThrow('locked');
  expect(()=>encodeSession(state,{...provider,getSelectedStorageBackend:()=> 'basic_text'},'linux')).toThrow();
  expect(()=>decodeSession(Buffer.from('RAW:'+JSON.stringify(state)),{...provider,isEncryptionAvailable:()=>false})).toThrow();
 });
 it.each(['RAW:{}','garbage','ENC:garbage'])('rejects corrupt state %s',s=>expect(()=>decodeSession(Buffer.from(s),provider)).toThrow());
 it('contains platform file paths at the shared auth boundary',()=>{
  for(const p of LOGIN_PLATFORMS)expect(()=>requirePlatform(p.key)).not.toThrow();
  for(const input of ['../outside','..\\outside','unknown','',null,42])expect(()=>requirePlatform(input)).toThrow();
 });
});
describe('renderer and URL authority',()=>{
 it('requires matching webContents, main frame and exact application document',()=>{
  const frame={url:'file:///C:/app/dist/index.html'};const owner={mainFrame:frame};const event={sender:owner,senderFrame:frame};
  expect(trustedRenderer(event,owner,frame.url)).toBe(true);
  expect(trustedRenderer({...event,sender:{}},owner,frame.url)).toBe(false);
  expect(trustedRenderer({...event,senderFrame:{url:frame.url}},owner,frame.url)).toBe(false);
  expect(trustedRenderer(event,owner,'file:///C:/other/index.html')).toBe(false);
  frame.url='http://localhost:5173/';expect(trustedRenderer(event,owner,frame.url)).toBe(true);
  expect(trustedRenderer(event,owner,'http://localhost:5174/')).toBe(false);
 });
 it('allows established history links but rejects host/path/credential/port aliases',()=>{
  for(const url of ['http://openinsider.com/insider/Jane-Doe/123','https://www.openinsider.com/insider/Jane/123'])expect(requireHistoryUrl(url)).toBe(url);
  for(const url of ['file:///etc/passwd','http://localhost/insider/Jane/123','http://openinsider.com.evil.test/insider/Jane/123','http://openinsider.com@evil.test/insider/Jane/123','http://openinsider.com:8888/insider/Jane/123','http://openinsider.com/redirect?url=http://localhost'])expect(()=>requireHistoryUrl(url)).toThrow();
  for(const url of ['javascript:alert(1)','file:///C:/test','httpx://example.com','https://user:pass@example.com'])expect(externalWebUrl(url)).toBeNull();
 });
});
