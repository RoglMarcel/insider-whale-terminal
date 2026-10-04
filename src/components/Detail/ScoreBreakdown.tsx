import { localizeScoreNote } from '@/lib/signal-language';
import {
  type ScoreBreakdown as Breakdown,
  type InsiderFlowSummary,
  type EquityStatsSummary,
  type PoliticianTrade,
  type PoliticianComboTier,
  type RawInsiderTrade,
  classifyTransaction,
  daysBetween,
  MAX_INSIDER_TIMING_MULT,
  MAX_OPTIONS_SCORE_TOTAL,
  POLITICIAN_COMBO_SOFT_MULT,
  CORROBORATION_GATE,
  DEFAULT_SCORING_CONFIG,
} from '@/types';
import { freshnessMeta, ageLabel, formatUSD, formatCompact, confidenceColor, timeAgo, formatDate, partyMeta } from '@/lib/format';
import { useI18n } from '@/hooks/useI18n';

const TIER_COLOR: Record<PoliticianComboTier, string> = {
  MEGA_SIGNAL: 'var(--accent-red)',
  POLITICIAN_INSIDER: 'var(--accent-purple)',
  POLITICIAN_OPTIONS: 'var(--accent-blue)',
};

interface FactorRow {
  label: string;
  display: string;
  fill: number; // 0..1
  color: string;
}

/** Shared left-label / right-value row so every extra section matches the factors. */
function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-secondary">{label}</span>
      <span className="font-semibold tabular-nums text-right" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

/** One politician row: name (party·chamber·committee) — buy/sell · amount · age [disclosure]. */
function PoliticianRow({ t }: { t: PoliticianTrade }) {
  const { t: tr, language } = useI18n();
  const party = partyMeta(t.party);
  const isBuy = t.transactionType === 'buy';
  const chamber = language === 'de' ? t.chamber?.replace(/\bHouse\b/g, 'Repräsentantenhaus').replace(/\bSenate\b/g, 'Senat') : t.chamber;
  const ctx = [chamber, t.committee].filter(Boolean).join(' · ');
  const age = daysBetween(t.tradeDate);
  const lateDisclose = t.daysToDisclose != null && t.daysToDisclose > 30;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm">
      <div className="min-w-0">
        <span className="font-semibold">{t.politician || '—'}</span>{' '}
        <span className="text-xs text-secondary">
          (<span className={party.colorClass} style={{ color: party.color }}>{party.initial}</span> · {ctx || '—'})
        </span>
      </div>
      <div className="flex shrink-0 items-baseline gap-2 tabular-nums">
        <span className="font-semibold" style={{ color: isBuy ? 'var(--accent-green)' : 'var(--accent-red)' }}>
          {isBuy ? tr('common.buy') : tr('common.sell')} · {formatUSD(t.amountMidpoint)}
        </span>
        <span className="text-xs text-secondary" title={formatDate(t.tradeDate, language)}>
          {age == null ? '—' : timeAgo(t.tradeDate, language)}
        </span>
        <span
          className="text-xs"
          style={{ color: lateDisclose ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}
          title={t.daysToDisclose == null ? undefined : tr('bd.disclosedAfter', { n: t.daysToDisclose })}
        >
          {t.daysToDisclose == null ? '—' : lateDisclose
            ? tr('bd.disclosedLate', { n: t.daysToDisclose })
            : tr('bd.disclosedIn', { n: t.daysToDisclose })}
        </span>
      </div>
    </div>
  );
}

