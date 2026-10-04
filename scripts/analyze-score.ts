/**
 * Score calibration report — "does a higher score mean anything?"
 *
 *   npm run analyze:score
 *
 * Reads the labeled `signal_outcomes` table (built by `npm run label:outcomes`)
 * and measures the only thing that matters: does a higher score precede higher
 * SPY-relative alpha?
 *
 * WHAT THIS VERSION FIXES (audit 2026-08-22, see tmp/audit/MONOTONICITY.md):
 *
 * 1. POPULATION MIXING. Every stored signal was labeled, including rows with no
 *    scoring content at all — a ticker that entered only because one member of
 *    Congress bought it produces a row with rankWeight 0, optionsScore 0 and a
 *    score of 0. Those were 55% of the 10-day sample, they are mega-cap-heavy
 *    (53% BIG_PLAYERS vs 11% among real signals), and they occupy the entire
 *    bottom of the score range. Correlating across both populations measured the
 *    difference BETWEEN them, not the ranking within either. The report is now
 *    partitioned; "mit Inhalt" is the headline number.
 *
 * 2. OVERLAPPING OBSERVATIONS. `SE ≈ 1/√n` assumes independence. One ticker
 *    contributes up to one observation per calendar day and the 10/20-day
 *    windows overlap almost completely; the measured intra-cluster correlation
 *    is ρ ≈ 0.45 (10d) and ρ ≈ 0.77 (20d). The report now derives a design
 *    effect from a one-way variance decomposition by ticker, reports the
 *    effective sample size, and computes t and the confidence interval from it.
 *    On the full sample this turns t(10d) = −3.00 into −1.95.
 *
 * 3. NO INTERVALS. A bare SE invites over-reading. Buckets now carry a 95%
 *    interval, and buckets below MIN_BUCKET_N are marked, not quietly averaged.
 *
 * 4. NO MONOTONICITY MEASURE. A single IC hides a U-shape. Bucket monotonicity
 *    is now an explicit number.
 *
 * 5. NO OUT-OF-SAMPLE SPLIT. Added as a TIME split (never random — random would
 *    put the same ticker-week on both sides). It is still only a split within
 *    ONE market regime, which the report says out loud.
 */
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getScoreOutcomeRows, getFactorActivity } from '../electron/database';

const HORIZONS = [5, 10, 20];
const BUCKETS: [number, number][] = [
  [0, 20],
  [20, 40],
  [40, 60],
  [60, 80],
  [80, 101],
];
/** Below this a bucket mean is anecdote, not evidence. */
const MIN_BUCKET_N = 30;

export interface Row {
  score: number;
  alpha: number;
  entryDate: string;
  ticker: string;
  hasContent: boolean;
}

// ── statistics ──────────────────────────────────────────────────────────────

function ranks(a: readonly number[]): number[] {
  const idx = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 10) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Design effect from a one-way variance decomposition by ticker.
 * `deff = 1 + (m − 1)·ρ`, so `n_eff = n / deff`. With ρ = 0 (truly independent
 * observations) this collapses to n, i.e. the old behaviour.
 */
export function designEffect(rows: readonly Row[]): { n: number; clusters: number; m: number; rho: number; deff: number } {
  const byTicker = new Map<string, number[]>();
  for (const r of rows) {
    const list = byTicker.get(r.ticker);
    if (list) list.push(r.alpha);
    else byTicker.set(r.ticker, [r.alpha]);
  }
  const n = rows.length;
  const clusters = byTicker.size;
  if (n === 0 || clusters === 0) return { n, clusters, m: 0, rho: 0, deff: 1 };
  const m = n / clusters;
  const grand = mean(rows.map((r) => r.alpha));
  let ssBetween = 0;
  let ssWithin = 0;
  for (const values of byTicker.values()) {
    const mv = mean(values);
    ssBetween += values.length * (mv - grand) ** 2;
    for (const v of values) ssWithin += (v - mv) ** 2;
  }
  const msB = ssBetween / Math.max(clusters - 1, 1);
  const msW = ssWithin / Math.max(n - clusters, 1);
  const rho = msB + (m - 1) * msW > 0 ? Math.max(0, (msB - msW) / (msB + (m - 1) * msW)) : 0;
  return { n, clusters, m, rho, deff: Math.max(1, 1 + (m - 1) * rho) };
}

