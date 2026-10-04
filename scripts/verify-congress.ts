/**
 * Quick congress-chain verification (no full Electron scrape).
 * Run: npx esbuild scripts/verify-congress.ts --bundle --platform=node --format=cjs --external:playwright --outfile=tmp/verify-congress.cjs && node tmp/verify-congress.cjs
 */
import {
  scrapeCapitolTradesApi,
  scrapeQuiverCongressEmbed,
} from '../electron/scraper/capitoltrades';
import { scrapeCongressWatchers } from '../electron/scraper/senatewatcher';

async function tryLayer(name: string, fn: () => Promise<{ length: number }>) {
  try {
    const r = await fn();
    console.log(`OK  ${name}: ${r.length} trades`);
    return r.length;
  } catch (e) {
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

async function main() {
  console.log('— Congressional layer probe —');
  const a = await tryLayer('capitol-api', () => scrapeCapitolTradesApi(90));
  const q = await tryLayer('quiver-embed', () => scrapeQuiverCongressEmbed(90));
  const w = await tryLayer('house-senate-watchers', () => scrapeCongressWatchers());
  const total = a + q + w;
  if (total === 0) {
    console.error('ALL layers failed — no politician data available');
    process.exit(1);
  }
  console.log(`\nAt least one layer works (sum of successful layers: ${total} trade-rows).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
