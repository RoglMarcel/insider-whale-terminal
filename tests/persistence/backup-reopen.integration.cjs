const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Sqlite=require('better-sqlite3');
const api=require('../../tmp/experiment-db-test.cjs');
const input=process.argv[2];
assert(input,'Pass a consistent backup file, never a live database.');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insider-backup-reopen-'));
const file=path.join(dir,'copy.db'); fs.copyFileSync(input,file);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function retained(db) {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name).filter(n=>n.startsWith('portfolio_')||['signals','signal_outcomes','daily_prices','scrape_log','insider_trades'].includes(n));
  return Object.fromEntries(tables.map(t=>[t,hash(db.prepare('SELECT * FROM "'+t.replaceAll('"','""')+'" ORDER BY rowid').all())]));
}
let raw=new Sqlite(file,{readonly:true}); const before=retained(raw); raw.close();
for(let i=0;i<2;i++) { const db=api.initDatabase(file); assert.equal(db.pragma('integrity_check',{simple:true}),'ok'); api.closeDatabase(); }
raw=new Sqlite(file,{readonly:true}); const after=retained(raw); raw.close();
for(const [table,digest] of Object.entries(before)) assert.equal(after[table],digest,table+' changed');
console.log('PASS backup-copy reopen: '+Object.keys(before).length+' retained tables unchanged across two startups.');
