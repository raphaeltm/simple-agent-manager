import { type RefObject, useEffect } from 'react';

import { createFrameCoalescer } from './frame-coalescer';
import type { ViewRange } from './timeline-view';

/**
 * Touch and wheel interaction for the stacked panels. Mouse hover and
 * drag-to-zoom stay with uPlot; this layer adds what uPlot does not do.
 *
 * - One finger, moving mostly sideways: scrub (the readout follows the finger).
 *   Mostly vertical: nothing — the element is `touch-action: pan-y`, so the page
 *   scrolls as usual.
 * - A tap: moves the readout to that instant.
 * - Two fingers: pinch to zoom and drag to pan, anchored under the fingers.
 * - Trackpad pinch or ctrl+wheel zooms at the pointer; a sideways swipe pans.
 *   A plain vertical wheel scrolls the drawer.
 */
export interface GestureHandlers {
  /** Client-space rectangle of the plotting area, which all panels share. */
  plotRect: () => DOMRect | null;
  view: () => ViewRange;
  onScrub: (x: number) => void;
  onTap: (x: number) => void;
  onRange: (min: number, max: number) => void;
}

/** Movement (CSS px) before a touch commits to a direction. */
const DIRECTION_LOCK_PX = 8;
const WHEEL_ZOOM_SENSITIVITY = 0.01;

type Gesture =
  | { kind: 'idle' }
  | { kind: 'pending'; x: number; y: number }
  | { kind: 'scrub' }
  | { kind: 'scroll' }
  | { kind: 'pinch'; distance: number; midX: number; view: ViewRange };

function toAxis(clientX: number, rect: DOMRect, view: ViewRange): number {
  return view.min + ((clientX - rect.left) / Math.max(1, rect.width)) * (view.max - view.min);
}

export function useTimelineGestures(
  elementRef: RefObject<HTMLElement | null>,
  handlersRef: RefObject<GestureHandlers>
) {
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let gesture: Gesture = { kind: 'idle' };
    // One view and one scrub update per frame, however fast the events arrive.
    const range = createFrameCoalescer((min: number, max: number) =>
      handlersRef.current.onRange(min, max)
    );
    const scrub = createFrameCoalescer((x: number) => handlersRef.current.onScrub(x));
    /** The view including a range still waiting for its frame, so rapid wheel events accumulate. */
    const currentView = (): ViewRange => {
      const next = range.pending();
      return next ? { min: next[0], max: next[1] } : handlersRef.current.view();
    };

    const axisAt = (clientX: number): number | null => {
      const rect = handlersRef.current.plotRect();
      return rect ? toAxis(clientX, rect, currentView()) : null;
    };

    const startPinch = () => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      gesture = {
        kind: 'pinch',
        distance: Math.max(1, Math.abs(a.x - b.x)),
        midX: (a.x + b.x) / 2,
        view: currentView(),
      };
    };

    const updatePinch = (pinch: Extract<Gesture, { kind: 'pinch' }>) => {
      const [a, b] = [...pointers.values()];
      const rect = handlersRef.current.plotRect();
      if (!a || !b || !rect) return;
      const span = pinch.view.max - pinch.view.min;
      const nextSpan = span * (pinch.distance / Math.max(1, Math.abs(a.x - b.x)));
      // The instant that was under the fingers' midpoint stays under it.
      const anchor = toAxis(pinch.midX, rect, pinch.view);
      const midFraction = ((a.x + b.x) / 2 - rect.left) / Math.max(1, rect.width);
      const min = anchor - midFraction * nextSpan;
      range.schedule(min, min + nextSpan);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) gesture = { kind: 'pending', x: event.clientX, y: event.clientY };
      if (pointers.size === 2) {
        for (const id of pointers.keys()) element.setPointerCapture(id);
        startPinch();
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (gesture.kind === 'pending') {
        const dx = Math.abs(event.clientX - gesture.x);
        const dy = Math.abs(event.clientY - gesture.y);
        if (dx > DIRECTION_LOCK_PX && dx > dy) {
          gesture = { kind: 'scrub' };
          element.setPointerCapture(event.pointerId);
        } else if (dy > DIRECTION_LOCK_PX) {
          gesture = { kind: 'scroll' };
        }
      }
      if (gesture.kind === 'scrub') {
        const x = axisAt(event.clientX);
        if (x != null) scrub.schedule(x);
      } else if (gesture.kind === 'pinch') {
        updatePinch(gesture);
      }
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      if (event.type === 'pointerup' && gesture.kind === 'pending') {
        const x = axisAt(event.clientX);
        if (x != null) handlersRef.current.onTap(x);
      }
      pointers.delete(event.pointerId);
      // Lifting one finger of a pinch ends the gesture; it never turns into a scrub.
      gesture = pointers.size === 0 ? { kind: 'idle' } : { kind: 'scroll' };
    };

    const onWheel = (event: WheelEvent) => {
      const rect = handlersRef.current.plotRect();
      if (!rect) return;
      const view = currentView();
      const span = view.max - view.min;
      if (event.ctrlKey) {
        event.preventDefault();
        const anchor = toAxis(event.clientX, rect, view);
        const factor = Math.exp(event.deltaY * WHEEL_ZOOM_SENSITIVITY);
        range.schedule(
          anchor - (anchor - view.min) * factor,
          anchor + (view.max - anchor) * factor
        );
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const shift = (event.deltaX / Math.max(1, rect.width)) * span;
        range.schedule(view.min + shift, view.max + shift);
      }
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerEnd);
    element.addEventListener('pointercancel', onPointerEnd);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerEnd);
      element.removeEventListener('pointercancel', onPointerEnd);
      element.removeEventListener('wheel', onWheel);
      range.cancel();
      scrub.cancel();
    };
  }, [elementRef, handlersRef]);
}
