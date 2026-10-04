import { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { DEFAULT_PORTFOLIO_CONFIG, type PortfolioCashPolicy, type PortfolioConfig } from '@/types';
import type { TKey } from '@/lib/i18n';

/**
 * Runtime editor for the rule set.
 *
 * Changing any of these invalidates the whole curve — a chart drawn with a +20%
 * take-profit cannot be relabelled "+25%" — so applying triggers a full rebuild
 * on the main process and the form says so before it does it.
 *
 * Percentages are edited as PERCENTAGES (20, not 0.2). Asking someone to type
 * 0.2 for "20%" next to a card that reads "+20%" is how a stop-loss silently
 * becomes a 10× stop-loss.
 */

type Unit = 'raw' | 'pct' | 'bps';

interface Field {
  key: keyof PortfolioConfig;
  label: TKey;
  unit: Unit;
  step: number;
  min: number;
  max: number;
  /**
   * `true` for a barrier that can be switched OFF entirely (stored as `null`).
   * "Off" is not the same as "set to 999%": the shipped book runs with no
   * take-profit at all, and a disabled barrier must disappear from the rules
   * card rather than show a number nothing will ever reach.
   */
  optional?: boolean;
}

/** Prefilled when a switched-off barrier is switched back on. */
const BARRIER_FALLBACK: Record<string, number> = { takeProfit: 0.3, stopLoss: 0.25 };

const FIELDS: Field[] = [
  { key: 'startingCash', label: 'pf.rules.capital', unit: 'raw', step: 500, min: 100, max: 10_000_000 },
  { key: 'entryScore', label: 'pf.cfg.entryScore', unit: 'raw', step: 1, min: 0, max: 100 },
  { key: 'scoreSpan', label: 'pf.cfg.scoreSpan', unit: 'raw', step: 1, min: 1, max: 100 },
  { key: 'baseWeight', label: 'pf.cfg.baseWeight', unit: 'pct', step: 0.5, min: 0.1, max: 100 },
  { key: 'minWeight', label: 'pf.cfg.minWeight', unit: 'pct', step: 0.5, min: 0.1, max: 100 },
  { key: 'maxWeight', label: 'pf.cfg.maxWeight', unit: 'pct', step: 0.5, min: 0.1, max: 100 },
  { key: 'maxPositions', label: 'pf.cfg.maxPositions', unit: 'raw', step: 1, min: 1, max: 200 },
  { key: 'minTicket', label: 'pf.cfg.minTicket', unit: 'raw', step: 25, min: 1, max: 100_000 },
  { key: 'reentryCooldownDays', label: 'pf.cfg.cooldown', unit: 'raw', step: 1, min: 0, max: 365 },
  { key: 'takeProfit', label: 'pf.cfg.takeProfit', unit: 'pct', step: 1, min: 0.5, max: 500, optional: true },
  { key: 'stopLoss', label: 'pf.cfg.stopLoss', unit: 'pct', step: 1, min: 0.5, max: 99, optional: true },
  { key: 'maxHoldDays', label: 'pf.cfg.maxHoldDays', unit: 'raw', step: 5, min: 1, max: 3650 },
  { key: 'trailArm', label: 'pf.cfg.trailArm', unit: 'pct', step: 1, min: 0.5, max: 500 },
  { key: 'trailDistance', label: 'pf.cfg.trailDistance', unit: 'pct', step: 1, min: 0.5, max: 99 },
  { key: 'slippageBps', label: 'pf.cfg.slippage', unit: 'bps', step: 1, min: 0, max: 500 },
];

const toDisplay = (v: number, unit: Unit): number =>
  unit === 'pct' ? Math.round(v * 10_000) / 100 : v;
const toStored = (v: number, unit: Unit): number => (unit === 'pct' ? v / 100 : v);

const UNIT_SUFFIX: Record<Unit, string> = { raw: '', pct: '%', bps: 'bps' };

export function PortfolioConfigForm({
  config,
  busy,
  onApply,
  onCancel,
}: {
  config: PortfolioConfig;
  busy: boolean;
  onApply: (partial: Partial<PortfolioConfig>) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PortfolioConfig>(config);

  const set = (key: keyof PortfolioConfig, value: number | PortfolioCashPolicy | null) =>
    setDraft((d) => ({ ...d, [key]: value }));

  /**
   * Switching a barrier off keeps its last number in local state only, so
   * switching it straight back on does not silently install a default the user
   * never chose — and so `null` is what reaches the config.
   */
  const [parked, setParked] = useState<Record<string, number>>({});
  const toggle = (f: Field, on: boolean) => {
    const current = draft[f.key] as number | null;
    if (on) {
      set(f.key, parked[f.key] ?? BARRIER_FALLBACK[f.key] ?? toStored(f.min, f.unit));
    } else {
      if (current != null) setParked((m) => ({ ...m, [f.key]: current }));
      set(f.key, null);
    }
  };

  // The clamp order matters: min must not exceed max, and the base has to sit
  // between them, or every position silently lands on a boundary.
  const invalid =
    draft.minWeight > draft.maxWeight ||
    draft.baseWeight > draft.maxWeight ||
    draft.baseWeight < draft.minWeight;

  return (
    <div className="mt-4 rounded-xl p-3" style={{ border: '1px solid var(--border-glass)' }}>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => {
          const raw = draft[f.key] as number | null;
          const off = f.optional && raw == null;
          return (
            <label key={f.key} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-secondary">{t(f.label)}</span>
              <span className="flex shrink-0 items-center gap-1">
                {f.optional && (
                  <input
                    type="checkbox"
                    className="mr-1"
                    checked={!off}
                    disabled={busy}
                    aria-label={t(off ? 'pf.cfg.barrierOff' : 'pf.cfg.barrierOn')}
                    title={t(off ? 'pf.cfg.barrierOff' : 'pf.cfg.barrierOn')}
                    onChange={(e) => toggle(f, e.target.checked)}
                  />
                )}
                {off ? (
                  <span className="w-24 px-2 py-1 text-right text-xs text-secondary">{t('pf.cfg.barrierOff')}</span>
                ) : (
                  <input
                    type="number"
                    className="input w-24 px-2 py-1 text-right text-xs tabular-nums"
                    value={toDisplay(raw ?? 0, f.unit)}
                    step={f.step}
                    min={f.min}
                    max={f.max}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) set(f.key, toStored(n, f.unit));
                    }}
                  />
                )}
                <span className="w-7 text-secondary">{off ? '' : UNIT_SUFFIX[f.unit]}</span>
              </span>
            </label>
          );
        })}

        <label className="flex items-center justify-between gap-2 text-xs">
          <span className="text-secondary">{t('pf.rules.cash')}</span>
          <select
            className="input w-[7.75rem] px-2 py-1 text-xs"
            value={draft.cashPolicy}
            disabled={busy}
            onChange={(e) => set('cashPolicy', e.target.value as PortfolioCashPolicy)}
          >
            <option value="spy">{t('pf.cfg.cashSpy')}</option>
            <option value="idle">{t('pf.cfg.cashIdle')}</option>
          </select>
        </label>
      </div>

      <p className="mt-3 text-[11px] leading-snug text-secondary">{t('pf.cfg.rebuildWarning')}</p>
      {invalid && (
        <p className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--accent-red)' }}>
          {t('pf.cfg.invalidWeights')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy || invalid} onClick={() => onApply(draft)}>
          {busy ? t('pf.cfg.applying') : t('pf.cfg.apply')}
        </button>
        <button className="btn" disabled={busy} onClick={() => setDraft(DEFAULT_PORTFOLIO_CONFIG)}>
          {t('pf.cfg.reset')}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          {t('pf.cfg.cancel')}
        </button>
      </div>
    </div>
  );
}
