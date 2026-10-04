import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/ipc';
import { useStore } from '@/store/useStore';
import { useI18n } from '@/hooks/useI18n';
import { normalizeAnalysisTicker, type StockAnalysis, type StockSuggestion } from '@/types/analysis';
import { analysisMoney } from '@/lib/analysisFormat';
import { FairValuePanel } from '@/components/Detail/FairValuePanel';

export function AnalysisView() {
  const { language } = useI18n();
  const de = language === 'de';
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<StockAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<StockSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const signals = useStore(s => s.signals);
  const openSignal = useStore(s => s.openSignal);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('analysis.recent') || '[]');
      if (Array.isArray(saved)) setRecent(saved.filter((x): x is string => typeof x === 'string' && /^[A-Z][A-Z0-9.-]{0,11}$/.test(x)).slice(0, 6));
    } catch { /* storage is optional */ }
    return () => { request.current++; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setActive(-1);
    setSuggestions([]);
    if (!focused || !query.trim()) { setSearching(false); return; }
    setSearching(true); setSearchError(false);
    const timer = setTimeout(() => {
      api.analysis.search(query).then(rows => { if (!cancelled) setSuggestions(rows); })
        .catch(() => { if (!cancelled) setSearchError(true); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, focused]);

  async function analyze(input: string) {
    setFocused(false);
    const id = ++request.current;
    setError('');
    setResult(null);
    let ticker: string;
    try { ticker = normalizeAnalysisTicker(input); }
    catch { setLoading(false); setError(de ? 'Bitte ein gültiges Börsenkürzel eingeben, z. B. AAPL.' : 'Enter a valid stock ticker, for example AAPL.'); return; }
    setQuery(ticker);
    setLoading(true);
    try {
      const next = await api.analysis.analyze(ticker);
      if (request.current !== id) return;
      setResult(next);
      setRecent(previous => {
        const updated = [ticker, ...previous.filter(t => t !== ticker)].slice(0, 6);
        try { localStorage.setItem('analysis.recent', JSON.stringify(updated)); } catch { /* optional */ }
        return updated;
      });
    } catch {
      if (request.current === id) setError(de ? 'Für diese Notierung ist noch keine Analyse abrufbar. Wähle einen Suchvorschlag oder versuche es nach der nächsten geplanten Aktualisierung erneut.' : 'No analysis is available for this listing yet. Select a search suggestion or try again after the next scheduled update.');
    } finally { if (request.current === id) setLoading(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void analyze(active >= 0 && focused ? suggestions[active].ticker : suggestions.find(s=>s.name.toLowerCase() === query.trim().toLowerCase())?.ticker || query); }
  const fv = result?.valuation;
  const stale = !!fv && Date.now() - Date.parse(fv.calculatedAt) > 24 * 60 * 60 * 1000;
  const limited = !fv || fv.status === 'unavailable' || fv.price == null || stale;
  const attractive = !limited && fv.recommendation === 'undervalued';
  const expensive = !limited && fv.recommendation === 'overvalued';
  const color = limited ? 'var(--text-secondary)' : attractive ? 'var(--accent-green)' : expensive ? 'var(--accent-red)' : 'var(--accent-yellow)';
  const label = limited ? (de ? 'Keine belastbare Einordnung' : 'Insufficient evidence') : attractive ? (de ? 'Günstig im Modell' : 'Below model value') : expensive ? (de ? 'Teuer im Modell' : 'Above model value') : (de ? 'Im Bewertungsbereich / beobachten' : 'Within valuation range / watch');
  const money = (n: number | null | undefined) => analysisMoney(n, fv?.currency || 'USD', de ? 'de-DE' : 'en-US', true);
  const input = (key: string) => fv?.inputs[key]?.value;
  const matchingSignal = result ? signals.find(s => s.ticker === result.ticker) : null;
  const cashflow = input('fcf');
  const eps = input('eps');
  const debt = input('debt');
  const cash = input('cash');
  const title = de ? 'Deine Aktie. Deine Analyse.' : 'Your stock. Your analysis.';

  return <div className="mx-auto max-w-5xl space-y-6 pb-6">
    <section className="glass rounded-2xl p-5 sm:p-8">
      <div className="text-xs font-semibold uppercase tracking-widest text-secondary">{de ? 'Analyse · Fundamentale Bewertung' : 'Analysis · Fundamental valuation'}</div>
      <h2 className="mt-2 text-2xl sm:text-3xl font-bold">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm text-secondary">{de ? 'Gib ein Börsenkürzel ein und prüfe Fair Value, Ertragskraft und Kaufattraktivität. Unabhängig davon, ob bereits ein Insider-Alert vorliegt.' : 'Enter a ticker to examine fair value, earnings and valuation appeal, even without an existing insider alert.'}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1"><label htmlFor="analysis-ticker" className="mb-1 block text-xs text-secondary">{de ? 'Unternehmen oder Börsenkürzel · Börsen weltweit' : 'Company name or ticker · Global exchanges'}</label>
          <input id="analysis-ticker" role="combobox" aria-expanded={focused && suggestions.length > 0} aria-controls="analysis-suggestions" aria-autocomplete="list" aria-activedescendant={focused && active >= 0 ? `analysis-option-${active}` : undefined} value={query} onFocus={()=>setFocused(true)} onBlur={e=>{ if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('form'))) setFocused(false); }} onChange={e => { setQuery(e.target.value); setFocused(true); }} onKeyDown={e=>{
            if(e.key==='Escape')setFocused(false);
            if(e.key==='ArrowDown' || e.key==='ArrowUp'){e.preventDefault();setFocused(true);setActive(i=>suggestions.length ? (i+(e.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length : -1);}
          }} maxLength={80} autoComplete="off" spellCheck={false} placeholder="Apple, NVIDIA, SAP, 7203.T …" className="w-full rounded-xl border px-4 py-3 text-base" style={{ background: 'var(--bg-glass)', borderColor: 'var(--border-glass)' }} />
          {focused && query.trim() && <div className="sm:absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border shadow-xl" style={{ background: 'var(--bg-primary, #111318)', borderColor: 'var(--border-glass)' }}>
            {searching && <p className="p-3 text-sm text-secondary" role="status">{de?'Suche …':'Searching …'}</p>}
            {!searching && !suggestions.length && <p className="p-3 text-sm text-secondary">{searchError ? (de?'Suchkatalog derzeit nicht erreichbar.':'Search catalogue currently unavailable.') : (de?'Keine passende Notierung im Katalog.':'No matching listing in the catalogue.')}</p>}
            <ul id="analysis-suggestions" role="listbox">{suggestions.map((s,i)=><li key={s.ticker} id={`analysis-option-${i}`} role="option" aria-selected={active===i} onMouseDown={e=>e.preventDefault()} onClick={()=>void analyze(s.ticker)} className="cursor-pointer px-4 py-3 text-sm hover:bg-white/10" style={active===i?{background:'rgba(255,255,255,.1)'}:undefined}><div className="flex justify-between gap-2"><strong>{s.ticker}</strong><span className="text-xs text-secondary">{s.exchange}</span></div><div className="truncate text-secondary">{s.name}</div></li>)}</ul>
          </div>}
        </div>
        <button type="submit" disabled={loading || !query.trim()} className="self-end w-full sm:w-auto rounded-xl px-6 py-3 font-semibold disabled:opacity-50" style={{ background: 'var(--accent-blue)', color: '#fff' }}>{loading ? (de ? 'Wird analysiert …' : 'Analyzing …') : (de ? 'Aktie analysieren' : 'Analyze stock')}</button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">{(recent.length ? recent : ['AAPL', 'MSFT', 'NVDA']).map(ticker => <button key={ticker} type="button" disabled={loading} onClick={() => void analyze(ticker)} className="rounded-full border px-3 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-glass)' }}>{ticker}</button>)}</div>
    </section>
    {loading && <div role="status" className="glass rounded-xl p-6 text-sm animate-pulse">{de ? 'Fundamentaldaten abrufen und Bewertungsmodelle prüfen. Das dauert gewöhnlich einige Sekunden …' : 'Fetching fundamentals and checking valuation models. This usually takes a few seconds …'}</div>}
    {error && <div role="alert" className="glass rounded-xl p-5"><p>{error}</p><button className="mt-3 underline" onClick={() => void analyze(query)}>{de ? 'Erneut versuchen' : 'Retry'}</button></div>}
    {result && fv && <div aria-live="polite" className="space-y-5">
      {result.origin !== 'live' && <p role="status" className="rounded-xl border border-amber-500/40 p-3 text-sm">{de ? 'Geplant aktualisierte Analyse vom ' : 'Scheduled analysis updated '}{new Date(fv.calculatedAt).toLocaleString()}{stale && (de ? ' – veraltet, keine aktuelle Kauf-Einordnung.' : ' — stale, no current purchase assessment.')}</p>}
      <section className="glass rounded-2xl p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-bold">{result.ticker}</h2><span className="rounded-full border px-3 py-1 text-sm font-semibold" style={{ color, borderColor: color }}>{label}</span></div>
        {fv.quote && <p className="mt-2 text-xs text-secondary">{fv.quote.name} · {fv.quote.exchange} · {fv.currency}<br/>{de?'Letzter regulärer Börsenkurs: ':'Last regular-session quote: '}{new Date(fv.quote.asOf).toLocaleString()} · {de?'kann verzögert sein':'may be delayed'}</p>}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-5">
          {[ [de ? 'Referenzkurs' : 'Reference price', money(fv.price)], ['Fair Value', `${money(fv.low)} – ${money(fv.high)}`], [de ? 'Einstieg mit Sicherheitsmarge' : 'Entry with safety margin', money(fv.entryPrice)] ].map(([name, val]) => <div key={name}><div className="text-xs text-secondary">{name}</div><div className="mt-1 text-lg font-semibold">{val}</div></div>)}
        </div>
        <h3 className="mt-6 font-semibold">{de ? 'Ist die Aktie kaufenswert?' : 'Is the valuation attractive?'}</h3>
        <p className="mt-2 text-sm leading-relaxed text-secondary">{limited
          ? (de ? 'Für eine aktuelle Kauf-Einordnung fehlen belastbare Daten. Fehlende Werte werden nicht als günstige Bewertung ausgelegt.' : 'There is insufficient current evidence for a purchase assessment. Missing data does not imply a bargain.')
          : attractive
            ? (de ? 'Der Referenzkurs liegt unter der konservativen Einstiegsschwelle. Das macht die Aktie aus Bewertungssicht zu einem Prüfkandidaten. ' : 'The reference price is below the conservative entry threshold, making it a candidate for further research. ')
            : expensive
              ? (de ? 'Der Referenzkurs liegt über dem Modellkorridor. Die Bewertung spricht derzeit gegen einen Einstieg ohne zusätzliche Wachstumsargumente.' : 'The reference price is above the model range. Valuation does not currently support an entry without additional growth evidence.')
              : (de ? 'Die geforderte Sicherheitsmarge ist noch nicht erreicht. Aus diesem Modell ergibt sich derzeit kein klarer günstiger Einstieg.' : 'The required margin of safety has not been met. This model does not currently indicate a clearly attractive entry.')}
          {!limited && fv.level <= 2 && (de ? ' Die Datenbasis ist begrenzt; die Einschätzung hat geringe Verlässlichkeit.' : ' Evidence is limited; this assessment has low confidence.')}
        </p>
        <p className="mt-2 text-xs text-secondary">{de ? 'Die Einordnung bewertet den Preis unter den gezeigten Annahmen. Geschäftsqualität, Wettbewerbsposition und persönliche Anlageziele sind damit nicht vollständig geprüft.' : 'This assessment evaluates price under the stated assumptions. Business quality, competitive position and personal investment objectives are not fully assessed.'}</p>
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="glass rounded-xl p-5"><h3 className="font-semibold">{de ? 'Ertragskraft & Cashflow' : 'Earnings & cash flow'}</h3><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between"><dt>EPS (TTM)</dt><dd>{money(eps)}</dd></div><div className="flex justify-between"><dt>Free Cash Flow</dt><dd>{money(cashflow)}</dd></div><div className="flex justify-between"><dt>{de ? 'Dividende je Aktie' : 'Dividend per share'}</dt><dd>{money(input('dividend'))}</dd></div></dl>
          <p className="mt-3 text-xs text-secondary">{eps == null ? (de ? 'Gewinndaten fehlen.' : 'Earnings unavailable.') : eps > 0 ? (de ? 'Zuletzt positiver Gewinn je Aktie.' : 'Positive trailing earnings per share.') : (de ? 'Kein positiver Gewinn – gewinnbasierte Fallbacks sind ungeeignet.' : 'No positive earnings — earnings-based fallbacks are unsuitable.')} {cashflow != null && cashflow < 0 && (de ? 'Negativer freier Cashflow ist ein Risikofaktor.' : 'Negative free cash flow is a risk factor.')}</p>
        </section>
        <section className="glass rounded-xl p-5"><h3 className="font-semibold">{de ? 'Bilanz & Erwartungen' : 'Balance sheet & expectations'}</h3><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between"><dt>{de ? 'Schulden' : 'Debt'}</dt><dd>{money(debt)}</dd></div><div className="flex justify-between"><dt>{de ? 'Liquide Mittel & Wertpapiere' : 'Cash & securities'}</dt><dd>{money(cash)}</dd></div><div className="flex justify-between"><dt>{de ? 'Analysten-Kursziel' : 'Analyst price target'}</dt><dd>{money(input('analystTarget'))}</dd></div></dl><p className="mt-3 text-xs text-secondary">{de ? 'Analystenziele sind Erwartungen, kein berechneter Fair Value. Schulden werden gemeinsam mit Cashflow und Fälligkeiten beurteilt.' : 'Analyst targets are expectations, not computed fair value. Debt requires context from cash flows and maturities.'}</p></section>
      </div>
      <FairValuePanel value={fv} />
      <section className="glass rounded-xl p-5"><h3 className="font-semibold">{de ? 'Insider-Kontext' : 'Insider context'}</h3>{matchingSignal ? <><p className="mt-2 text-sm text-secondary">{de ? 'Vorhandener Alert-Score' : 'Existing alert score'}: {matchingSignal.score.toFixed(0)} · {new Date(matchingSignal.scrapedAt).toLocaleString()}</p><button className="mt-3 underline text-sm" onClick={() => openSignal(result.ticker)}>{de ? 'Alert und Transaktionen öffnen' : 'Open alert and transactions'}</button></> : <p className="mt-2 text-sm text-secondary">{de ? 'Kein Alert im aktuellen Datenbestand. Das ist keine Aussage darüber, ob Insider aktiv waren.' : 'No alert in the current dataset. This does not establish whether insiders were active.'}</p>}</section>
    </div>}
  </div>;
}