/** Fisher-z 95% interval for a rank correlation at an effective sample size. */
export function icInterval(r: number, nEff: number): [number, number] {
  if (!Number.isFinite(r) || nEff <= 4 || Math.abs(r) >= 1) return [NaN, NaN];
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(nEff - 3);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

/**
 * Share of adjacent, sufficiently-populated buckets whose mean alpha increases.
 * 1.0 = perfectly monotone; 0.5 = coin flip; null = too few usable buckets.
 */
export function bucketMonotonicity(means: readonly (number | null)[]): number | null {
  const usable = means.filter((m): m is number => m !== null);
  if (usable.length < 2) return null;
  let up = 0;
  for (let i = 1; i < usable.length; i++) if (usable[i] > usable[i - 1]) up++;
  return up / (usable.length - 1);
}

// ── report ──────────────────────────────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function reportSet(label: string, rows: Row[]): void {
  if (rows.length < 20) {
    console.log(`  ${label.padEnd(12)} n=${rows.length} — zu klein für eine Aussage.`);
    return;
  }
  const ic = spearman(rows.map((r) => r.score), rows.map((r) => r.alpha));
  const d = designEffect(rows);
  const nEff = d.n / d.deff;
  const tNaive = ic == null ? 0 : ic * Math.sqrt(d.n);
  const tCluster = ic == null ? 0 : ic * Math.sqrt(nEff);
  const [lo, hi] = icInterval(ic ?? 0, nEff);
  const verdict =
    ic == null
      ? '—'
      : Math.abs(tCluster) >= 2
        ? ic > 0
          ? 'signifikant POSITIV'
          : 'signifikant NEGATIV'
        : 'im Rauschen';

  console.log(
    `  ${label.padEnd(12)} n=${String(d.n).padStart(5)}  Ticker=${String(d.clusters).padStart(4)}  ` +
      `ρ=${d.rho.toFixed(2)}  n_eff=${nEff.toFixed(0).padStart(5)}`,
  );
  console.log(
    `  ${''.padEnd(12)} IC=${(ic ?? NaN).toFixed(3).padStart(6)}  ` +
      `t_naiv=${tNaive.toFixed(2).padStart(6)}  t_cluster=${tCluster.toFixed(2).padStart(6)}  ` +
      `95%-KI=[${lo.toFixed(3)}, ${hi.toFixed(3)}]  → ${verdict}`,
  );

  const bucketMeans: (number | null)[] = [];
  for (const [lo2, hi2] of BUCKETS) {
    const b = rows.filter((r) => r.score >= lo2 && r.score < hi2);
    if (!b.length) {
      bucketMeans.push(null);
      continue;
    }
    const alphas = b.map((r) => r.alpha);
    const m = mean(alphas);
    const sd = stdev(alphas);
    const bd = designEffect(b);
    const bEff = b.length / bd.deff;
    const se = Number.isFinite(sd) ? sd / Math.sqrt(Math.max(bEff, 1)) : NaN;
    const win = b.filter((r) => r.alpha > 0).length / b.length;
    const small = b.length < MIN_BUCKET_N;
    bucketMeans.push(small ? null : m);
    console.log(
      `    ${String(lo2).padStart(2)}–${String(hi2 - 1).padEnd(3)} n=${String(b.length).padStart(4)}` +
        `  Ø=${pct(m).padStart(8)}  95%-KI=[${pct(m - 1.96 * se).padStart(8)}, ${pct(m + 1.96 * se).padStart(8)}]` +
        `  Treffer=${(win * 100).toFixed(0).padStart(3)}%${small ? '  ⚠ zu kleine Stichprobe (aus der Monotonie ausgeschlossen)' : ''}`,
    );
  }
  const mono = bucketMonotonicity(bucketMeans);
  console.log(
    `  ${''.padEnd(12)} Bucket-Monotonie (nur n≥${MIN_BUCKET_N}): ` +
      (mono == null ? '— (zu wenige auswertbare Buckets)' : `${mono.toFixed(2)}  (1.00 = perfekt steigend)`),
  );
}

function outOfSample(rows: Row[]): void {
  if (rows.length < 60) {
    console.log('    (zu wenige Beobachtungen für einen Split)');
    return;
  }
  const sorted = [...rows].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const cut = sorted[Math.floor(sorted.length / 2)].entryDate;
  const inS = sorted.filter((r) => r.entryDate < cut);
  const oos = sorted.filter((r) => r.entryDate >= cut);
  const f = (set: Row[]) => {
    if (set.length < 20) return '—';
    const ic = spearman(set.map((r) => r.score), set.map((r) => r.alpha));
    const d = designEffect(set);
    const t = (ic ?? 0) * Math.sqrt(set.length / d.deff);
    return `IC=${(ic ?? NaN).toFixed(3)} (n=${set.length}, t_cluster=${t.toFixed(2)})`;
  };
  console.log(`    Schnitt ${cut}   IS: ${f(inS)}   OOS: ${f(oos)}`);
}

