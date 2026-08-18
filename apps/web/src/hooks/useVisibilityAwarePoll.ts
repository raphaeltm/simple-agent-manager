import { useEffect, useRef, useState } from 'react';

/**
 * Tracks whether the document is currently visible.
 *
 * Returns `true` in non-browser environments (SSR / test harnesses without a
 * `document`) so a missing Page Visibility API can never silently disable a poll.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setVisible(document.visibilityState !== 'hidden');
    // Re-sync on subscribe: visibility can flip between the initial state
    // computation and the listener being attached.
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return visible;
}

export interface VisibilityAwarePollOptions {
  /**
   * Whether this poll should exist at all. Use for preconditions that are
   * absent rather than transiently suppressed (missing id, workspace not
   * running, first load not finished). Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Transient suppression while a better data source is live — e.g. a
   * connected WebSocket already delivering deltas. Defaults to `false`.
   */
  paused?: boolean;
}

/**
 * Runs `callback` every `intervalMs`, but only while the tab is visible, the
 * poll is `enabled`, and it is not `paused`.
 *
 * Catch-up semantics: when the poll becomes active again (tab regains
 * visibility, WebSocket drops, precondition satisfied) it refreshes immediately
 * **iff at least one interval has elapsed since the last poll**. That bounds
 * staleness at exactly one interval — the poll's own freshness contract — while
 * avoiding a request storm from rapid tab switching, and it still catches up
 * correctly when a browser freezes background timers outright.
 *
 * `callback` is held in a ref and is deliberately NOT an effect dependency, so a
 * caller re-creating the closure each render can never restart the timer or
 * trigger an extra fetch (see `.claude/rules/06-technical-patterns.md`, React
 * Interaction-Effect Analysis). Callers therefore do not need to memoize it,
 * though doing so remains harmless.
 *
 * This hook never renders anything and never gates rendering — refetches must
 * keep already-visible data on screen (`.claude/rules/48-stale-while-revalidate-ui.md`).
 */
export function useVisibilityAwarePoll(
  callback: () => unknown,
  intervalMs: number,
  options: VisibilityAwarePollOptions = {}
): void {
  const { enabled = true, paused = false } = options;

  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  const visible = useDocumentVisible();
  // Seeded at mount: callers own their initial load, so a freshly mounted poll
  // must not immediately fire a duplicate request.
  const lastPollAtRef = useRef<number>(Date.now());
  const wasEnabledRef = useRef<boolean>(enabled);

  const active = enabled && !paused && visible;

  useEffect(() => {
    // `enabled` flipping true means the caller's precondition was just
    // satisfied, and callers pair that transition with their own fetch (a new
    // id, a workspace that just started, a token that just arrived). Restart the
    // freshness clock so the catch-up below cannot fire a duplicate request on
    // top of it — preconditions routinely take longer than one interval to
    // become true, which would otherwise guarantee a double fetch every time.
    //
    // `paused` and visibility are deliberately NOT treated this way: nobody else
    // is fetching during those, so their elapsed time must still count toward
    // the catch-up.
    if (enabled && !wasEnabledRef.current) lastPollAtRef.current = Date.now();
    wasEnabledRef.current = enabled;

    if (!active) return;

    const run = () => {
      lastPollAtRef.current = Date.now();
      void callbackRef.current();
    };

    if (Date.now() - lastPollAtRef.current >= intervalMs) run();

    const timer = setInterval(run, intervalMs);
    return () => clearInterval(timer);
  }, [active, enabled, intervalMs]);
}
