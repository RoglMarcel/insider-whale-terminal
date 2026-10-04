import { useEffect, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useSwipeToDismiss } from '@/hooks/useSwipeToDismiss';

/**
 * Bottom sheet — the mobile counterpart to a centred dialog (DESIGN.md §7/§9).
 *
 * Deliberately dependency-free: backdrop, scroll lock, focus trap, Escape and
 * swipe-to-dismiss are a few dozen lines of CSS transforms and pointer events,
 * which is cheaper than pulling in an animation library for one interaction.
 *
 * Closes on: Escape, backdrop tap, drag-handle swipe past the threshold, and the
 * browser Back gesture (a history entry is pushed while open).
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  maxHeight = '92svh',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxHeight?: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const { offset: dragY, dragging, handlers, reset } = useSwipeToDismiss(onClose);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('button, input, select, [tabindex="0"]')?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [open]);

  // Escape + focus trap
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Body scroll lock — without this the list behind the sheet scrolls along.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Android/browser Back closes the sheet instead of leaving the page.
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ sheet: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (window.history.state?.sheet) window.history.back();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) reset();
    // `reset` is stable enough for this guard; re-running on every render would
    // cancel an in-flight drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="flex w-full flex-col overflow-hidden rounded-t-2xl sm:max-w-lg sm:rounded-2xl"
        style={{
          background: 'var(--bg-glass)',
          border: '1px solid var(--border-glass)',
          maxHeight,
          transform: `translateY(${dragY}px)`,
          transition: dragging ? 'none' : 'transform 280ms cubic-bezier(0.32,0.72,0,1)',
          paddingBottom: 'var(--sa-bottom)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle — also the swipe surface. */}
        <div
          className="flex shrink-0 cursor-grab touch-none flex-col items-center pb-1 pt-2.5"
          {...handlers}
        >
          <span className="h-1 w-10 rounded-full" style={{ background: 'var(--border-active)' }} />
        </div>

        {title && (
          <div
            className="flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-1"
            style={{ borderBottom: '1px solid var(--border-glass)' }}
          >
            <h2 id={titleId} className="min-w-0 flex-1 text-base font-bold">{title}</h2>
            <button type="button" className="icon-btn shrink-0" aria-label={t('common.close')} onClick={onClose}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" style={{ overscrollBehavior: 'contain' }}>
          {children}
        </div>

        {footer && (
          <div className="shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--border-glass)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
