import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Unit tests for the PURE modules only — `electron/scoring.ts`,
 * `src/types/index.ts` and the parsing helpers in `electron/scraper/util.ts`.
 * All three are dependency-free by design (no Electron, no DOM, no SQLite), so
 * `environment: 'node'` is enough and the suite runs in well under a second.
 *
 * Deliberately NOT covered here: anything that needs a browser, the network or
 * the database. Those are exercised by `verify:scoring` / `verify:db` /
 * `verify:scrape`, which stay as they are.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.join(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
    /**
     * Freezing the CLOCK does not freeze the TIMEZONE. Trade dates are
     * date-only strings that resolve to LOCAL midnight, so the same frozen
     * instant yields a different `signalAgeDays` in CEST than in UTC — and the
     * freshness decay is a continuous exponential, so that sub-day offset moves
     * every aged score. The golden file was generated in CEST and passed
     * locally while failing in CI, which is the whole failure mode a gate is
     * supposed to prevent. Pin it so the suite is reproducible everywhere.
     */
    env: { TZ: 'UTC' },
  },
});
