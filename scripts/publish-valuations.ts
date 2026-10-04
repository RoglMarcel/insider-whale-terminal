import fs from 'node:fs';
import { validateDocument } from '../src/lib/valuation/validate';
import { calculateModels } from '../src/lib/valuation/calculate';
import { mergeValuations } from '../src/lib/valuation/merge';
const source='tmp/fundamentals-collected.json';
const current=validateDocument(JSON.parse(fs.readFileSync(source,'utf8')));
const baseline=validateDocument(JSON.parse(fs.readFileSync('data/valuation-baseline.json','utf8')));
const document=mergeValuations(baseline,current);
// Computations are isolated from signals.json: no retrospective scoring or portfolio changes.
for(const [ticker,rows]of Object.entries(document.stocks))for(const row of rows){const count=calculateModels(row).filter(m=>m.status==='available').length;console.log(`${ticker} ${row.provider}: ${count}/26 models with sufficient inputs`);}
fs.mkdirSync('public/data',{recursive:true});fs.writeFileSync('public/data/valuations.json',JSON.stringify(document));
