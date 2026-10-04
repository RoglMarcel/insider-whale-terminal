import { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';
import { useStore } from '@/store/useStore';
import { GlassCard } from '@/components/UI/GlassCard';
import { CheckIcon } from '@/components/UI/icons';
import { LOGIN_PLATFORMS, type LoginPlatform } from '@/types';
import { isWeb } from '@/lib/ipc';

/** Category key -> translation key; the stored platform stays language-free. */
const CATEGORY_KEYS: Record<LoginPlatform['category'], TKey> = {
  options: 'login.catOptions',
  insider: 'login.catInsider',
  news: 'login.catNews',
};

function PlatformRow({ platform }: { platform: LoginPlatform }) {
  const authStatus = useStore((s) => s.authStatus);
  const startLogin = useStore((s) => s.startLogin);
  const saveLogin = useStore((s) => s.saveLogin);
  const cancelLogin = useStore((s) => s.cancelLogin);
  const logoutPlatform = useStore((s) => s.logoutPlatform);

  const loggedIn = !!authStatus[platform.key]?.loggedIn;
  const [phase, setPhase] = useState<'idle' | 'open' | 'busy'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const { t } = useI18n();

  const onLogin = async () => {
    setMsg(null);
    setPhase('busy');
    const res = await startLogin(platform.key);
    if (res.ok) {
      setPhase('open');
      setMsg('A browser window opened - sign in there, then click "Save session".');
    } else {
      setPhase('idle');
      setMsg(res.message || t('login.cannotOpen'));
    }
  };

  const onSave = async () => {
    setPhase('busy');
    setMsg(null);
    const res = await saveLogin(platform.key);
    if (res.ok) {
      setPhase('idle');
    } else {
      setPhase('open');
      setMsg(res.message || t('login.cannotSave'));
    }
  };

  const onCancel = async () => {
    await cancelLogin(platform.key);
    setPhase('idle');
    setMsg(null);
  };

  const onLogout = async () => {
    await logoutPlatform(platform.key);
    setMsg(null);
  };

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {platform.label}
            {platform.sourceKey && (
              <span
                className="rounded px-1.5 py-0.5 text-xs font-bold uppercase"
                style={{ color: 'var(--accent-yellow)', background: 'color-mix(in srgb, var(--accent-yellow) 16%, transparent)' }}
              >
                {t('login.requiredToScrape')}
              </span>
            )}
          </div>
          <div className="text-xs text-secondary">
            {t(CATEGORY_KEYS[platform.category] ?? 'login.catInsider')}
            {platform.hintKey ? ` - ${t(platform.hintKey as TKey)}` : ''}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isWeb ? (
            <span className="text-xs text-secondary">
              {loggedIn ? t('login.sessionActive') : t('login.desktopOnly')}
            </span>
          ) : loggedIn ? (
            <>
              <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: 'var(--accent-green)' }}>
                <CheckIcon size={14} /> Logged in
              </span>
              <button className="btn px-3 py-1.5 text-xs" onClick={onLogout}>
                Log out
              </button>
            </>
          ) : phase === 'open' ? (
            <>
              <button className="btn btn-primary px-3 py-1.5 text-xs" onClick={onSave}>
                Save session
              </button>
              <button className="btn px-3 py-1.5 text-xs" onClick={onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn px-3 py-1.5 text-xs" disabled={phase === 'busy'} onClick={onLogin}>
              {phase === 'busy' ? t('login.opening') : t('login.logIn')}
            </button>
          )}
        </div>
      </div>
      {msg && <div className="mt-1.5 text-xs text-secondary">{msg}</div>}
    </div>
  );
}

export function PlatformLogins() {
  const { t } = useI18n();
  return (
    <GlassCard className="p-6">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-secondary">{t('login.title')}</h3>
      {isWeb ? (
        <p className="mb-2 text-xs text-secondary">
          {t('login.webNote')}
        </p>
      ) : (
        <p className="mb-2 text-xs text-secondary">
          {t('login.desktopNote')}
        </p>
      )}
      <div className="divide-y" style={{ borderColor: 'var(--border-glass)' }}>
        {LOGIN_PLATFORMS.map((p) => (
          <PlatformRow key={p.key} platform={p} />
        ))}
      </div>
    </GlassCard>
  );
}
