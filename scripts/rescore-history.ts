/**
 * Re-score the labeled history under the CURRENT scoring model.
 *
 *   npm run rescore:history
 *
 * WHY THIS EXISTS
 *
 * `signal_outcomes.score` is frozen at signal time and never recomputed. That is
 * the right design for a walk-forward record — but it means the calibration
 * report measures whatever model was live when each row was written, not the
 * model that exists today.
 *
 * Between the last label (2026-08-16) and now, the freshness rule changed: an
 * undateable signal used to score at FULL strength (`ageDays == null → 1.0`) and
 * now scores at the floor (`→ 0.15`). 50–63% of stored breakdowns carry exactly
 * that shape (`signalAgeDays: null` AND `freshnessMultiplier: 1.0`), so for the
 * majority of the labeled sample the frozen score is NOT what today's code would
 * produce — a factor of up to 6.7 on the insider leg. Every IC in
 * `analyze:score` inherits that, which makes the whole evidence base a statement
 * about a superseded model.
 *
 * WHAT IT DOES — AND DELIBERATELY DOES NOT
 *
 * It does NOT re-run `scoreTicker`. `marketCap`, `vix` and `bestAccuracy3m` were
 * never persisted (neither as columns nor in the breakdown), so the scorer's
 * inputs cannot be rebuilt and any attempt would silently invent them. What IS
 * persisted is the full component snapshot in `signal_outcomes.breakdown`, and
 * the composite is a closed-form function of those components. So the composite
 * is rebuilt from the stored components and ONLY the freshness leg is swapped
 * for the current rule.
 *
 * The other audit fixes are deliberately out of scope here: they operate on raw
 * trades (which the breakdown does not carry) and their measured impact was 1
 * changed score in 689. Correcting the one rule whose effect is large and whose
 * inputs survive is honest; pretending to replay the rest is not.
 *
 * IT PROVES THE REBUILD BEFORE USING IT. Reconstructing with the OLD rule must
 * reproduce the stored `rawScore` and `normalizedScore`. Rows that fail that
 * check are counted, reported and EXCLUDED — never silently "corrected".
 *
 * READ-ONLY. Nothing is written to the database.
 */
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getScoreOutcomeRows } from '../electron/database';
import { getFreshnessMultiplier, DEFAULT_SCORING_CONFIG, CONVICTION_THRESHOLDS } from '../src/types';
import { spearman, designEffect, icInterval, bucketMonotonicity, type Row } from './analyze-score';

const HORIZONS = [5, 10, 20];
const BUCKETS: [number, number][] = [
  [0, 20],
  [20, 40],
  [40, 60],
  [60, 80],
  [80, 101],
];
const MIN_BUCKET_N = 30;

const H = DEFAULT_SCORING_CONFIG.scoreHalfSaturation;
const FLOOR = DEFAULT_SCORING_CONFIG.freshnessFloor;

/** Relative tolerance for "the reconstruction reproduces the stored value". */
const REL_TOL = 1e-6;
/** `comboBonus` is stored rounded to 0.1, so the normalization check needs slack. */
const NORM_TOL = 0.15;
/**
 * The complete output range of `getValuationMultiplier`. Ordered with the
 * neutral value first so a row that never had valuation data resolves on the
 * first try instead of being fitted to a coincidence.
 */
const LEGAL_VALUATION = [1.0, 1.15, 1.08, 0.9];

interface Breakdown {
  rankWeight?: number;
  dollarVolumePoints?: number;
  typeModifier?: number;
  clusterMultiplier?: number;
  timingMultiplier?: number;
  optionsScore?: number;
  optionsTimingMultiplier?: number;
  freshnessMultiplier?: number;
  vixMultiplier?: number;
  trackRecordMultiplier?: number;
  /** Added by this audit — absent on every row written before it. */
  valuationMultiplier?: number;
  comboBonus?: number;
  signalAgeDays?: number | null;
  rawScore?: number;
  normalizedScore?: number;
  politicianScore?: number;
}

type Verdict = 'ok-no-options' | 'ok-options' | 'fail-residual' | 'fail-freshness-range' | 'fail-normalization' | 'fail-parse';

interface Rebuilt {
  ticker: string;
  entryDate: string;
  alpha: number;
  storedScore: number;
  newScore: number;
  hasContent: boolean;
  /** Was this row generated under the old `null → 1.0` freshness rule? */
  affectedByRule: boolean;
  /** Valuation multiplier, recovered from the residual when not persisted. */
  valuation: number;
  verdict: Verdict;
}

