import { useAlertFairValue } from '@/hooks/useAlertFairValue';
import { useI18n } from '@/hooks/useI18n';
import { analysisMoney } from '@/lib/analysisFormat';
import { valuationComparison } from '@/lib/fairValueDisplay';
import { valuationQualityText } from '@/lib/valuationQualityText';
import type { FairValueResult } from '@/types/fairValue';

export function AlertFairValue({ticker, recorded}: {ticker: string; recorded?: FairValueResult}) {
  const { value, loading } = useAlertFairValue(ticker, recorded);
  const { language } = useI18n(); const de = language === 'de';
  const deviation = valuationComparison(value);
  const references = value?.externalComparisons?.filter(c=>c.status==='available') || [];
  const conflict = deviation!=null && Math.abs(deviation)>5 && references.some(c=>c.marketMispricingPct!=null && Math.abs(c.marketMispricingPct)>5 && Math.sign(c.marketMispricingPct)!==Math.sign(deviation));
  const stale = !!value && Date.now() - Date.parse(value.calculatedAt) > 86_400_000;
  const label = deviation == null ? (loading ? (de?'Wird ermittelt …':'Loading …') : (de?'Daten fehlen':'Missing data'))
    : `${Math.abs(deviation).toFixed(1)}% ${de ? (deviation < -5 ? 'unter Fair Value' : deviation > 5 ? 'über Fair Value' : 'Abweichung') : (deviation < -5 ? 'below fair value' : deviation > 5 ? 'above fair value' : 'deviation')}`;
  return <div data-alert-fair-value className="rounded-lg border px-3 py-2 text-xs space-y-1" style={{borderColor:'var(--border-glass)'}}>
    <div className="flex flex-wrap justify-between gap-2"><strong>Fair Value {analysisMoney(value?.fairValue, value?.currency || 'USD', de?'de-DE':'en-US')}</strong><span>{de?'Stufe':'Level'} {value?.level ?? 1}</span></div>
    <div style={{color: stale || deviation == null ? 'var(--text-secondary)' : deviation < -5 ? 'var(--accent-green)' : deviation > 5 ? 'var(--accent-red)' : 'var(--accent-yellow)'}}>{label}{stale && (de?' · veraltet':' · stale')}{value?.status==='fallback' && (de?' · grobe Schätzung':' · rough estimate')}</div>
    <div className="text-secondary">{de?'Börsenreferenzkurs':'Market reference price'} {analysisMoney(value?.price,value?.currency||'USD',de?'de-DE':'en-US')} · {value ? new Date(value.quote?.asOf || value.calculatedAt).toLocaleString(de?'de-DE':'en-US') : '—'}</div>
    {value && <div className="text-secondary">{value.qualityReasons?.map(s=>valuationQualityText(s,language)).join(' ')}{value.missingQualityInputs?.length ? ` · ${de?'Fehlt':'Missing'}: ${value.missingQualityInputs.map(s=>valuationQualityText(s,language)).join('; ')}` : ''}</div>}
    {value && recorded && (stale || value.calculatedAt!==recorded.calculatedAt || value.methodology!==recorded.methodology) && <div className="text-secondary">{de?'Gespeicherter Score verwendet die frühere Bewertung vom ':'Stored score uses the earlier valuation from '}{new Date(recorded.calculatedAt).toLocaleString(de?'de-DE':'en-US')} · ×{recorded.multiplier.toFixed(3)}</div>}
    {!!references.length && <div style={{color:conflict?'var(--accent-yellow)':'var(--text-secondary)'}}>{references.length} {de?'externe Vergleichswerte':'external reference values'}{conflict && (de?' · widersprüchliche Bewertungen':' · conflicting valuations')}</div>}
  </div>;
}
