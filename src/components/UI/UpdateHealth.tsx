import { useEffect, useState } from 'react';
import { isWeb } from '@/lib/ipc';
import { useI18n } from '@/hooks/useI18n';

type Stage = { status: 'success' | 'partial' | 'failed' | 'skipped'; source?: string; reason?: string; affected?: number; quarantinedTickers?: string[]; tickers?: string[]; priceAsOf?: string; checkedAt?: string; lastSuccessAt?: string; lastUpdatedAt?: string };
type Health = { stages: Record<'signals' | 'portfolio' | 'outcomes', Stage> };
const names = ['signals', 'portfolio', 'outcomes'] as const;

export function UpdateHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const { t, language } = useI18n();
  useEffect(() => {
    if (!isWeb) return;
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}data/update-health.json`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (!names.every((name) => ['success', 'partial', 'failed', 'skipped'].includes(data?.stages?.[name]?.status))) throw new Error('Invalid status');
        setHealth(data);
      }).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!isWeb) return null;
  const stamp = (value?: string) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(language === 'de' ? 'de-DE' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  if (!health) return null;
  return <div className="data-timestamps">
    {(['signals', 'portfolio'] as const).map((name) => <span key={name}>
      {t(`updates.${name}`)} · {t('updates.updated')} {stamp(health.stages[name].lastUpdatedAt)}
    </span>)}
  </div>;
}
