import { useCallback } from 'react';
import { useStore } from '@/store/useStore';
import { translate, type Lang, type TKey } from '@/lib/i18n';

/**
 * UI translation. `t` is memoised on the active language, so a component that
 * passes it into a `useMemo`/`useCallback` dependency list re-renders on a
 * language switch and at no other time.
 */
export function useI18n(): {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  language: Lang;
  setLanguage: (lang: Lang) => void;
} {
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const t = useCallback(
    (key: TKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
  return { t, language, setLanguage };
}
