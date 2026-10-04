const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const api=require('../../tmp/experiment-db-test.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'track-cache-'));
try {
 const file=path.join(dir,'fixture.db');
 let db=api.initDatabase(file);
 db.prepare('INSERT INTO insider_track_records(insider_name,total_trades,accuracy_3m,last_updated) VALUES(?,?,?,?)').run('Legacy',8,1,new Date().toISOString());
 assert.equal(api.getTrackRecord('Legacy'),null);
 assert.equal(db.prepare('SELECT count(*) n FROM insider_track_records').get().n,1);
 const record={insiderName:'Legacy',totalTrades:8,profitable3m:4,profitable6m:3,accuracy3m:.5,accuracy6m:.5,avgReturn3m:2,recentTrades:[],lastUpdated:new Date().toISOString()};
 api.upsertTrackRecord(record);
 assert.equal(api.getTrackRecord('Legacy').accuracy3m,.5);
 api.upsertTrackRecord({...record,accuracy3m:1,error:'Adjusted price coverage incomplete; retry later.'});
 assert.equal(api.getTrackRecord('Legacy').accuracy3m,.5);
 api.closeDatabase();db=api.initDatabase(file);
 assert.equal(api.getTrackRecord('Legacy').accuracy3m,.5);
 assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
 console.log('PASS: legacy cache retained but excluded; adjusted record survives reopen; partial result cannot replace it.');
}finally{api.closeDatabase();fs.rmSync(dir,{recursive:true,force:true});}