const saturate = (c: number): number => (Math.max(c, 0) / (Math.max(c, 0) + H)) * 100;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function close(a: number, b: number, tol = REL_TOL): boolean {
  return Math.abs(a - b) <= Math.max(tol, tol * Math.max(Math.abs(a), Math.abs(b)));
}

/**
 * Rebuild the composite from the stored components, verify it against the stored
 * result, then recompute it under the current freshness rule.
 */
function rebuild(b: Breakdown): { verdict: Verdict; storedScore: number; newScore: number; affected: boolean; valuation: number } {
  const rankWeight = b.rankWeight ?? 0;
  const dvp = b.dollarVolumePoints ?? 0;
  const typeMod = b.typeModifier ?? 0;
  const cluster = b.clusterMultiplier ?? 1;
  const timing = b.timingMultiplier ?? 1;
  const vix = b.vixMultiplier ?? 1;
  const optScore = b.optionsScore ?? 0;
  const optTiming = b.optionsTimingMultiplier ?? 1;
  const TR = b.trackRecordMultiplier ?? 1;
  const P = b.politicianScore ?? 0;
  const storedRaw = b.rawScore ?? NaN;
  const storedNorm = b.normalizedScore ?? NaN;
  const storedFresh = b.freshnessMultiplier ?? 1;
  const age = b.signalAgeDays ?? null;
  const liveBonus = b.comboBonus ?? 0;
  const storedVal = typeof b.valuationMultiplier === 'number' ? b.valuationMultiplier : null;

  const fail = (verdict: Verdict) => ({
    verdict,
    storedScore: storedNorm,
    newScore: storedNorm,
    affected: false,
    valuation: 1,
  });

  if (!Number.isFinite(storedRaw) || !Number.isFinite(storedNorm) || TR === 0) return fail('fail-parse');

  // 1. The stored normalization must be the saturating curve we think it is.
  //    `comboBonus` holds the live soft-multiplier expressed as a point delta.
  const normOld = saturate(storedRaw);
  if (!close(normOld + liveBonus, storedNorm, NORM_TOL)) return fail('fail-normalization');

  // 2. Split the composite back into its two legs.
  //      combined = (insiderRaw·F_i + optionsRaw·F_o)·TR·VAL + P
  //
  //    VAL is the valuation multiplier. It was applied to the composite but was
  //    NOT a field on ScoreBreakdown until this audit, so historical rows scored
  //    while a fair-value provider was live cannot state it — it has to be
  //    recovered. Its range is discrete (getValuationMultiplier returns exactly
  //    one of four values), which makes the recovery identifiable rather than a
  //    free parameter: a wrong VAL leaves the residual off by ~10%.
  const insiderRaw = rankWeight * dvp * typeMod * cluster * timing * vix;
  const optionsRaw = optScore * optTiming;
  const candidates = storedVal != null ? [storedVal] : LEGAL_VALUATION;

  let optionsFreshness = 1;
  let valuation = 1;
  let verdict: Verdict | null = null;
  for (const VAL of candidates) {
    const impliedLegs = (storedRaw - P) / (TR * VAL);
    const residual = impliedLegs - insiderRaw * storedFresh; // = optionsRaw · F_o
    if (Math.abs(optionsRaw) < 1e-9) {
      // No options leg — the residual must vanish, otherwise this VAL is wrong.
      if (close(residual, 0, Math.max(1e-6, 1e-6 * Math.abs(impliedLegs)))) {
        valuation = VAL;
        verdict = 'ok-no-options';
        break;
      }
    } else {
      const fo = residual / optionsRaw;
      // The options leg decays on its own clock; whatever it was, it has to be a
      // legal freshness value. If it is not, this VAL is wrong.
      if (fo >= FLOOR - 1e-6 && fo <= 1 + 1e-6) {
        optionsFreshness = fo;
        valuation = VAL;
        verdict = 'ok-options';
        break;
      }
    }
  }
  if (verdict == null) return fail(Math.abs(optionsRaw) < 1e-9 ? 'fail-residual' : 'fail-freshness-range');

  // 3. Swap ONLY the insider-leg freshness for the current rule.
  const freshNew = getFreshnessMultiplier(age);
  const combinedNew = (insiderRaw * freshNew + optionsRaw * optionsFreshness) * TR * valuation + P;
  const normNew = saturate(combinedNew);

  // 4. Re-apply the corroboration soft multiplier, re-gated on the NEW base.
  const softMult = normOld > 1e-9 ? storedNorm / normOld : 1;
  const applies = softMult > 1 + 1e-9 && normNew >= CONVICTION_THRESHOLDS.watch;
  const finalNew = clamp(applies ? normNew * softMult : normNew, 0, 100);

  // Rows written under the old rule are exactly those with an unknown age that
  // nonetheless carried a full-strength multiplier.
  const affected = age == null && close(storedFresh, 1.0, 1e-6);

  return {
    verdict,
    storedScore: Math.round(storedNorm * 10) / 10,
    newScore: Math.round(finalNew * 10) / 10,
    affected,
    valuation,
  };
}

