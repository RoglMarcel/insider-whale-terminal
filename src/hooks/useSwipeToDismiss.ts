import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Swipe-down-to-dismiss for sheets.
 *
 * Extracted so the `Sheet` primitive and the (structurally different) signal
 * detail share one implementation of the gesture instead of two — unifying the
 * BEHAVIOUR without forcing the 500-line modal through Sheet's layout.
 *
 * Returns the live offset plus handlers to spread on the drag surface.
 */
export function useSwipeToDismiss(onDismiss: () => void, threshold = 120) {
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);

  const reset = () => {
    start.current = null;
    setOffset(0);
  };

  const handlers = {
    onPointerDown: (e: ReactPointerEvent) => {
      start.current = e.clientY;
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (start.current == null) return;
      // Downward only — an upward drag should not detach the sheet.
      setOffset(Math.max(0, e.clientY - start.current));
    },
    onPointerUp: () => {
      if (start.current == null) return;
      const passed = offset > threshold;
      reset();
      if (passed) onDismiss();
    },
    onPointerCancel: reset,
  };

  return { offset, dragging: start.current != null, handlers, reset };
}
