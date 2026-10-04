import { Notification, BrowserWindow } from 'electron';
import type { Signal, SourceHealthIssue, AlertHit, FilingEvent } from '../src/types';

/**
 * Tracks tickers we've already notified about so a desktop notification only
 * fires for NEW signals at/above the threshold (requirement #8). Seeded from
 * the DB at startup so an app restart doesn't re-notify existing signals.
 */
let notified = new Set<string>();

export function seedNotified(tickers: string[]): void {
  notified = new Set(tickers.map((t) => t.toUpperCase()));
}

function formatUSD(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function focusWindow(win?: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showSingle(signal: Signal, win?: BrowserWindow | null): void {
  const role = signal.topInsiderRole ? ` · ${signal.topInsiderRole}` : '';
  // Label from the actual conviction tier — the notification threshold is
  // configurable and can fire below the HIGH cutoff.
  const tier =
    signal.convictionLevel === 'HIGH' ? '🟢 HIGH CONVICTION' :
    signal.convictionLevel === 'WATCH' ? '🟡 WATCH' : '⚪ SIGNAL';
  const n = new Notification({
    title: `${tier} · ${signal.ticker} (${signal.score.toFixed(0)})`,
    body: `${signal.insiderCount} insider(s)${role} · ${formatUSD(signal.totalDollarVolume)} bought${fairValueSummary(signal)}`,
    silent: false,
  });
  n.on('click', () => {
    focusWindow(win);
    win?.webContents.send('app:open-ticker', signal.ticker);
  });
  n.show();
}

function fairValueSummary(signal: Signal): string {
  const fv = signal.breakdown.fairValue;
  if (!fv) return '';
  if (fv.low == null || fv.high == null) return ' · Fair value: insufficient data';
  return ` · FV ${fv.low.toFixed(2)}–${fv.high.toFixed(2)} ${fv.currency} (L${fv.level}${fv.status === 'fallback' ? ', fallback' : ''}) · ${fv.recommendation}`;
}

function showSummary(tickers: string[], win?: BrowserWindow | null): void {
  const n = new Notification({
    title: `🟢 ${tickers.length} new high-conviction signals`,
    body: tickers.slice(0, 6).join(', ') + (tickers.length > 6 ? '…' : ''),
    silent: false,
  });
  n.on('click', () => focusWindow(win));
  n.show();
}

/**
 * Feature 4 — combo signals always fire a high-priority notification, regardless
 * of the score threshold. De-duped by the orchestrator (only NEW combos passed).
 */
const MAX_INDIVIDUAL_NOTIFICATIONS = 4;

export function notifyCombos(tickers: string[], signals: Signal[], win?: BrowserWindow | null): void {
  if (!Notification.isSupported() || tickers.length === 0) return;
  // First-scrape guard: if a fresh DB surfaces many "new" combos at once, summarize
  // them into a single toast instead of firing one notification per ticker.
  if (tickers.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
    const n = new Notification({
      title: `⚡ ${tickers.length} new combo signals`,
      body: tickers.slice(0, 8).join(', ') + (tickers.length > 8 ? '…' : ''),
      silent: false,
      urgency: 'critical',
    });
    n.on('click', () => focusWindow(win));
    n.show();
    return;
  }
  const byTicker = new Map(signals.map((s) => [s.ticker, s]));
  for (const ticker of tickers) {
    const s = byTicker.get(ticker);
    const tier = s?.breakdown?.politicianComboTier ?? null;
    const title =
      tier === 'MEGA_SIGNAL'
        ? `🚨 MEGA SIGNAL: $${ticker}`
        : tier === 'POLITICIAN_INSIDER'
          ? `🏛️ POLITICIAN+INSIDER: $${ticker}`
          : tier === 'POLITICIAN_OPTIONS'
            ? `🏛️ POLITICIAN+OPTIONS: $${ticker}`
            : `⚡ COMBO SIGNAL: $${ticker}`;
    const body = s
      ? tier
        ? `${tier.replace(/_/g, ' ')} · score ${s.score.toFixed(0)} · ${formatUSD(s.totalDollarVolume)}`
        : `Insider buying + unusual options flow · score ${s.score.toFixed(0)} · ${formatUSD(s.totalDollarVolume)}`
      : 'Insider buying + unusual options flow on the same ticker';
    const n = new Notification({
      title,
      body: body + (s ? fairValueSummary(s) : ''),
      silent: false,
      urgency: 'critical',
    });
    n.on('click', () => {
      focusWindow(win);
      win?.webContents.send('app:open-ticker', ticker);
    });
    n.show();
  }
}

/**
 * Feature 9 — notify on sharp conviction jumps vs the previous scrape. Naturally
 * de-duped: once a score settles high, the delta vs the (now-high) prior is ~0.
 */
export function notifyScoreSurges(
  surges: { ticker: string; from: number; to: number }[],
  win?: BrowserWindow | null,
): void {
  if (!Notification.isSupported() || surges.length === 0) return;
  if (surges.length === 1) {
    const s = surges[0];
    const n = new Notification({
      title: `📈 ${s.ticker} conviction surging`,
      body: `Score jumped ${s.from.toFixed(0)} → ${s.to.toFixed(0)} since the last scrape.`,
      silent: false,
    });
    n.on('click', () => {
      focusWindow(win);
      win?.webContents.send('app:open-ticker', s.ticker);
    });
    n.show();
  } else {
    const n = new Notification({
      title: `📈 ${surges.length} conviction surges`,
      body: surges.slice(0, 6).map((s) => `${s.ticker} ${s.from.toFixed(0)}→${s.to.toFixed(0)}`).join(', '),
      silent: false,
    });
    n.on('click', () => focusWindow(win));
    n.show();
  }
}

/**
 * 13D/13G radar — new ACTIVIST stakes (13D) notify individually like combos;
 * passive 13Gs are summarized. De-duped upstream: only first-seen filings
 * arrive here.
 */
export function notifyFilingEvents(events: FilingEvent[] | undefined, win?: BrowserWindow | null): void {
  if (!Notification.isSupported() || !events?.length) return;
  const activist = events.filter((e) => e.type.startsWith('SC 13D'));
  const passive = events.filter((e) => !e.type.startsWith('SC 13D'));
  for (const e of activist.slice(0, MAX_INDIVIDUAL_NOTIFICATIONS)) {
    const n = new Notification({
      title: `⚡ ${e.type}: $${e.ticker}`,
      body: `${e.filer ?? 'A 5%+ holder'} disclosed a stake (${e.filedDate})`,
      silent: false,
    });
    n.on('click', () => {
      focusWindow(win);
      win?.webContents.send('app:open-ticker', e.ticker);
    });
    n.show();
  }
  const overflow = activist.length - MAX_INDIVIDUAL_NOTIFICATIONS;
  if (overflow > 0 || passive.length > 0) {
    const parts: string[] = [];
    if (overflow > 0) parts.push(`${overflow} more 13D(s)`);
    if (passive.length > 0) parts.push(`${passive.length} 13G large-holder filing(s)`);
    const tickers = [...new Set([...activist.slice(MAX_INDIVIDUAL_NOTIFICATIONS), ...passive].map((e) => e.ticker))];
    const n = new Notification({
      title: `📄 ${parts.join(' · ')}`,
      body: tickers.slice(0, 8).join(', ') + (tickers.length > 8 ? '…' : ''),
      silent: false,
    });
    n.on('click', () => focusWindow(win));
    n.show();
  }
}

/**
 * Custom alert rules — one notification per hit (clicking opens the ticker),
 * summarized into a single toast when a session fires many at once. Crossing
 * semantics upstream keep these from repeating while a condition stays true.
 */
export function notifyAlertHits(hits: AlertHit[] | undefined, win?: BrowserWindow | null): void {
  if (!Notification.isSupported() || !hits?.length) return;
  if (hits.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
    const n = new Notification({
      title: `🔔 ${hits.length} custom alerts fired`,
      body: [...new Set(hits.map((h) => h.ticker))].slice(0, 8).join(', '),
      silent: false,
    });
    n.on('click', () => focusWindow(win));
    n.show();
    return;
  }
  for (const hit of hits) {
    const n = new Notification({ title: `🔔 Alert: ${hit.ticker}`, body: hit.message, silent: false });
    n.on('click', () => {
      focusWindow(win);
      win?.webContents.send('app:open-ticker', hit.ticker);
    });
    n.show();
  }
}

/**
 * Source health — one alert per broken source, not one per scrape: a source
 * stays muted after its first alert until it recovers (produces rows again),
 * after which a fresh breakage re-alerts.
 */
const healthNotified = new Set<string>();

export function notifySourceHealth(issues: SourceHealthIssue[] | undefined): void {
  const current = new Set((issues ?? []).map((i) => i.source));
  // Recovered sources re-arm their alert.
  for (const s of [...healthNotified]) {
    if (!current.has(s)) healthNotified.delete(s);
  }
  if (!Notification.isSupported() || !issues?.length) return;
  const fresh = issues.filter((i) => !healthNotified.has(i.source));
  if (!fresh.length) return;
  for (const i of fresh) healthNotified.add(i.source);
  // A flapping source is not dead — it returns rows on most runs and zero on
  // some — so it needs its own wording and its own numbers. Reporting it with
  // the dead-source phrasing produced "0 rows for 0 runs", because
  // consecutiveZeroRuns is 0 by definition for an intermittent failure.
  const anyDead = fresh.some((i) => i.kind !== 'flapping');
  const n = new Notification({
    title: anyDead
      ? `⚠ ${fresh.length} scraper source(s) may be broken`
      : `⚠ ${fresh.length} scraper source(s) failing intermittently`,
    body: fresh
      .map((i) =>
        i.kind === 'flapping'
          ? `${i.source}: 0 rows in ${i.zeroRunsInWindow ?? '?'} of the last ${i.runsInWindow ?? '?'} runs (median ${i.rollingMedian})`
          : `${i.source}: 0 rows for ${i.consecutiveZeroRuns} runs (median ${i.rollingMedian})`,
      )
      .join(' · ')
      .slice(0, 200),
    silent: false,
  });
  n.show();
}

/**
 * Fire notifications for signals at/above the threshold that we haven't already
 * notified about. Returns the list of freshly-notified tickers.
 */
export function notifyForSignals(
  signals: Signal[],
  threshold: number,
  win?: BrowserWindow | null,
): string[] {
  const atOrAbove = signals.filter((s) => s.score >= threshold);
  const currentTickers = atOrAbove.map((s) => s.ticker.toUpperCase());
  const fresh = atOrAbove.filter((s) => !notified.has(s.ticker.toUpperCase()));

  // Accumulate (never replace): a ticker that dips below the threshold for one
  // scrape (e.g. freshness decay at midday) and re-crosses later must not
  // re-notify — nothing new happened.
  for (const t of currentTickers) notified.add(t);

  if (!Notification.isSupported() || fresh.length === 0) return [];

  if (fresh.length === 1) {
    showSingle(fresh[0], win);
  } else {
    showSummary(fresh.map((s) => s.ticker), win);
  }
  return fresh.map((s) => s.ticker);
}
