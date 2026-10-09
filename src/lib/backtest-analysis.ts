import type { BacktestAnalysis, BacktestRecord } from '../types/backtest';

export const BACKTEST_ANALYSIS_VERSION = '1.7.0-observational-1';

/** Descriptive evidence only. No causal inference and no automatic tuning. */
export function analyzeBacktest(record: BacktestRecord, id: string, createdAt: string): BacktestAnalysis {
  const { position: p, snapshot, trades } = record;
  if (!p.exitDate || p.exitPrice == null || p.realizedPnl == null || !(p.costBasis > 0)) throw new Error('Abschlussdaten fehlen');
  const holdDays = Math.round((Date.parse(p.exitDate) - Date.parse(p.entryDate)) / 86400000);
  const returnPct = p.realizedPnl / p.costBasis;
  const benchmarkPct = p.spyEntry && p.spyExit ? p.spyExit / p.spyEntry - 1 : null;
  if (![holdDays, returnPct, p.realizedPnl].every(Number.isFinite)) throw new Error('Ungültige Ergebnisdaten');
  const signal = snapshot.decision?.signal;
  const factors = Object.entries(signal?.breakdown ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([name, value]) => ({ name, value: value as number }));
  const limitations = [
    'Simuliertes Depot: Schlusskurse einschließlich modellierter Slippage, keine Broker-Ausführungen.',
    'Beträge sind USD. Historische EUR-Wechselkurse fehlen; EUR-Ergebnis ist nicht beurteilbar.',
    'Separate Gebühren werden im bestehenden Depotmodell nicht erfasst; sie sind unbekannt, nicht null Euro.',
    'Branchenrendite, Nachrichtenverlauf und Intraday-Kurse fehlen. Ursachen und optimale Ein-/Ausstiege sind nicht beurteilbar.',
    'Das bestehende Modell kauft einmal pro Position und verkauft vollständig. Wiederkäufe nach Schließung sind eigene Positionen.',
    'Ein einzelner Gewinn oder Verlust belegt weder die Qualität noch das richtige Gewicht eines Faktors.',
  ];
  if (!signal) limitations.push(snapshot.missingReason ?? 'Originaler Kauf-Snapshot fehlt.');
  if (signal && !snapshot.decision?.context) limitations.push('Vollständiges Bewertungsaggregat fehlt; VIX-Rohwert, Marktkapitalisierung und Track-Record-Eingaben sind nicht vollständig rekonstruierbar.');
  for (const f of signal?.breakdown.dormantFactors ?? []) limitations.push(`${f.factor}: ${f.reason}`);
  const observations = [
    `Haltedauer: ${holdDays} Kalendertage. Realisiert: ${p.realizedPnl.toFixed(2)} USD (${(returnPct * 100).toFixed(2)}%).`,
    `Ausstiegsregel: ${p.exitReason ?? 'unbekannt'}. Einstieg ${p.entryPrice}, Ausstieg ${p.exitPrice}; ${p.shares} Stück.`,
    `Damals verwendeter Einstiegsscore: ${p.entryScore}; Kaufgrenze: ${snapshot.config.entryScore}.`,
  ];
  if (benchmarkPct != null) observations.push(`SPY im gleichen Zeitraum: ${(benchmarkPct * 100).toFixed(2)}%; Differenz: ${((returnPct - benchmarkPct) * 100).toFixed(2)} Prozentpunkte. Das ist ein Vergleich, keine Ursache.`);
  else limitations.push('Benchmark für den vollständigen Haltezeitraum fehlt.');
  if (signal) observations.push(...signal.breakdown.notes.map(n => `Originale Bewertungsbegründung: ${n}`));
  const factorLabels: Record<string, string> = { clusterMultiplier: 'Insider-Cluster', timingMultiplier: 'Insider-Ergebniszeitpunkt',
    optionsTimingMultiplier: 'Options-Ergebniszeitpunkt', freshnessMultiplier: 'Aktualität', vixMultiplier: 'VIX', trackRecordMultiplier: 'Insider-Track-Record', valuationMultiplier: 'Bewertung' };
  for (const f of factors) {
    const label = factorLabels[f.name];
    if (label && f.value !== 1) observations.push(`${label}: damaliger Multiplikator ${f.value.toFixed(3)} (${f.value > 1 ? 'verstärkend' : 'dämpfend'}). Dies beschreibt die Bewertung, keinen bewiesenen Renditebeitrag.`);
  }
  if (signal?.breakdown.confidence != null) observations.push(`Damals gespeicherte Datenkonfidenz: ${signal.breakdown.confidence}/100.`);
  if (signal?.breakdown.fairValue) {
    const fv = signal.breakdown.fairValue;
    limitations.push(...fv.warnings.map(w => `Bewertungsdaten beim Kauf: ${w}`));
    limitations.push('Fair Value ist eine Modellschätzung ohne zugesicherten Haltehorizont. Das Erreichen eines Zielkurses allein bestätigt das Modell nicht.');
  }
  const boosted = factors.filter(f => factorLabels[f.name] && f.value > 1).map(f => `${factorLabels[f.name]} (${f.value.toFixed(3)})`);
  return {
    id, createdAt, version: BACKTEST_ANALYSIS_VERSION, status: 'complete', error: null,
    input: { snapshot, trades, position: p },
    result: { holdDays, pnlUsd: p.realizedPnl, pnlEur: null, returnPct, benchmarkPct, alpha: benchmarkPct == null ? null : returnPct - benchmarkPct },
    factors, observations,
    expectations: [
      { statement: 'Positiver realisierter Ertrag', verdict: returnPct > 0 ? 'confirmed' : returnPct < 0 ? 'contradicted' : 'unknown', evidence: 'Nur Richtung des Ergebnisses; der Score verspricht keine bestimmte Rendite.' },
      { statement: 'Mehrertrag gegenüber SPY', verdict: benchmarkPct == null ? 'unknown' : returnPct > benchmarkPct ? 'confirmed' : 'contradicted', evidence: 'Vergleich über denselben Haltezeitraum, ohne kausale Zuordnung.' },
      { statement: 'Einzelfaktoren und ursprüngliche Begründungen waren prognostisch richtig', verdict: 'unknown', evidence: 'Erfordert mehrere vergleichbare Käufe, passende Zielhorizonte und unabhängige Daten.' },
    ],
    explanations: ['Marktbewegungen sowie die Ausstiegsregel könnten das Ergebnis beeinflusst haben. Ihr kausaler Anteil ist mit diesen Daten nicht bestimmbar.'],
    limitations,
    hypotheses: [
      ...(boosted.length ? [`Für diesen Kauf verstärkten ${boosted.join(', ')} die Bewertung. In der späteren Gesamtstichprobe prüfen, ob diese Verstärkungen mit Mehrertrag verbunden sind oder mögliche Übergewichtung zeigen.`] : []),
      ...(signal?.breakdown.confidence != null && signal.breakdown.confidence < 60 ? ['Diese Entscheidung hatte geringe Datenkonfidenz. Ergebnisse solcher Käufe getrennt von gut belegten Signalen vergleichen.'] : []),
      'Nach etwa drei Monaten Rendite und SPY-Differenz nach Einstiegsscore, Depot und Haltezeit vergleichen; kleine Stichproben kennzeichnen.',
      'Originale Einzelbewertungen, Datenkonfidenz und ruhende Faktoren gegen Ergebnisse prüfen; mögliche Übergewichtung erst über mehrere unabhängige Beobachtungen testen.',
      'Ausstiegsgrund, Slippage und Einstiegsdatum getrennt vom Alert untersuchen, bevor Gewichte verändert werden.',
      'Für Branchen- und Nachrichtenhypothesen zeitpunktgetreue Daten ergänzen; fehlende Snapshots von Faktorauswertungen ausschließen.',
    ],
  };
}