function tier(score: number): string {
  if (score >= CONVICTION_THRESHOLDS.high) return 'HIGH';
  if (score >= CONVICTION_THRESHOLDS.watch) return 'WATCH';
  return 'LOW';
}

function fmtIC(rows: Row[]): string {
  if (rows.length < 20) return '   n/a (zu wenige Zeilen)';
  const ic = spearman(
    rows.map((r) => r.score),
    rows.map((r) => r.alpha),
  );
  if (ic == null) return '   n/a (keine Varianz)';
  const d = designEffect(rows);
  const nEff = d.n / d.deff;
  const t = ic * Math.sqrt(nEff);
  const [lo, hi] = icInterval(ic, nEff);
  return (
    `n=${String(d.n).padStart(5)}  n_eff=${nEff.toFixed(0).padStart(5)}  ` +
    `IC=${ic >= 0 ? '+' : ''}${ic.toFixed(3)}  t_cluster=${t >= 0 ? '+' : ''}${t.toFixed(2)}  ` +
    `95%-KI [${lo.toFixed(3)}; ${hi.toFixed(3)}]`
  );
}

function bucketMeans(rows: Row[]): (number | null)[] {
  return BUCKETS.map(([lo, hi]) => {
    const set = rows.filter((r) => r.score >= lo && r.score < hi);
    if (set.length < MIN_BUCKET_N) return null;
    return set.reduce((a, r) => a + r.alpha, 0) / set.length;
  });
}

