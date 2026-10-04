import type { FairValueResult } from '@/types/fairValue';
import { analysisMoney, compactNumber } from '@/lib/analysisFormat';
import { useI18n } from '@/hooks/useI18n';
import { valuationComparison } from '@/lib/fairValueDisplay';

export function FairValuePanel({ value, loading = false }: { value?: FairValueResult; loading?: boolean }) {
  const { language } = useI18n(); const de = language === 'de';
  const locale = de ? 'de-DE' : 'en-US';
  if (!value) return <section className="rounded-xl p-4 text-sm text-secondary"><strong>Fair Value · {de?'Stufe':'Level'} 1</strong><p>{loading ? (de?'Fundamentaldaten werden geladen …':'Loading fundamentals …') : (de?'Keine belastbare Zahlenbasis verfügbar. Preis und Abweichung können noch nicht berechnet werden.':'No supported numerical basis available. Price and deviation cannot yet be calculated.')}</p></section>;
  const money = (n: number | null) => analysisMoney(n, value.currency, locale);
  const deviation = valuationComparison(value);
  const stale = Date.now() - Date.parse(value.calculatedAt) > 86_400_000;
  const label = deviation == null ? (de?'Bewertung noch nicht berechenbar':'Valuation not yet calculable') : `${Math.abs(deviation).toFixed(1)}% ${de ? (deviation < -5 ? 'unterbewertet im Modell' : deviation > 5 ? 'überbewertet im Modell' : 'Abweichung vom Fair Value') : (deviation < -5 ? 'undervalued in model' : deviation > 5 ? 'overvalued in model' : 'deviation from fair value')}`;
  return <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}>
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Fair Value · Stufe {value.level}</h3><span className="text-xs text-secondary">{value.status === 'fallback' ? 'Fallback-Schätzung' : value.status === 'unavailable' ? 'Nicht verfügbar' : 'Modellschätzung'} · {new Date(value.calculatedAt).toLocaleString('de-DE')}</span></div>
    <div className="text-xl font-semibold">{money(value.fairValue)} <span className="text-xs font-normal text-secondary">{de?'zentraler Fair Value':'central fair value'}</span></div>
    <p className="text-sm">{label}{stale && (de?' · ältere Daten, keine aktuelle Kauf-Einordnung':' · older data, no current purchase assessment')}</p>
    <div className="text-sm text-secondary">Referenzkurs {money(value.price)} · {de?'Potenzial zum Basiswert':'Potential to base value'} {value.upsidePct == null ? '—' : `${value.upsidePct >= 0 ? '+' : ''}${value.upsidePct.toFixed(1)}%`}<br />
      {de?'Zusätzliche Sicherheitsmarge':'Additional margin of safety'}: {value.safetyMarginMet ? (de?'erfüllt':'met') : (de?'noch nicht erfüllt':'not yet met')} · {de?'Konservativer Wunschpreis':'Conservative entry target'} {money(value.entryPrice)} ({Math.round(value.marginOfSafety * 100)}%)<br />
      Bewertungsgewicht {Math.round(value.weight * 100)}% · Score-Faktor ×{value.multiplier.toFixed(3)} · {value.models.filter(m => m.value != null).length} {de?'berechenbare Modelle':'calculable models'}</div>
    <div data-external-fair-value className="rounded-lg border p-3 space-y-2" style={{borderColor:'var(--border-glass)'}}>
      <h4 className="font-semibold text-sm">{de?'Abgleich mit externen Bewertungen':'External valuation comparison'}</h4>
      <p className="text-xs text-secondary">{de?'Unterschiedliche Modelle und Annahmen. Vergleichswerte ersetzen den eigenen Fair Value nicht und erhöhen die Datenstufe nicht.':'Different models and assumptions. Reference values do not replace our fair value or raise its evidence level.'}</p>
      {!value.externalComparisons?.length && <p className="text-xs text-secondary">{de?'Für diesen Datenstand wurde noch kein externer Vergleich abgerufen.':'No external comparison has been fetched for this snapshot.'}</p>}
      {value.externalComparisons?.filter(c=>c.provider==='fairvaluecalculator'||c.provider==='alphaspread').map(c=>{
        const aged = Date.now()-Date.parse(c.asOf || c.fetchedAt)>(c.asOf?7:1)*86_400_000;
        const difference = c.modelDifferencePct;
        return <div key={c.provider} className="text-xs space-y-1"><div className="flex flex-wrap justify-between gap-2"><a href={c.url} target="_blank" rel="noreferrer" className="underline font-semibold">{c.provider==='fairvaluecalculator'?'Fair Value Calculator':c.provider==='alphaspread'?'Alpha Spread':'GuruFocus'} · {c.method}</a><strong>{c.status==='available' ? analysisMoney(c.value,c.currency,locale) : de ? c.status==='cooldown'?'Abruf pausiert':c.status==='blocked'?'Abruf blockiert':c.status==='unsupported'?'Notierung nicht unterstützt':'Nicht verfügbar' : c.status==='cooldown'?'Fetch paused':c.status==='blocked'?'Fetch blocked':c.status==='unsupported'?'Unsupported listing':'Unavailable'}</strong></div>
          {c.status==='available' && <p>{de?'Eigenes Modell gegenüber Anbieter':'Our model relative to provider'}: {difference==null?'—':`${difference>=0?'+':''}${difference.toFixed(1)}%`}{difference!=null && Math.abs(difference)>25 && (de?' · deutliche Abweichung, Annahmen prüfen':' · material difference, review assumptions')}{aged && (de?' · veraltet':' · stale')}</p>}
          {c.marketMispricingPct!=null && <p>{de?'Börsenkurs gegenüber Anbieterwert':'Market price relative to provider value'}: {c.marketMispricingPct>=0?'+':''}{c.marketMispricingPct.toFixed(1)}%</p>}
          <p className="text-secondary">{c.asOf ? `${de?'Bewertungsstand':'Valuation date'} ${c.asOf} · ` : ''}{c.status==='cooldown' ? (de?'Für diese Aktie noch nicht abgerufen':'No request made for this stock') : `${de?'Abgerufen':'Fetched'} ${new Date(c.fetchedAt).toLocaleString(locale)}`}{c.retryAt ? ` · ${de?'Nächster Versuch frühestens':'Next attempt no earlier than'} ${new Date(c.retryAt).toLocaleTimeString(locale)}` : ''}{c.reason && c.status!=='cooldown' ? ` · ${c.reason}` : ''}</p></div>;
      })}
    </div>
    {!!value.scenarios?.length && <details><summary className="cursor-pointer text-sm">{de?'Szenarien und Sensitivität (keine Zielpreisspanne)':'Scenarios and sensitivity (not a price-target range)'}</summary><div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">{value.scenarios.map(s=><div key={s.name} className="rounded-lg border p-3" style={{borderColor:'var(--border-glass)'}}><div className="text-xs uppercase text-secondary">{s.name === 'bear' ? 'Vorsichtig' : s.name === 'base' ? 'Basis' : 'Optimistisch'}</div><div className="font-semibold">{money(s.value)}</div><div className="text-xs text-secondary">Wachstum {(s.growth*100).toFixed(1)}% → {(s.terminal*100).toFixed(1)}% · Diskont {(s.discount*100).toFixed(1)}%</div></div>)}</div></details>}
    <details><summary className="cursor-pointer text-sm">Daten, Quellen und Modellabdeckung</summary>
      <div className="overflow-x-auto"><table className="w-full text-xs mt-2"><thead><tr><th className="text-left">Datenpunkt</th><th>Wert</th><th>Quelle / Abruf</th></tr></thead><tbody>
        {Object.entries(value.inputs).filter(([key])=>!['usdRiskModel','financialCompany'].includes(key)).map(([key, datum]) => <tr key={key}><td>{key}</td><td className="text-right">{/Growth|wacc|costEquity|taxRate|roe|roic|payoutRatio|dividendYield/.test(key) ? `${(datum.value*100).toFixed(2)}%` : compactNumber(datum.value,locale)}</td><td className="text-right"><a href={datum.source} target="_blank" rel="noreferrer" className="underline">Quelle</a> · {new Date(datum.fetchedAt).toLocaleDateString(locale)}</td></tr>)}
      </tbody></table></div>
      <ul className="text-xs space-y-1 mt-3">{value.models.map(m => <li key={m.name}>{m.name}: {m.value == null ? m.reason : money(m.value)}</li>)}</ul>
    </details>
    <details><summary className="cursor-pointer text-sm">Annahmen und Einschränkungen</summary><ul className="text-xs space-y-1 mt-2">{[...value.assumptions, ...value.warnings].map((s, i) => <li key={i}>{s}</li>)}</ul></details>
  </section>;
}
