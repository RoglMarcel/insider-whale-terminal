import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';
import { GlassCard } from '@/components/UI/GlassCard';
import { TrashIcon } from '@/components/UI/icons';
import {
  ALERT_CONDITION_LABELS,
  type AlertCondition,
  type AlertRule,
  type AlertScope,
} from '@/types';
import { api } from '@/lib/ipc';

/**
 * Custom alert rules manager — per-ticker / watchlist / global rules evaluated
 * after every scrape (crossing-style, so a rule fires when its condition
 * becomes true, not while it stays true).
 */
const SCOPE_LABELS: Record<AlertScope, TKey> = {
  ticker: 'alert.scopeTicker',
  watchlist: 'alert.scopeWatchlist',
  global: 'alert.scopeGlobal',
};

/** Condition labels live in src/types (shared with the main process); the UI
 *  maps them to translation keys here so the stored rule stays language-free. */
const CONDITION_KEYS: Record<AlertCondition, TKey> = {
  score_gte: 'alert.condScore',
  new_insider_buy: 'alert.condNewBuy',
  new_combo: 'alert.condNewCombo',
  cluster_gte: 'alert.condCluster',
};

const NEEDS_THRESHOLD: Record<AlertCondition, boolean> = {
  score_gte: true,
  cluster_gte: true,
  new_insider_buy: false,
  new_combo: false,
};

const DEFAULT_THRESHOLD: Record<AlertCondition, number> = {
  score_gte: 70,
  cluster_gte: 3,
  new_insider_buy: 0,
  new_combo: 0,
};

function describeRule(rule: AlertRule, t: (k: TKey, v?: Record<string, string | number>) => string): string {
  const scope =
    rule.scope === 'ticker'
      ? rule.ticker ?? '?'
      : rule.scope === 'watchlist'
        ? t('alert.scopeWatchlist')
        : t('alert.scopeGlobal');
  const cond = CONDITION_KEYS[rule.condition] ? t(CONDITION_KEYS[rule.condition]) : rule.condition;
  const th = NEEDS_THRESHOLD[rule.condition] && rule.threshold != null ? ` (≥ ${rule.threshold})` : '';
  return `${scope} — ${cond}${th}`;
}

export function AlertRules() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [scope, setScope] = useState<AlertScope>('watchlist');
  const [ticker, setTicker] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('new_insider_buy');
  const [threshold, setThreshold] = useState<number>(DEFAULT_THRESHOLD.new_insider_buy);

  useEffect(() => {
    let active = true;
    api.alerts
      .getRules()
      .then((r) => active && setRules(r))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const add = async () => {
    if (scope === 'ticker' && !ticker.trim()) return;
    const rule: AlertRule = {
      scope,
      ticker: scope === 'ticker' ? ticker.trim().toUpperCase() : null,
      condition,
      threshold: NEEDS_THRESHOLD[condition] ? threshold : null,
      enabled: true,
    };
    setRules(await api.alerts.addRule(rule));
    setTicker('');
  };

  const remove = async (id?: number) => {
    if (id == null) return;
    setRules(await api.alerts.removeRule(id));
  };

  const toggle = async (rule: AlertRule) => {
    if (rule.id == null) return;
    setRules(await api.alerts.toggleRule(rule.id, !rule.enabled));
  };

  const { t } = useI18n();
  const selectStyle = {
    background: 'var(--bg-glass)',
    border: '1px solid var(--border-glass)',
    color: 'var(--text-primary)',
  } as const;

  return (
    <GlassCard className="p-6">
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-secondary">{t('alert.title')}</h3>
      <p className="mb-3 text-xs text-secondary">
        {t('alert.intro')}
      </p>

      {/* Add-rule form */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as AlertScope)}
          className="rounded-lg px-2 py-1.5 text-sm"
          style={selectStyle}
        >
          {(Object.keys(SCOPE_LABELS) as AlertScope[]).map((s) => (
            <option key={s} value={s}>
              {t(SCOPE_LABELS[s])}
            </option>
          ))}
        </select>
        {scope === 'ticker' && (
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder={t('alert.tickerPlaceholder')}
            className="w-24 rounded-lg px-2 py-1.5 text-sm font-mono-terminal uppercase"
            style={selectStyle}
          />
        )}
        <select
          value={condition}
          onChange={(e) => {
            const c = e.target.value as AlertCondition;
            setCondition(c);
            setThreshold(DEFAULT_THRESHOLD[c]);
          }}
          className="rounded-lg px-2 py-1.5 text-sm"
          style={selectStyle}
        >
          {(Object.keys(CONDITION_KEYS) as AlertCondition[]).map((c) => (
            <option key={c} value={c}>
              {t(CONDITION_KEYS[c])}
            </option>
          ))}
        </select>
        {NEEDS_THRESHOLD[condition] && (
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value) || 0)}
            className="w-20 rounded-lg px-2 py-1.5 text-sm tabular-nums"
            style={selectStyle}
          />
        )}
        <button className="btn" onClick={() => void add()} disabled={scope === 'ticker' && !ticker.trim()}>
          {t('alert.addRule')}
        </button>
      </div>

      {/* Rule list */}
      {rules.length === 0 ? (
        <div className="py-3 text-sm text-secondary">{t('alert.none')}</div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border-glass)' }}>
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-sm" style={{ opacity: rule.enabled ? 1 : 0.5 }}>
                 {describeRule(rule, t)}
              </span>
              <div className="flex items-center gap-2">
                <button
                  role="switch"
                  aria-checked={rule.enabled}
                  onClick={() => void toggle(rule)}
                  className="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200"
                  style={{ background: rule.enabled ? 'var(--accent-green)' : 'var(--border-glass)' }}
                >
                  <span
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-200"
                    style={{ left: rule.enabled ? '1.375rem' : '0.125rem' }}
                  />
                </button>
                <button className="icon-btn" onClick={() => void remove(rule.id)} aria-label={t('alert.deleteRule')}>
                  <TrashIcon size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}
