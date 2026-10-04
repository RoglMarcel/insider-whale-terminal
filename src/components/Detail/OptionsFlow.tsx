import type { OptionsActivity } from '@/types';
import { useI18n } from '@/hooks/useI18n';
import { formatUSD, formatNumber } from '@/lib/format';

function dteColor(dte: number): string {
  if (dte < 21) return 'var(--accent-red)';
  if (dte <= 60) return 'var(--accent-yellow)';
  return 'var(--accent-green)';
}

function VolVsOi({ volume, oi }: { volume?: number; oi?: number }) {
  const { t } = useI18n();
  if (!volume && !oi) return null;
  const max = Math.max(volume ?? 0, oi ?? 0, 1);
  const Bar = ({ label, value, color }: { label: string; value: number; color: string }) => (
    <div className="flex items-center gap-2">
      <span className="w-7 text-[10px] uppercase text-secondary">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--border-glass)' }}>
        <div className="h-full rounded-full" style={{ width: `${(value / max) * 100}%`, background: color }} />
      </div>
      <span className="w-12 text-right text-[10px] tabular-nums text-secondary">{formatNumber(value)}</span>
    </div>
  );
  return (
    <div className="mt-1 flex w-full flex-col gap-1 sm:w-56">
      <Bar label={t('opt.vol')} value={volume ?? 0} color="var(--accent-blue)" />
      <Bar label={t('opt.oi')} value={oi ?? 0} color="var(--accent-purple)" />
    </div>
  );
}

export function OptionsFlow({ options }: { options: OptionsActivity[] }) {
  const { t } = useI18n();
  if (!options || options.length === 0) return null;

  // The same sweep reported by two sources survives the merge (its key includes the
  // source), so collapse near-identical contracts here for display.
  const seen = new Set<string>();
  const unique = options.filter((o) => {
    const key = [
      o.type,
      o.sentiment,
      o.expiry ?? '',
      Math.round(o.strike ?? 0),
      Math.round((o.premiumTotal ?? o.notional ?? 0) / 1000),
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <section>
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">
        {t('opt.title', { n: unique.length })}
      </h3>
      <div className="flex flex-col gap-2">
        {unique.map((o, i) => {
          const color = o.sentiment === 'bullish' ? 'var(--accent-green)' : 'var(--accent-red)';
          return (
            <div
              key={i}
              className="rounded-xl px-4 py-3"
              style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}
            >
              <div className="flex flex-wrap items-center gap-2.5 text-sm">
                <span
                  className="rounded-md px-2 py-0.5 text-xs font-bold uppercase"
                  style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
                >
                  {t(o.type === 'call' ? 'card.calls' : 'card.puts')} · {t(o.sentiment === 'bullish' ? 'opt.bullish' : o.sentiment === 'bearish' ? 'opt.bearish' : 'opt.neutral')}
                </span>
                <span className="font-bold" style={{ color }}>
                  {formatUSD(o.premiumTotal ?? o.notional)}
                </span>
                {o.isSweep && (
                  <span
                    className="rounded-md px-2 py-0.5 text-xs font-bold"
                    style={{ color: 'var(--accent-blue)', background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)' }}
                  >
                    SWEEP
                  </span>
                )}
                {o.dte != null && (
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ color: dteColor(o.dte), background: `color-mix(in srgb, ${dteColor(o.dte)} 14%, transparent)` }}
                  >
                    {o.dte}DTE
                  </span>
                )}
                {o.strike != null && <span className="text-secondary">{t('opt.strike', { v: o.strike })}</span>}
                {o.otmPercent != null && (
                  <span className="text-secondary">
                    {Math.abs(o.otmPercent).toFixed(1)}% {o.otmPercent >= 0 ? t('opt.otm') : t('opt.itm')}
                  </span>
                )}
                {o.volOiRatio != null && (
                  <span className="text-secondary" title={t('opt.volOiTitle')}>
                    Vol/OI: {o.volOiRatio.toFixed(1)}x
                  </span>
                )}
                <span className="ml-auto text-xs uppercase tracking-wide text-secondary">{o.source}</span>
              </div>
              <VolVsOi volume={o.volume} oi={o.openInterest} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
