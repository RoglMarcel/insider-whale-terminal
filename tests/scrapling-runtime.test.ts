import { describe,it,expect,vi,afterEach } from 'vitest';
import { scraplingCommand,scraplingEnabled } from '../electron/scraper/scraplingRuntime';
import { parseInsiderMonitorTable } from '../electron/scraper/insidermonitor';
afterEach(()=>vi.unstubAllEnvs());
describe('shared Scrapling runtime',()=>{
 it('supports a bundled executable independently of working directory and Python PATH',()=>{
  vi.stubEnv('SCRAPLING_BINARY','C:\\app\\resources\\scrapling-runtime\\scrapling-fetch.exe');
  vi.stubEnv('SCRAPLING_ENABLED','');
  expect(scraplingCommand().args).toEqual([]);expect(scraplingEnabled()).toBe(true);
 });
 it('keeps configured source Python and the explicit test/development opt-out',()=>{
  vi.stubEnv('SCRAPLING_BINARY','');vi.stubEnv('SCRAPLING_PYTHON','test-python');vi.stubEnv('SCRAPLING_ENABLED','0');
  expect(scraplingCommand(undefined).binary).toBe('test-python');expect(scraplingEnabled()).toBe(false);
 });
 it('preserves grouped-row inheritance and transaction codes across transports',()=>{
  const r=parseInsiderMonitorTable({headers:['Symbol','Company','Insider Name','Trade Type','Shares','Value','Trade Date'],rows:[
   ['AAPL','Apple','Person','AB','100 $10','1000','2026-10-02'],
   ['','','Person','B','200 $10','2000','2026-10-02']
  ]});
  expect(r.map(t=>t.ticker)).toEqual(['AAPL','AAPL']);expect(r[0].transactionType).toBe('10b5-1 Purchase');expect(r[1].value).toBe(2000);
 });
});
