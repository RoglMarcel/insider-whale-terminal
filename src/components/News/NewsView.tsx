import { displayText } from '@/lib/display-text';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useStore } from '@/store/useStore';
import { api } from '@/lib/ipc';
import { GlassCard } from '@/components/UI/GlassCard';
import { timeAgo, formatDateTime } from '@/lib/format';
import { RefreshIcon, ExternalLinkIcon, AlertIcon, NewsIcon } from '@/components/UI/icons';
import type { NewsItem } from '@/types';

export function NewsView() {
  const { t, language } = useI18n();
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const authStatus = useStore((s) => s.authStatus);
  const setView = useStore((s) => s.setView);
  const openSignal = useStore((s) => s.openSignal);
  const signals = useStore((s) => s.signals);

  const isTwitterLoggedIn = authStatus.twitter?.loggedIn;

  // Cross-reference a tweet's cashtags against live signals so congressional
  // activity surfaces in the feed (the news feed itself carries no politician
  // data — this is the only UI-side data path, purely additive).
  const politicianByTicker = useMemo(() => {
    const m = new Map<string, { count: number; mega: boolean }>();
    for (const s of signals) {
      if ((s.politicianScore ?? 0) <= 0) continue;
      const count = new Set((s.politicianTrades ?? []).map((t) => t.politician.toLowerCase())).size;
      if (count === 0) continue;
      m.set(s.ticker.toUpperCase(), { count, mega: s.breakdown?.politicianComboTier === 'MEGA_SIGNAL' });
    }
    return m;
  }, [signals]);

  const politicianForItem = (text: string): { count: number; mega: boolean } | null => {
    let best: { count: number; mega: boolean } | null = null;
    for (const m of text.matchAll(/\$([a-zA-Z0-9.\-]+)/g)) {
      const hit = politicianByTicker.get(m[1].toUpperCase());
      if (hit && (!best || hit.mega || hit.count > best.count)) best = hit;
    }
    return best;
  };

  const formatTweetText = (text: string) => {
    const parts = displayText(text).split(/(\$[a-zA-Z0-9\.\-]+)/g);
    return parts.map((part, index) => {
      if (part.startsWith('$') && part.length > 1) {
        const cleanTicker = part.replace('$', '').toUpperCase();
        return (
          <span
            key={index}
            onClick={(e) => {
              e.stopPropagation();
              openSignal(cleanTicker, true);
            }}
            className="mx-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-bold cursor-pointer hover:brightness-110 active:scale-95 transition-all duration-100"
            style={{
              color: 'var(--accent-yellow)',
              background: 'color-mix(in srgb, var(--accent-yellow) 12%, transparent)',
              border: '1px solid #FFC107',
              boxShadow: '0 0 8px rgba(255, 204, 0, 0.25)',
            }}
            title={`View ${cleanTicker} convictions & stats`}
          >
            {part.toUpperCase()}
          </span>
        );
      }
      return part;
    });
  };

  const loadNews = async () => {
    setLoading(true);
    try {
      const items = await api.news.getAll();
      setNews(items);
    } catch (err) {
      console.error('Failed to load news:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNews();
  }, []);

  const handleRefresh = () => {
    startTransition(() => {
      const run = async () => {
        try {
          await api.news.scrapeNow();
          await loadNews();
        } catch (err) {
          console.error('Failed to trigger manual scrape:', err);
        }
      };
      void run();
    });
  };

  return (
    <div className="animate-fade-in flex min-h-0 h-full flex-col gap-4">
      {/* Header bar */}
      {isTwitterLoggedIn && (
        <div className="flex shrink-0 justify-end">
          <button
            onClick={handleRefresh}
            disabled={loading || isPending}
            className="flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold hover:bg-white/15 disabled:opacity-50 transition-colors border border-white/5 active:scale-95 duration-100"
          >
            <RefreshIcon size={14} className={loading || isPending ? 'animate-spin' : ''} />
            Refresh News
          </button>
        </div>
      )}

      {/* Connection warning or feed — min-h-0 so flex child can scroll instead of squeeze */}
      {!isTwitterLoggedIn ? (
        <GlassCard className="flex flex-col items-center justify-center p-10 text-center gap-4 max-w-xl mx-auto my-10 border-dashed border-white/20">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent-yellow)]/10 text-[var(--accent-yellow)] border border-[var(--accent-yellow)]/20 animate-pulse">
            <AlertIcon size={28} />
          </div>
          <div>
            <h3 className="text-lg font-bold">{t('news.connectionRequired')}</h3>
            <p className="text-sm text-secondary mt-1 max-w-sm">
              {t('news.connectionHint')}
            </p>
          </div>
          <button
            onClick={() => setView('settings')}
            style={{ minHeight: 44 }}
            className="mt-2 rounded-xl bg-[var(--accent-blue)] px-6 text-sm font-bold text-white hover:bg-[var(--accent-blue)]/85 active:scale-95 transition-all shadow-[0_0_15px_color-mix(in_srgb,var(--accent-blue)_30%,transparent)]"
          >
            {t('news.goToSettings')}
          </button>
        </GlassCard>
      ) : loading && news.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-20 gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent-blue)] border-t-transparent" />
          <span className="text-xs text-secondary font-medium">{t('news.fetching')}</span>
        </div>
      ) : news.length === 0 ? (
        <GlassCard className="p-8 text-center text-secondary text-sm my-10 max-w-lg mx-auto">
          {t('news.empty')}
        </GlassCard>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-[min(100%,52rem)] flex-1 flex-col gap-4 overflow-y-auto pr-1">
          {news.map((item) => {
            const pol = politicianForItem(item.text);
            return (
            <GlassCard
              key={item.id}
              className="animate-fade-in relative flex w-full min-w-0 shrink-0 flex-col gap-3 p-5 group hover:border-[var(--accent-blue)]/20 transition-all duration-200"
              style={pol?.mega ? { borderColor: 'color-mix(in srgb, var(--accent-red) 55%, transparent)' } : undefined}
            >
              {/* Congressional cross-reference: this tweet cashtags a ticker with
                  active politician trading. MEGA gets a red left border + . */}
              {pol && (
                <div
                  className="absolute left-0 top-0 bottom-0 w-[3px]"
                  style={{ background: pol.mega ? 'var(--accent-red)' : 'var(--accent-purple)' }}
                />
              )}
              {pol && (
                <div
                  className={`inline-flex w-fit items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold ${pol.mega ? 'mega-signal-banner' : ''}`}
                  style={
                    pol.mega
                      ? { color: '#fff', background: 'var(--accent-red)' }
                      : { color: 'var(--accent-purple)', background: 'color-mix(in srgb, var(--accent-purple) 16%, transparent)' }
                  }
                  title={`${pol.count} member(s) of Congress trading a ticker mentioned here${pol.mega ? ' — MEGA SIGNAL' : ''}`}
                >
                  {pol.mega ? ' MEGA' : ` ${pol.count} politician${pol.count === 1 ? '' : 's'}`}
                </div>
              )}
              {/* Glowing vertical bar on hover */}
              <div className="absolute top-0 left-0 bottom-0 w-[3px] bg-[var(--accent-blue)] opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-white/10 border border-white/5 flex items-center justify-center font-extrabold text-sm text-[var(--accent-blue)] bg-gradient-to-br from-white/10 to-transparent">
                    <NewsIcon size={18} />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-extrabold">
                      Whale Insider
                      <svg 
                        viewBox="0 0 24 24" 
                        className="w-4 h-4 shrink-0 select-none"
                        style={{ 
                          display: 'inline-block', 
                          verticalAlign: 'middle',
                          filter: 'drop-shadow(0 0 3px rgba(255, 204, 0, 0.45))'
                        }}
                      >
                        <title>Verified</title>
                        <path 
                          d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.99-3.818-3.99-.48 0-.941.1-1.358.275C14.77 2.57 13.5 1.75 12 1.75s-2.77.82-3.412 2.035c-.417-.175-.878-.275-1.358-.275-2.108 0-3.818 1.78-3.818 3.99 0 .495.084.965.238 1.4-1.273.65-2.148 2.02-2.148 3.6 0 1.58.875 2.95 2.148 3.6-.154.435-.238.905-.238 1.4 0 2.21 1.71 3.99 3.818 3.99.48 0 .941-.1 1.358-.275C9.23 21.43 10.5 22.25 12 22.25s2.77-.82 3.412-2.035c.417.175.878.275 1.358.275 2.108 0 3.818-1.78 3.818-3.99 0-.495-.084-.965-.238-1.4 1.273-.65 2.148-2.02 2.148-3.6z" 
                          fill="var(--accent-blue)"
                          stroke="#ffcc00"
                          strokeWidth="1.5"
                        />
                        <path 
                          d="M9.78 16.64l-3.3-3.3 1.42-1.42 1.88 1.88 4.79-4.79 1.42 1.42-6.21 6.21z" 
                          fill="#ffffff" 
                        />
                      </svg>
                    </div>
                    <div className="text-[11px] text-secondary">@WhaleInsider</div>
                  </div>
                </div>
                
                <span
                  className="shrink-0 text-xs text-secondary font-medium select-none"
                  title={formatDateTime(item.timestamp, language)}
                >
                  {timeAgo(item.timestamp)}
                </span>
              </div>

              <p className="text-sm leading-relaxed break-words [overflow-wrap:anywhere] whitespace-pre-wrap font-medium">
                {formatTweetText(item.text)}
              </p>

              <div className="flex items-center justify-between border-t border-white/5 pt-2 mt-1">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-xs text-[var(--accent-blue)] hover:underline font-semibold"
                >
                  <ExternalLinkIcon size={12} />
                  View original post
                </a>
              </div>
            </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
