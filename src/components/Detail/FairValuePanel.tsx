import type { FairValueResult } from '@/types/fairValue';
import { analysisMoney, compactNumber } from '@/lib/analysisFormat';

const recommendations = { undervalued: 'Unterbewertet – Sicherheitsmarge erfüllt', watch: 'Beobachten – Sicherheitsmarge nicht erfüllt', overvalued: 'Überbewertet – Alert abgeschwächt', 'insufficient-data': 'Datenlage unzureichend – neutral im Alert' };
export function FairValuePanel({ value }: { value?: FairValueResult }) {
  if (!value) return <section className="rounded-xl p-4 text-sm text-secondary">Fair Value: wird beim nächsten Datenabruf ermittelt.</section>;
  const money = (n: number | null) => analysisMoney(n, value.currency, 'de-DE');
  return <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}>
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Fair Value · Stufe {value.level}</h3><span className="text-xs text-secondary">{value.status === 'fallback' ? 'Fallback-Schätzung' : value.status === 'unavailable' ? 'Nicht verfügbar' : 'Modellschätzung'} · {new Date(value.calculatedAt).toLocaleString('de-DE')}</span></div>
    <div className="text-xl font-semibold">{money(value.low)} – {money(value.high)}</div>
    <p className="text-sm">{recommendations[value.recommendation]}</p>
    <div className="text-sm text-secondary">Modellmitte {money(value.fairValue)} · Referenzkurs {money(value.price)}<br />
      Einstiegsschwelle {money(value.entryPrice)} · Sicherheitsabschlag {Math.round(value.marginOfSafety * 100)}% auf die Modellmitte<br />
      Bewertungsgewicht {Math.round(value.weight * 100)}% · Score-Faktor ×{value.multiplier.toFixed(3)} · {value.models.filter(m => m.value != null).length}/26 Modelle</div>
    {!!value.scenarios?.length && <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{value.scenarios.map(s=><div key={s.name} className="rounded-lg border p-3" style={{borderColor:'var(--border-glass)'}}><div className="text-xs uppercase text-secondary">{s.name === 'bear' ? 'Vorsichtig' : s.name === 'base' ? 'Basis' : 'Optimistisch'}</div><div className="font-semibold">{money(s.value)}</div><div className="text-xs text-secondary">Wachstum {(s.growth*100).toFixed(1)}% → {(s.terminal*100).toFixed(1)}% · Diskont {(s.discount*100).toFixed(1)}%</div></div>)}</div>}
    <details><summary className="cursor-pointer text-sm">Daten, Quellen und Modellabdeckung</summary>
      <div className="overflow-x-auto"><table className="w-full text-xs mt-2"><thead><tr><th className="text-left">Datenpunkt</th><th>Wert</th><th>Quelle / Abruf</th></tr></thead><tbody>
        {Object.entries(value.inputs).map(([key, datum]) => <tr key={key}><td>{key}</td><td className="text-right">{/Growth|wacc|costEquity|taxRate|roe|roic|payoutRatio/.test(key) ? `${(datum.value*100).toFixed(2)}%` : compactNumber(datum.value,'de-DE')}</td><td className="text-right"><a href={datum.source} target="_blank" rel="noreferrer" className="underline">Quelle</a> · {new Date(datum.fetchedAt).toLocaleDateString('de-DE')}</td></tr>)}
      </tbody></table></div>
      <ul className="text-xs space-y-1 mt-3">{value.models.map(m => <li key={m.name}>{m.name}: {m.value == null ? m.reason : money(m.value)}</li>)}</ul>
    </details>
    <details><summary className="cursor-pointer text-sm">Annahmen und Einschränkungen</summary><ul className="text-xs space-y-1 mt-2">{[...value.assumptions, ...value.warnings].map((s, i) => <li key={i}>{s}</li>)}</ul></details>
  </section>;
}
