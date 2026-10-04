/**
 * Regenerate `tests/golden-scores.json` from the fixed cases in
 * `tests/golden.test.ts`. Run this ONLY when a model change is intended, and
 * put the resulting diff in the commit message.
 *
 *   npm run golden:update
 */
import fs from 'node:fs';
import path from 'node:path';

// Must match `test.env.TZ` in vitest.config.ts and must be set before the first
// Date use. A file generated in one zone and verified in another differs for
// every aged case — see the comment in vitest.config.ts.
process.env.TZ = 'UTC';

const FROZEN = Date.parse('2026-08-22T18:00:00Z');
const realNow = Date.now;
Date.now = () => FROZEN;

// Imported AFTER the clock is frozen so the module sees the fixed instant.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CASES } = require('../tests/golden-cases') as typeof import('../tests/golden-cases');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scoreTicker } = require('../electron/scoring') as typeof import('../electron/scoring');

const rows = CASES.map(({ name, agg }) => {
  const s = scoreTicker(agg);
  return {
    name,
    score: s.score,
    tier: s.convictionLevel,
    raw: Math.round(s.breakdown.rawScore * 1000) / 1000,
    confidence: s.breakdown.confidence ?? 0,
  };
});

const out = path.resolve(process.cwd(), 'tests', 'golden-scores.json');
fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
Date.now = realNow;
console.log(`[golden] wrote ${rows.length} case(s) → ${out}`);
for (const r of rows) console.log(`  ${r.name.padEnd(52)} ${String(r.score).padStart(6)}  ${r.tier}`);