function main(): void {
  const dbPath = process.env.DB_PATH?.trim() || path.resolve(process.cwd(), 'data', 'insider-tracker.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`No DB at ${dbPath}.`);
    return;
  }
  // Read-only: this is a report, and the file it reads is committed history.
  initDatabase(dbPath, { readonly: true });

  console.log('Score-Kalibrierung — realisiertes SPY-relatives Alpha je Score.\n');
  console.log('„mit Inhalt" = Zeilen mit einem Insider-Leg ODER einem Options-Score.');
  console.log('„inhaltsleer" = Zeilen ohne beides (Score per Konstruktion ≈ 0) — ein anderes');
  console.log('Universum, das die Rangkorrelation der Gesamtmenge dominiert.\n');

  let any = false;
  for (const h of HORIZONS) {
    const raw = getScoreOutcomeRows(h);
    if (raw.length < 20) continue;
    any = true;
    const rows: Row[] = raw.map((r) => {
      let b: { rankWeight?: number; optionsScore?: number } = {};
      try {
        b = r.breakdown ? (JSON.parse(r.breakdown) as typeof b) : {};
      } catch {
        /* an unparseable breakdown counts as "no content" */
      }
      return {
        score: r.score,
        alpha: r.alpha,
        entryDate: r.entryDate,
        ticker: r.ticker,
        hasContent: (b.rankWeight ?? 0) > 0 || (b.optionsScore ?? 0) !== 0,
      };
    });
    const withContent = rows.filter((r) => r.hasContent);
    const empty = rows.filter((r) => !r.hasContent);
    const span = rows.reduce(
      (acc, r) => ({
        min: r.entryDate < acc.min ? r.entryDate : acc.min,
        max: r.entryDate > acc.max ? r.entryDate : acc.max,
      }),
      { min: '9999', max: '0000' },
    );

    console.log(`=== ${h} Tage · Eintritts-Zeitraum ${span.min} → ${span.max} ===`);
    reportSet('mit Inhalt', withContent);
    console.log('');
    reportSet('inhaltsleer', empty);
    console.log('');
    reportSet('ALLE', rows);
    console.log('  Out-of-Sample (zeitlicher Split, nur Zeilen mit Inhalt):');
    outOfSample(withContent);
    console.log('');
  }

  // ── Factor activity ────────────────────────────────────────────────────
  // A component with zero variance is NOT refuted; it was never testable.
  // Printing it next to the IC is what keeps those two claims apart.
  const activity = getFactorActivity();
  if (activity.length && activity[0].total > 0) {
    console.log('=== Faktor-Aktivität über alle gespeicherten Signale ===');
    console.log('  (wie oft weicht der Faktor überhaupt von seinem Neutralwert ab?)');
    for (const f of [...activity].sort((a, b) => b.active - a.active)) {
      const share = (f.active / f.total) * 100;
      const verdict =
        share === 0
          ? 'INAKTIV — nicht widerlegt, nie testbar'
          : share < 2
            ? 'nahezu inaktiv'
            : share < 10
              ? 'selten aktiv'
              : 'aktiv';
      console.log(
        `  ${f.name.padEnd(26)} ${String(f.active).padStart(6)}/${f.total}  ${share.toFixed(1).padStart(5)}%  ${verdict}`,
      );
    }
    console.log('');
  }

  if (!any) {
    console.log('Noch keine gelabelten Outcomes — zuerst `npm run label:outcomes` laufen lassen.');
  } else {
    console.log('─────────────────────────────────────────────────────────────────────');
    console.log('Lesehilfe:');
    console.log('  • t_cluster, nicht t_naiv, ist die belastbare Zahl. n_eff berücksichtigt,');
    console.log('    dass derselbe Ticker mehrfach vorkommt und die Halteperioden überlappen.');
    console.log('  • Der zeitliche Split liegt INNERHALB eines Marktregimes. Er zeigt');
    console.log('    Stabilität, nicht Generalisierung.');
    console.log('  • Eine Verbesserung auf diesem Datensatz ist KEIN Beleg für einen Edge.');
  }
  closeDatabase();
}

// Only run as a program, not when the pure statistics helpers are imported by
// the unit tests.
if (require.main === module) main();
