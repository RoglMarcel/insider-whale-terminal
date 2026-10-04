import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { LANGUAGES, type Lang } from '@/lib/i18n';

/**
 * Language switch — sits where the light/dark toggle used to, to the right of
 * the VIX indicator. Two languages would fit a plain toggle, but a menu keeps
 * the current choice legible ("DE"/"EN" alone does not say which one is active)
 * and leaves room for a third language without a redesign.
 */
export function LanguageToggle() {
  const { t, language, setLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (lang: Lang) => {
    setLanguage(lang);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        style={{ minWidth: 44 }}
        onClick={() => setOpen((o) => !o)}
        title={t('header.switchLanguage')}
        aria-label={t('header.language')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="text-xs font-bold tracking-wide">{language.toUpperCase()}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-40 overflow-hidden rounded-xl shadow-lg"
          style={{
            background: 'var(--bg-elevated, var(--bg-card, #1a1a1e))',
            border: '1px solid var(--border-glass)',
          }}
        >
          {LANGUAGES.map((l) => {
            const active = l.key === language;
            return (
              <button
                key={l.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => pick(l.key)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-white/5"
                style={{
                  minHeight: 44,
                  color: active ? 'var(--accent-blue)' : 'var(--text-primary)',
                  fontWeight: active ? 700 : 500,
                }}
              >
                <span>{l.label}</span>
                <span className="text-xs tabular-nums text-secondary">{l.flag}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