function main(): void {
  const dbPath = process.env.DB_PATH?.trim() || path.resolve(process.cwd(), 'data', 'insider-tracker.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`Keine DB unter ${dbPath}.`);
    return;
  }
  initDatabase(dbPath, { readonly: true });

  console.log('Re-Scoring der gelabelten Historie unter dem AKTUELLEN Modell.\n');
  console.log('Rekonstruiert den Komposit-Score aus den gespeicherten Komponenten und');
  console.log('tauscht ausschließlich die Freshness-Regel (`null → 1.0` → `null → Floor`).');
  console.log('Die Rekonstruktion wird ZUERST gegen die gespeicherten Werte bewiesen;');
  console.log('Zeilen, die den Beweis nicht bestehen, werden ausgeschlossen, nicht korrigiert.\n');

  const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), horizons: {} };

  for (const h of HORIZONS) {
    const raw = getScoreOutcomeRows(h);
    if (raw.length < 20) continue;

    const rebuiltRows: Rebuilt[] = [];
    const verdicts: Record<string, number> = {};

    for (const r of raw) {
      let b: Breakdown = {};
      let parsed = true;
      try {
        b = r.breakdown ? (JSON.parse(r.breakdown) as Breakdown) : {};
      } catch {
        parsed = false;
      }
      const res = parsed
        ? rebuild(b)
        : { verdict: 'fail-parse' as Verdict, storedScore: r.score, newScore: r.score, affected: false, valuation: 1 };
      verdicts[res.verdict] = (verdicts[res.verdict] ?? 0) + 1;
      rebuiltRows.push({
        ticker: r.ticker,
        entryDate: r.entryDate,
        alpha: r.alpha,
        storedScore: res.storedScore,
        newScore: res.newScore,
        hasContent: (b.rankWeight ?? 0) > 0 || (b.optionsScore ?? 0) !== 0,
        affectedByRule: res.affected,
        valuation: res.valuation,
        verdict: res.verdict,
      });
    }

    const ok = rebuiltRows.filter((r) => r.verdict.startsWith('ok'));
    const failed = rebuiltRows.filter((r) => !r.verdict.startsWith('ok'));
    const fidelity = (ok.length / rebuiltRows.length) * 100;

    console.log(`=== ${h} Tage ===`);
    console.log(`  Rekonstruktion: ${ok.length}/${rebuiltRows.length} Zeilen reproduzieren den gespeicherten Score (${fidelity.toFixed(1)} %)`);
    for (const [k, v] of Object.entries(verdicts).sort((a, b2) => b2[1] - a[1])) {
      console.log(`    ${k.padEnd(24)} ${String(v).padStart(5)}`);
    }
    if (failed.length) {
      const sample = failed.slice(0, 3).map((f) => `${f.ticker}@${f.entryDate}(${f.verdict})`).join(', ');
      console.log(`    ausgeschlossen, Beispiele: ${sample}`);
    }

    // Only rows whose reconstruction is proven may be re-scored.
    const content = ok.filter((r) => r.hasContent);
    const affected = ok.filter((r) => r.affectedByRule);
    const changed = ok.filter((r) => Math.abs(r.newScore - r.storedScore) > 0.05);
    const tierChanged = ok.filter((r) => tier(r.newScore) !== tier(r.storedScore));
    const meanOld = ok.reduce((a, r) => a + r.storedScore, 0) / Math.max(ok.length, 1);
    const meanNew = ok.reduce((a, r) => a + r.newScore, 0) / Math.max(ok.length, 1);

    const valued = ok.filter((r) => Math.abs(r.valuation - 1) > 1e-9);
    console.log(`  Von der Regeländerung betroffen: ${affected.length} (${((affected.length / ok.length) * 100).toFixed(1)} %)`);
    if (valued.length) {
      const kinds = [...new Set(valued.map((r) => r.valuation))].sort((a, b2) => a - b2).join(', ');
      console.log(`  Valuation-Multiplikator aus dem Residuum zurückgewonnen: ${valued.length} Zeilen (Werte: ${kinds})`);
    }
    console.log(`  Score geändert: ${changed.length} · Tier gewechselt: ${tierChanged.length}`);
    console.log(`  Mittelwert ${meanOld.toFixed(2)} → ${meanNew.toFixed(2)}`);

    const asRows = (pick: (r: Rebuilt) => number) => (set: Rebuilt[]): Row[] =>
      set.map((r) => ({ score: pick(r), alpha: r.alpha, entryDate: r.entryDate, ticker: r.ticker, hasContent: r.hasContent }));
    const oldRows = asRows((r) => r.storedScore);
    const newRows = asRows((r) => r.newScore);

    console.log('  IC — ALLE (rekonstruierbare) Zeilen:');
    console.log(`    vorher : ${fmtIC(oldRows(ok))}`);
    console.log(`    nachher: ${fmtIC(newRows(ok))}`);
    console.log('  IC — nur Zeilen mit Inhalt:');
    console.log(`    vorher : ${fmtIC(oldRows(content))}`);
    console.log(`    nachher: ${fmtIC(newRows(content))}`);

    const monoOld = bucketMonotonicity(bucketMeans(oldRows(content)));
    const monoNew = bucketMonotonicity(bucketMeans(newRows(content)));
    console.log(
      `  Bucket-Monotonie (mit Inhalt): ${monoOld == null ? 'n/a' : monoOld.toFixed(2)} → ${monoNew == null ? 'n/a' : monoNew.toFixed(2)}`,
    );
    console.log('');

    (out.horizons as Record<string, unknown>)[String(h)] = {
      n: rebuiltRows.length,
      reconstructed: ok.length,
      fidelityPct: fidelity,
      verdicts,
      affectedByRule: affected.length,
      changed: changed.length,
      tierChanged: tierChanged.length,
      meanOld,
      meanNew,
      rows: ok.map((r) => ({ t: r.ticker, d: r.entryDate, old: r.storedScore, new: r.newScore, a: r.alpha, c: r.hasContent })),
    };
  }

  console.log('Lesehilfe:');
  console.log('  • Die Rekonstruktions-Quote ist die Voraussetzung für alles Weitere. Liegt sie');
  console.log('    unter 100 %, ist die Differenz NICHT stillschweigend korrigiert worden.');
  console.log('  • Ein unveränderter IC ist ein Ergebnis, kein Fehlschlag: er heißt, dass die');
  console.log('    Regeländerung die RANGFOLGE nicht angetastet hat.');
  console.log('  • Der Datensatz bleibt EIN Marktregime. Nichts hier belegt einen Edge.');

  const dir = path.resolve(process.cwd(), 'tmp', 'rescore');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rescore-history.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nDetails geschrieben nach ${path.relative(process.cwd(), file)}`);

  closeDatabase();
}

if (require.main === module) main();