export function ScoreBreakdown({
  breakdown,
  insiderFlow,
  stats,
  politicianTrades,
  rawTrades,
}: {
  breakdown: Breakdown;
  insiderFlow?: InsiderFlowSummary | null;
  stats?: EquityStatsSummary | null;
  politicianTrades?: PoliticianTrade[] | null;
  rawTrades?: RawInsiderTrade[] | null;
}) {
  const b = breakdown;
  const { t, language } = useI18n();
  const fresh = freshnessMeta(b.signalAgeDays);
  const points = language === 'de' ? 'Punkte' : 'pts';

  // "No insider data" and "bad insider data" are different facts and must not
  // render the same. With zero scoring-eligible trades the insider leg is
  // undefined, not zero-rated — showing "0 / 10" and "× 0.00" read as a verdict
  // on the ticker when it was really an absence of input. Derived from the
  // trades themselves (via the shared classifier) so historical signals, whose
  // stored breakdowns predate this, render correctly too.
  const hasInsiderLeg = (rawTrades ?? []).some((t) => classifyTransaction(t.transactionType).modifier > 0);
  const NA = '—';

  const factors: FactorRow[] = [
    {
      label: t('bd.insiderRank'),
      display: hasInsiderLeg ? `${b.rankWeight} / 10` : NA,
      fill: hasInsiderLeg ? b.rankWeight / 10 : 0,
      color: 'var(--accent-blue)',
    },
    {
      label: t('bd.dollarVolume'),
      display: hasInsiderLeg ? `${b.dollarVolumePoints} / 20 ${points}` : NA,
      fill: hasInsiderLeg ? b.dollarVolumePoints / 20 : 0,
      color: 'var(--accent-blue)',
    },
    {
      label: t('bd.transactionQuality'),
      display: hasInsiderLeg ? `× ${b.typeModifier.toFixed(2)}` : NA,
      fill: hasInsiderLeg ? b.typeModifier : 0,
      color: 'var(--accent-purple)',
    },
    {
      label: t('bd.clusterBonus'),
      display: hasInsiderLeg ? `× ${b.clusterMultiplier.toFixed(1)}` : NA,
      fill: hasInsiderLeg ? b.clusterMultiplier / 3 : 0,
      color: 'var(--accent-purple)',
    },
    {
      label: t('bd.earningsTiming'),
      display: `× ${b.timingMultiplier.toFixed(2)}`,
      fill: b.timingMultiplier / MAX_INSIDER_TIMING_MULT,
      color: '#ff9f0a',
    },
    {
      label: t('bd.optionsFlow'),
      display: `${b.optionsScore >= 0 ? '+' : ''}${b.optionsScore.toFixed(0)} ${points}`,
      fill: Math.min(Math.abs(b.optionsScore) / MAX_OPTIONS_SCORE_TOTAL, 1),
      color: b.optionsScore < 0 ? 'var(--accent-red)' : 'var(--accent-green)',
    },
    {
      label: t('bd.signalAge'),
      display: `× ${b.freshnessMultiplier.toFixed(2)} · ${ageLabel(b.signalAgeDays, language)}`,
      fill: b.freshnessMultiplier,
      color: fresh.color,
    },
  ];

  // The options leg carries its OWN earnings-timing multiplier (up to ×2.0),
  // which was in the breakdown but never rendered — so a doubled options leg
  // appeared nowhere in the explanation of the score.
  if (b.optionsScore !== 0 && b.optionsTimingMultiplier !== 1) {
    factors.push({
      label: t('bd.optionsTiming'),
      display: `× ${b.optionsTimingMultiplier.toFixed(2)}`,
      fill: b.optionsTimingMultiplier / 2,
      color: '#ff9f0a',
    });
  }

  const insiderLegNote = hasInsiderLeg
    ? null
    : t('bd.noInsiderLeg');

  if (b.vixMultiplier > 1) {
    factors.push({ label: t('bd.vixBoost'), display: `× ${b.vixMultiplier.toFixed(2)}`, fill: 1, color: 'var(--accent-red)' });
  }
  if (b.trackRecordMultiplier !== 1) {
    factors.push({
      label: t('bd.trackRecord'),
      display: `× ${b.trackRecordMultiplier.toFixed(2)}`,
      fill: b.trackRecordMultiplier / 1.2,
      color: b.trackRecordMultiplier >= 1 ? 'var(--accent-green)' : 'var(--accent-red)',
    });
  }
  // When a politician tier is set, the tier row shows that bonus; comboBonus
  // already holds the effective total — avoid double-counting in the factor list.
  if (b.comboBonus > 0 && !b.politicianComboTier) {
    factors.push({ label: t('bd.comboBonus'), display: `+ ${b.comboBonus} ${points}`, fill: 1, color: 'var(--accent-blue)' });
  }

  const hasFlow = !!insiderFlow && (insiderFlow.buys > 0 || insiderFlow.sells > 0 || insiderFlow.form144 > 0);
  const net = insiderFlow ? insiderFlow.buys - insiderFlow.sells : 0;
  const hasStats =
    !!stats &&
    (stats.shortPctFloat != null || stats.floatShares != null || stats.avgDollarVolume != null || stats.pctFrom52wHigh != null);

  return (
    <section>
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">{t('bd.title')}</h3>
      <div className="flex flex-col gap-2.5">
        {factors.map((f) => (
          <div key={f.label} className="grid grid-cols-[8.5rem_1fr_8rem] items-center gap-3">
            <span className="text-sm font-medium">{f.label}</span>
            <div className="h-2.5 overflow-hidden rounded-full" style={{ background: 'var(--border-glass)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(Math.min(f.fill, 1), 0) * 100}%`,
                  background: f.color,
                  transition: 'width 0.7s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              />
            </div>
            <span className="text-right text-sm font-semibold tabular-nums">{f.display}</span>
          </div>
        ))}
      </div>

      {insiderLegNote && (
        <div className="mt-3 text-xs text-secondary">{insiderLegNote}</div>
      )}

      <div
        className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm"
        style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}
      >
        {/*
          Showing "raw / maxPossibleRaw" here implied a linear normalization that
          the model has not used since v1.0.46: at raw 170 that read as 6% of the
          ceiling while the actual score was 61.8. The score comes from a
          SATURATING curve, so the curve is what gets shown.
        */}
        <span className="text-secondary">
          {t('bd.raw')}{' '}
          <span className="font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {b.rawScore.toFixed(0)}
          </span>
          <span className="px-2">→</span>
          <span className="tabular-nums" title={t('bd.saturationTitle', { k: DEFAULT_SCORING_CONFIG.scoreHalfSaturation })}>
            {t('bd.saturation', { k: DEFAULT_SCORING_CONFIG.scoreHalfSaturation })}
          </span>
          <span className="px-2">→</span>
          {t('bd.final')}{' '}
          <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
            {b.normalizedScore.toFixed(1)}
          </span>
        </span>
        {b.confidence != null && (
          <span
            className="text-secondary"
            title={t('bd.confidenceTitle')}
          >
            {t('bd.confidence')}{' '}
            <span className="tabular-nums" style={{ color: confidenceColor(b.confidence) }}>
              {'●'.repeat(Math.max(1, Math.round(b.confidence / 25)))}
              {'○'.repeat(Math.max(0, 4 - Math.max(1, Math.round(b.confidence / 25))))}
            </span>{' '}
            {Math.round(b.confidence)}/100
          </span>
        )}
      </div>

      {/* Net insider flow — gross buys vs gross sells vs net (sell-side intel). */}
      {hasFlow && insiderFlow && (
        <div className="mt-4 rounded-xl px-4 py-3" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}>
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-secondary">{t('bd.netFlow90d')}</div>
          <div className="flex flex-col gap-1.5">
            <KV label={t('bd.grossBuys')} value={formatUSD(insiderFlow.buys)} color="var(--accent-green)" />
            <KV label={t('bd.grossSells')} value={insiderFlow.sells > 0 ? `-${formatUSD(insiderFlow.sells)}` : '—'} color={insiderFlow.sells > 0 ? 'var(--accent-red)' : undefined} />
            <KV
              label={t('bd.netFlow')}
              value={`${net >= 0 ? '+' : '−'}${formatUSD(Math.abs(net))}`}
              color={net > 0 ? 'var(--accent-green)' : net < 0 ? 'var(--accent-red)' : undefined}
            />
            {insiderFlow.form144 > 0 && <KV label={t('bd.form144Notices')} value={String(insiderFlow.form144)} color="var(--accent-yellow)" />}
          </div>
        </div>
      )}

      {/* Equity stats — short interest, float, liquidity, drawdown. */}
      {hasStats && stats && (
        <div className="mt-3 rounded-xl px-4 py-3" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}>
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-secondary">{t('bd.equityStats')}</div>
          <div className="flex flex-col gap-1.5">
            {stats.shortPctFloat != null && (
              <KV
                label={t('bd.shortInterest')}
                value={t('bd.floatPercent', { n: stats.shortPctFloat.toFixed(1) })}
                color={stats.shortPctFloat >= 20 ? '#ff9f0a' : undefined}
              />
            )}
            {stats.floatShares != null && <KV label={t('bd.float')} value={t('bd.floatShares', { n: formatCompact(stats.floatShares) })} />}
            {stats.avgDollarVolume != null && (
              <KV
                label={t('bd.avgDailyVol')}
                value={formatUSD(stats.avgDollarVolume)}
                color={stats.avgDollarVolume < 500_000 ? 'var(--accent-red)' : undefined}
              />
            )}
            {stats.pctFrom52wHigh != null && (
              <KV
                label={t('bd.from52wHigh')}
                value={`${Math.round(stats.pctFrom52wHigh)}%`}
                color={stats.pctFrom52wHigh <= -40 ? 'var(--accent-green)' : undefined}
              />
            )}
          </div>
        </div>
      )}

      {/* Congressional activity — only when trades exist. */}
      {politicianTrades && politicianTrades.length > 0 && (
        <div className="mt-3 rounded-xl px-4 py-3" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}>
          <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-secondary">
             {t('bd.politicianActivity')}
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border-glass)' }}>
            {politicianTrades.slice(0, 8).map((t, i) => (
              <PoliticianRow key={`${t.politician}-${t.tradeDate}-${i}`} t={t} />
            ))}
          </div>
          {politicianTrades.some((t) => t.transactionType === 'sell') && (
            <div className="mt-2 text-xs" style={{ color: 'var(--accent-red)' }}>
               {t('bd.contraSignal')}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-1.5 border-t pt-2.5" style={{ borderColor: 'var(--border-glass)' }}>
            <KV
              label={t('bd.politicianContribution')}
              value={`+${Math.round(b.politicianScore ?? 0)} ${points}`}
              color={(b.politicianScore ?? 0) > 0 ? 'var(--accent-purple)' : undefined}
            />
            {b.politicianComboTier && (
              /*
                The live model applies a SOFT MULTIPLIER, and only once the base
                score has reached the gate. This row used to print the legacy
                flat bonus (+45 / +25 / +20), which no longer exists in the live
                path — a MEGA signal read "+45 Bonus" while it had received
                ×1.25, or nothing at all when gated.
              */
              <KV
                label={t('bd.comboTier')}
                value={
                  `${t(b.politicianComboTier === 'MEGA_SIGNAL' ? 'badge.mega' : b.politicianComboTier === 'POLITICIAN_INSIDER' ? 'badge.polInsider' : 'badge.polOptions')}  (× ${POLITICIAN_COMBO_SOFT_MULT[b.politicianComboTier].toFixed(2)}` +
                  `${b.comboBonus > 0 ? '' : `, ${t('bd.gated', { gate: CORROBORATION_GATE })}`})`
                }
                color={TIER_COLOR[b.politicianComboTier]}
              />
            )}
          </div>
        </div>
      )}

      {b.notes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {b.notes.map((note, i) => (
            <span
              key={i}
              className="rounded-full px-2.5 py-1 text-xs"
              style={{
                background: 'color-mix(in srgb, var(--accent-blue) 12%, transparent)',
                color: 'var(--accent-blue)',
              }}
            >
              {localizeScoreNote(note, language)}
            </span>
          ))}
        </div>
      )}

      {/* Factors that returned their neutral value because an INPUT was missing.
          A x1.0 that means "no VIX reading" is a different statement from a
          x1.0 that means "the market is calm", and until now the two looked
          identical — which is how three factors sat at 0.0% of score variance
          without anyone being able to tell dormant from broken. */}
      {(b.dormantFactors?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          <span className="text-xs text-secondary">{t('bd.dormant')}</span>
          {b.dormantFactors!.map((d) => (
            <span
              key={d.factor}
              className="rounded-full px-2.5 py-1 text-xs text-secondary"
              style={{ border: '1px dashed var(--border-glass)' }}
              title={t(d.factor === 'valuationMultiplier' ? 'bd.noFairValue' : d.factor === 'vixMultiplier' ? 'bd.noVix' : 'bd.gateMissing')}
            >
              {t(d.factor === 'valuationMultiplier' ? 'bd.valuationFactor' : d.factor === 'vixMultiplier' ? 'bd.vixFactor' : 'bd.comboFactor')} — {t(d.factor === 'valuationMultiplier' ? 'bd.noFairValue' : d.factor === 'vixMultiplier' ? 'bd.noVix' : 'bd.gateMissing')}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
