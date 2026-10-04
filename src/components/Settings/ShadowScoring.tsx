import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { GlassCard } from '@/components/UI/GlassCard';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from '@/types';
import { api } from '@/lib/ipc';

/**
 * Shadow scoring (A/B) — paste a partial ScoringConfig JSON to score every
 * future scrape under candidate weights IN PARALLEL with the live model
 * (persisted as shadow_score per signal). The live score is never affected.
 */
const KNOB_KEYS = Object.keys(DEFAULT_SCORING_CONFIG) as (keyof ScoringConfig)[];

export function ShadowScoring() {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.shadow
      .get()
      .then((cfg) => {
        if (!alive) return;
        setActive(!!cfg);
        setText(cfg ? JSON.stringify(cfg, null, 2) : '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setMessage(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      setMessage(t('shadow.invalidJson'));
      return;
    }
    const cfg: Partial<ScoringConfig> = {};
    for (const key of KNOB_KEYS) {
      const v = parsed[key];
      if (typeof v === 'number' && Number.isFinite(v)) cfg[key] = v;
    }
    if (Object.keys(cfg).length === 0) {
      setMessage(`No valid knobs found. Available: ${KNOB_KEYS.join(', ')}`);
      return;
    }
    const saved = await api.shadow.set(cfg);
    setActive(!!saved);
    setText(saved ? JSON.stringify(saved, null, 2) : '');
    setMessage(t('shadow.active'));
  };

  const clear = async () => {
    await api.shadow.set(null);
    setActive(false);
    setText('');
    setMessage(t('shadow.disabled'));
  };

  return (
    <GlassCard className="p-6">
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-secondary">
        Shadow Scoring (A/B) {active && <span style={{ color: 'var(--accent-green)' }}>· active</span>}
      </h3>
      <p className="mb-3 text-xs text-secondary">
        Candidate weights scored alongside the live model — never affecting it. Knobs (defaults):{' '}
        {KNOB_KEYS.map((k) => `${k}=${DEFAULT_SCORING_CONFIG[k]}`).join(', ')}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'{\n  "freshnessDecayRate": 0.155,\n  "comboBonus": 20\n}'}
        rows={5}
        spellCheck={false}
        className="mb-3 w-full rounded-lg px-3 py-2 font-mono-terminal text-xs"
        style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }}
      />
      <div className="flex items-center gap-2">
        <button className="btn" onClick={() => void save()} disabled={!text.trim()}>
          Save shadow config
        </button>
        <button className="btn" onClick={() => void clear()} disabled={!active}>
          Disable
        </button>
        {message && <span className="text-xs text-secondary">{message}</span>}
      </div>
    </GlassCard>
  );
}
