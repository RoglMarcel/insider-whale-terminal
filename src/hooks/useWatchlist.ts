import { useCallback } from 'react';
import { useStore } from '@/store/useStore';

export function useWatchlist() {
  const watchlist = useStore((s) => s.watchlist);
  const addWatch = useStore((s) => s.addWatch);
  const removeWatch = useStore((s) => s.removeWatch);

  const isWatched = useCallback(
    (ticker: string) => watchlist.some((w) => w.ticker === ticker.toUpperCase()),
    [watchlist],
  );

  const toggleWatch = useCallback(
    (ticker: string) => (isWatched(ticker) ? removeWatch(ticker) : addWatch(ticker)),
    [isWatched, removeWatch, addWatch],
  );

  return { watchlist, addWatch, removeWatch, isWatched, toggleWatch };
}
