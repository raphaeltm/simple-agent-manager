/**
 * Pointer-driven snap behaviour for the variant B bottom sheet.
 *
 * Translate space, not height space: the sheet is always rendered at its FULL
 * height and pushed down by `translateY`. Animating a transform keeps the
 * gesture on the compositor and — more importantly here — means the body's
 * scroll height never changes between snaps, so scroll position survives a
 * collapse/expand.
 *
 *   translate 0            → FULL
 *   translate full - peek  → PEEK
 *   translate full         → dismissed
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type SheetSnap = 'peek' | 'full';

/** Fraction of the viewport the sheet occupies at PEEK. */
export const PEEK_RATIO = 0.52;
/** Gap left above the sheet at FULL, before the safe-area inset. */
export const FULL_TOP_GAP_PX = 12;
export const SNAP_TRANSITION_MS = 200;
/** Past this, a flick decides the snap regardless of position. */
const FLICK_VELOCITY_PX_PER_MS = 0.5;
/** Vertical movement under this is a tap, not a drag. */
const TAP_SLOP_PX = 4;

interface DragState {
  pointerId: number;
  startY: number;
  startTranslate: number;
  lastY: number;
  lastT: number;
  velocity: number;
  /**
   * Set when the drag started on the scrollable body at FULL. An upward move
   * there means "scroll the content", so the drag aborts and hands the gesture
   * back to the browser instead of fighting native scrolling.
   */
  downOnly: boolean;
  /** Snap the gesture started from — a flick moves ONE step from there. */
  startSnap: SheetSnap;
}

export interface SheetDrag {
  /** Current transform offset in px. */
  translate: number;
  /** False until the sheet has been measured, so the first paint can be hidden. */
  ready: boolean;
  snap: SheetSnap;
  dragging: boolean;
  /** Full sheet height in px, measured from the rendered element. */
  fullHeight: number;
  peekHeight: number;
  setSheetEl: (el: HTMLElement | null) => void;
  /**
   * True when the last gesture actually moved. A pointer drag still emits a
   * `click` on release, so the tap-to-toggle handler must be able to tell a tap
   * from the tail of a drag — without this the drag snapped to FULL and the
   * synthesized click immediately toggled it back to PEEK.
   */
  dragMoved: React.MutableRefObject<boolean>;
  snapTo: (snap: SheetSnap) => void;
  /** Attach to any element that should be able to drag the sheet. */
  onPointerDown: (event: React.PointerEvent, options?: { downOnly?: boolean }) => void;
}

export function useSheetDrag(onDismiss: () => void): SheetDrag {
  const [fullHeight, setFullHeight] = useState(0);
  const [peekHeight, setPeekHeight] = useState(0);
  const [snap, setSnap] = useState<SheetSnap>('peek');
  const [translate, setTranslate] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  const sheetEl = useRef<HTMLElement | null>(null);
  const dragMoved = useRef(false);

  const measure = useCallback((el: HTMLElement) => {
    const full = el.offsetHeight;
    const peek = Math.round(window.innerHeight * PEEK_RATIO);
    setFullHeight(full);
    setPeekHeight(peek);
    return { full, peek };
  }, []);

  const setSheetEl = useCallback(
    (el: HTMLElement | null) => {
      sheetEl.current = el;
      if (!el) return;
      const { full, peek } = measure(el);
      // Opens at PEEK.
      setTranslate((current) => current ?? full - peek);
    },
    [measure]
  );

  useEffect(() => {
    const onResize = () => {
      const el = sheetEl.current;
      if (!el) return;
      const { full, peek } = measure(el);
      setTranslate(snap === 'full' ? 0 : full - peek);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure, snap]);

  const snapTo = useCallback(
    (next: SheetSnap) => {
      setSnap(next);
      setTranslate(next === 'full' ? 0 : fullHeight - peekHeight);
    },
    [fullHeight, peekHeight]
  );

  const finish = useCallback(
    (offset: number, velocity: number, startSnap: SheetSnap) => {
      const peekOffset = fullHeight - peekHeight;
      /*
       * A flick moves exactly ONE snap in its direction, from wherever the
       * gesture started. Deciding by distance instead made a fast downward
       * flick out of FULL skip PEEK entirely and dismiss the sheet — a gesture
       * users make to "get back to the summary", not to close.
       */
      if (velocity > FLICK_VELOCITY_PX_PER_MS) {
        if (startSnap === 'full') snapTo('peek');
        else onDismiss();
        return;
      }
      if (velocity < -FLICK_VELOCITY_PX_PER_MS) {
        snapTo('full');
        return;
      }
      const candidates: Array<{ snap: SheetSnap | 'dismiss'; offset: number }> = [
        { snap: 'full', offset: 0 },
        { snap: 'peek', offset: peekOffset },
        { snap: 'dismiss', offset: fullHeight },
      ];
      const nearest = candidates.reduce((best, item) =>
        Math.abs(item.offset - offset) < Math.abs(best.offset - offset) ? item : best
      );
      if (nearest.snap === 'dismiss') {
        onDismiss();
        return;
      }
      snapTo(nearest.snap);
    },
    [fullHeight, onDismiss, peekHeight, snapTo]
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.downOnly && event.clientY < state.startY) {
        drag.current = null;
        setDragging(false);
        return;
      }
      if (Math.abs(event.clientY - state.startY) > TAP_SLOP_PX) dragMoved.current = true;
      const now = performance.now();
      const dt = Math.max(1, now - state.lastT);
      state.velocity = (event.clientY - state.lastY) / dt;
      state.lastY = event.clientY;
      state.lastT = now;
      const next = state.startTranslate + (event.clientY - state.startY);
      setTranslate(Math.max(0, Math.min(fullHeight, next)));
    };

    const onUp = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const offset = Math.max(
        0,
        Math.min(fullHeight, state.startTranslate + (event.clientY - state.startY))
      );
      drag.current = null;
      setDragging(false);
      finish(offset, state.velocity, state.startSnap);
    };

    /*
     * A cancelled gesture is one the user never completed, so it must not be
     * settled by position: iOS Safari readily claims a pointer that started on
     * a scrollable body, and running `finish()` with the partial offset there
     * could dismiss the sheet from a drag the user never released. Revert to
     * wherever the gesture started instead.
     */
    const onCancel = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      drag.current = null;
      setDragging(false);
      snapTo(state.startSnap);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [dragging, finish, fullHeight, snapTo]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent, options: { downOnly?: boolean } = {}) => {
      if (translate === null) return;
      drag.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startTranslate: translate,
        lastY: event.clientY,
        lastT: performance.now(),
        velocity: 0,
        downOnly: options.downOnly ?? false,
        startSnap: snap,
      };
      dragMoved.current = false;
      setDragging(true);
    },
    [snap, translate]
  );

  return {
    translate: translate ?? 0,
    ready: translate !== null,
    snap,
    dragging,
    fullHeight,
    peekHeight,
    setSheetEl,
    snapTo,
    onPointerDown,
    dragMoved,
  };
}
