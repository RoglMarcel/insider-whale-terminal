import { useAlertFairValue } from '@/hooks/useAlertFairValue';
import { useI18n } from '@/hooks/useI18n';
import { analysisMoney } from '@/lib/analysisFormat';
import { valuationComparison } from '@/lib/fairValueDisplay';
import type { FairValueResult } from '@/types/fairValue';

export function AlertFairValue({ticker, recorded}: {ticker: string; recorded?: FairValueResult}) {
  const { value, loading } = useAlertFairValue(ticker, recorded);
  const { language } = useI18n(); const de = language === 'de';
  const deviation = valuationComparison(value);
  const stale = !!value && Date.now() - Date.parse(value.calculatedAt) > 86_400_000;
  const label = deviation == null ? (loading ? (de?'Wird ermittelt …':'Loading …') : (de?'Daten fehlen':'Missing data'))
    : `${Math.abs(deviation).toFixed(1)}% ${de ? (deviation < -5 ? 'unter Fair Value' : deviation > 5 ? 'über Fair Value' : 'Abweichung') : (deviation < -5 ? 'below fair value' : deviation > 5 ? 'above fair value' : 'deviation')}`;
  return <div data-alert-fair-value className="rounded-lg border px-3 py-2 text-xs space-y-1" style={{borderColor:'var(--border-glass)'}}>
    <div className="flex flex-wrap justify-between gap-2"><strong>Fair Value {analysisMoney(value?.fairValue, value?.currency || 'USD', de?'de-DE':'en-US')}</strong><span>{de?'Stufe':'Level'} {value?.level ?? 1}</span></div>
    <div style={{color: stale || deviation == null ? 'var(--text-secondary)' : deviation < -5 ? 'var(--accent-green)' : deviation > 5 ? 'var(--accent-red)' : 'var(--accent-yellow)'}}>{label}{stale && (de?' · veraltet':' · stale')}{value?.status==='fallback' && (de?' · grobe Schätzung':' · rough estimate')}</div>
  </div>;
}
