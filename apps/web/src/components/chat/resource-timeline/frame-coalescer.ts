/**
 * Coalesces a stream of calls into at most one per animation frame, keeping
 * the latest arguments. Pointer and wheel events fire far faster than the
 * screen repaints; applying each one as React state would redo the series
 * build and panel render for frames nobody sees.
 */
export interface FrameCoalescer<A extends unknown[]> {
  schedule: (...args: A) => void;
  /** The arguments waiting for the next frame, so readers can build on them. */
  pending: () => A | null;
  cancel: () => void;
}

export function createFrameCoalescer<A extends unknown[]>(
  apply: (...args: A) => void
): FrameCoalescer<A> {
  let pending: A | null = null;
  let frame: number | null = null;
  return {
    schedule(...args) {
      pending = args;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        const next = pending;
        pending = null;
        if (next) apply(...next);
      });
    },
    pending: () => pending,
    cancel() {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    },
  };
}
