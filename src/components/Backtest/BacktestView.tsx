import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/ipc';
import { GlassCard } from '@/components/UI/GlassCard';
import { normalizeBacktestState } from '@/lib/backtest-records';
import type { BacktestRecord, BacktestState } from '@/types/backtest';

const pct = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const money = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)} USD`;
const statuses = { open: 'Auswertung nach Schließung', pending: 'Analyse ausstehend', complete: 'Ausgewertet', failed: 'Analyse fehlgeschlagen' };
function JsonDetails({ title, data }: { title: string; data: unknown }) {
  return <details className="mt-3"><summary className="cursor-pointer font-medium">{title}</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-3 text-xs">{JSON.stringify(data, null, 2)}</pre></details>;
}

export function BacktestView() {
  const [state, setState] = useState<BacktestState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('closed');
  const [provenance, setProvenance] = useState('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('exit');
  const [selected, setSelected] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState('latest');
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try { setState(normalizeBacktestState(await api.backtest.getState())); }
    catch (e) { setError(e instanceof Error ? e.message : 'Backtest-Daten konnten nicht geladen werden'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); return api.app.onSignalsUpdated(() => void load()); }, [load]);
  const rows = useMemo(() => {
    const records = (state?.records ?? []).filter(r => (status === 'all' || status === 'closed' && r.status !== 'open' || r.status === status) &&
      (provenance === 'all' || r.snapshot.provenance === provenance) &&
      r.position.ticker.toLowerCase().includes(search.toLowerCase()) &&
      (!from || r.position.entryDate >= from) && (!to || r.position.entryDate <= to));
    const ret = (r: BacktestRecord) => (r.position.realizedPnl ?? 0) / r.position.costBasis;
    return records.sort((a, b) => sort === 'score' ? b.position.entryScore - a.position.entryScore :
      sort === 'return' ? ret(b) - ret(a) : sort === 'ticker' ? a.position.ticker.localeCompare(b.position.ticker) :
      sort === 'entry' ? b.position.entryDate.localeCompare(a.position.entryDate) : (b.position.exitDate ?? '').localeCompare(a.position.exitDate ?? ''));
  }, [state, status, provenance, search, from, to, sort]);
  const record = state?.records.find(r => r.key === selected);
  const analysis = analysisId === 'latest' ? record?.analyses.at(-1) : record?.analyses.find(a => a.id === analysisId);
  const retry = async () => {
    if (!record) return;
    setBusy(true); setError('');
    try { setState(normalizeBacktestState(await api.backtest.retry(record.key))); setAnalysisId('latest'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Analyse fehlgeschlagen'); }
    finally { setBusy(false); }
  };
  const exportJson = () => {
    if (!state) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `backtest-1.7-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="backtest-view workspace-view space-y-4">
    <GlassCard>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Backtest</h2><div className="flex gap-2"><button className="btn" disabled={busy} onClick={() => void load()}>Aktualisieren</button><button className="btn btn-primary" disabled={!state || busy} onClick={exportJson}>JSON exportieren</button></div></div>
      <p className="mt-2 text-sm text-secondary">Gekaufte Alerts aus dem Hauptdepot, jeder Kauf einmal archiviert. Keine automatische Änderung von Gewichten oder Handelsregeln.</p>
      <p className="mt-2 text-sm text-secondary">USD-Modell · EUR-Umrechnung und separate Gebühren fehlen. Historische Käufe ohne Original-Snapshot sind von Faktorauswertungen auszuschließen.</p>
      {state?.readOnly && <p className="mt-2 text-sm text-secondary">Veröffentlichte Depotdaten. Erneute Analysen werden nur in diesem Browser gespeichert und im JSON-Export mitgeliefert; sie werden nicht zum Server synchronisiert.</p>}
      {state && <p className="mt-2 text-xs text-secondary">Datenstand: {state.generatedAt || 'unbekannt'} · {state.records.length} Positionen archiviert</p>}
      {error && <p role="alert" className="mt-3 text-red-500">{error}</p>}
      {state?.localError && <p role="alert" className="mt-3 text-amber-500">{state.localError}</p>}
      {!state && busy && <p role="status">Daten werden geladen …</p>}
    </GlassCard>
    <GlassCard>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>Status<select aria-label="Status" className="input ml-2" value={status} onChange={e => setStatus(e.target.value)}><option value="closed">Geschlossene</option><option value="all">Alle</option>{Object.entries(statuses).map(([s, label]) => <option key={s} value={s}>{label}</option>)}</select></label>
        <label>Snapshot<select aria-label="Snapshot" className="input ml-2" value={provenance} onChange={e => setProvenance(e.target.value)}><option value="all">Alle</option><option value="original">Original vorhanden</option><option value="missing">Historisch fehlend</option></select></label>
        <label>Wertpapier<input aria-label="Wertpapier" className="input ml-2" value={search} onChange={e => setSearch(e.target.value)} placeholder="Ticker" /></label>
        <label>Kauf ab<input aria-label="Kauf ab" type="date" className="input ml-2" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>Kauf bis<input aria-label="Kauf bis" type="date" className="input ml-2" value={to} onChange={e => setTo(e.target.value)} /></label>
        <label>Sortierung<select aria-label="Sortierung" className="input ml-2" value={sort} onChange={e => setSort(e.target.value)}><option value="exit">Verkauf (neueste zuerst)</option><option value="entry">Kauf (neueste zuerst)</option><option value="score">Score (höchste zuerst)</option><option value="return">Rendite (höchste zuerst)</option><option value="ticker">Wertpapier (A–Z)</option></select></label>
      </div>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Depot / Wertpapier', 'Kauf', 'Verkauf', 'Score damals', 'Ergebnis', 'Analysestatus'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.key} className="border-t border-white/10">
        <td className="p-2"><button className="text-blue-500 underline" onClick={() => { setSelected(r.key); setAnalysisId('latest'); }}>{r.portfolio} · {r.position.ticker}</button><div className="text-xs text-secondary">{r.snapshot.provenance === 'original' ? 'Original-Snapshot' : 'Historischer Snapshot fehlt'}</div></td>
        <td className="p-2 whitespace-nowrap">{r.position.entryDate}</td><td className="p-2 whitespace-nowrap">{r.position.exitDate ?? 'offen'}</td><td className="p-2">{r.position.entryScore.toFixed(1)}<div className="text-xs text-secondary">{r.snapshot.provenance === 'missing' ? 'Nur gespeicherter Einstiegsscore' : r.snapshot.decision?.signal.convictionLevel}</div></td>
        <td className="p-2 whitespace-nowrap">{money(r.position.realizedPnl)}<div>{pct(r.position.realizedPnl == null ? null : r.position.realizedPnl / r.position.costBasis)}</div></td><td className="p-2">{statuses[r.status]}</td>
      </tr>)}</tbody></table></div>
      {state && rows.length === 0 && <p className="mt-4 text-sm text-secondary">Keine Positionen für diese Filter.</p>}
    </GlassCard>
    {record && <GlassCard>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-bold">{record.portfolio} · {record.position.ticker}</h3><button className="btn" onClick={() => setSelected(null)}>Details schließen</button></div>
      <p className="mt-2 text-sm">{statuses[record.status]} · Kauf: {record.position.entryDate} · Verkauf: {record.position.exitDate ?? 'offen'}</p>
      {record.snapshot.missingReason && <p className="mt-2 text-sm text-amber-500">{record.snapshot.missingReason}</p>}
      {record.replayChanged && <p className="mt-2 text-sm text-amber-500">Ein späterer Simulationslauf weicht von diesem archivierten Handelsverlauf ab. Das Original bleibt erhalten; Abweichungen sind im Export dokumentiert.</p>}
      <h4 className="mt-4 font-semibold">Handelsverlauf</h4>
      <ul className="mt-2 space-y-2 text-sm">{record.trades.map(t => <li key={t.key}>{t.date} · {t.side === 'buy' ? 'Kauf' : 'Verkauf'} · {t.shares.toFixed(6)} Stück × {money(t.price)} = {money(t.value)} · {t.reason ?? 'Alert-Einstieg'} · Gebühren: {t.fees == null ? 'nicht erfasst' : money(t.fees)}</li>)}</ul>
      <JsonDetails title={record.snapshot.provenance === 'original' ? 'Originaler Kauf-Snapshot, Gewichte und Quelldaten' : 'Gespeicherte Handelsdaten – historischer Alert-Snapshot fehlt'} data={record.snapshot} />
      {record.snapshot.decision && <div className="mt-3 text-sm"><p>Bewertungslogik: {record.snapshot.decision.logicVersion} · Alert-Daten: {record.snapshot.decision.signal.scrapedAt} · Snapshot gespeichert: {record.snapshot.capturedAt}</p><p>Begründungen: {record.snapshot.decision.signal.breakdown.notes.join(' · ') || 'Keine erfasst'}</p></div>}
      {record.status !== 'open' && <div className="mt-4 flex flex-wrap gap-3"><button className="btn btn-primary" disabled={busy} onClick={() => void retry()}>Analyse erneut erstellen</button><label>Analyseversion<select aria-label="Analyseversion" className="input ml-2" value={analysisId} onChange={e => setAnalysisId(e.target.value)}><option value="latest">Neueste</option>{record.analyses.map(a => <option key={a.id} value={a.id}>{a.createdAt} · {a.version} · {a.status}</option>)}</select></label></div>}
      {analysis && <div className="mt-4 space-y-4 text-sm">
        <p>Analyse: {analysis.createdAt} · {analysis.version}</p>
        {analysis.error && <p role="alert" className="text-red-500">{analysis.error}</p>}
        {analysis.result && <p className="font-semibold">{analysis.result.holdDays} Tage · {money(analysis.result.pnlUsd)} · {pct(analysis.result.returnPct)} · EUR: nicht beurteilbar · SPY: {pct(analysis.result.benchmarkPct)} · Differenz: {pct(analysis.result.alpha)}</p>}
        {([['Belegte Beobachtungen', analysis.observations], ['Mögliche Erklärungen', analysis.explanations], ['Fehlende Daten und Grenzen', analysis.limitations], ['Hypothesen für spätere Optimierung', analysis.hypotheses]] as [string, string[]][]).map(([title, texts]) => <section key={title}><h4 className="font-semibold">{title}</h4><ul className="mt-2 list-disc space-y-1 pl-5">{texts.map((t, i) => <li key={i}>{t}</li>)}</ul></section>)}
        <section><h4 className="font-semibold">Erwartungen</h4><ul className="mt-2 space-y-2">{analysis.expectations.map(e => <li key={e.statement}><strong>{e.statement}: {e.verdict === 'confirmed' ? 'bestätigt' : e.verdict === 'contradicted' ? 'widersprochen' : 'nicht beurteilbar'}</strong><p>{e.evidence}</p></li>)}</ul></section>
        <JsonDetails title="Strukturierte Einzelbewertungen" data={analysis.factors} />
        <JsonDetails title="Für diese Analyse verwendete Daten" data={analysis.input} />
      </div>}
      <JsonDetails title="Identitäten und spätere Replay-Abweichungen" data={{ key: record.key, portfolioId: record.portfolioId, strategy: record.strategy, replayChanges: record.replayChanges, sourceRecords: record.sourceRecords }} />
    </GlassCard>}
  </div>;
}
