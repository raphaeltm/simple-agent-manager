import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVisibilityAwarePoll } from '../../../src/hooks/useVisibilityAwarePoll';

const INTERVAL = 10_000;

/** Drives `document.visibilityState` and fires a real `visibilitychange` event. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useVisibilityAwarePoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('does not fire on mount — the caller owns the initial load', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));
    expect(poll).not.toHaveBeenCalled();
  });

  it('fires once per interval while visible, enabled and not paused', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));

    advance(INTERVAL);
    expect(poll).toHaveBeenCalledTimes(1);
    advance(INTERVAL * 2);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('does not fire while the tab is hidden', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));

    setVisibility('hidden');
    advance(INTERVAL * 5);

    expect(poll).not.toHaveBeenCalled();
  });

  it('refreshes immediately when the tab becomes visible after a missed interval', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));

    setVisibility('hidden');
    advance(INTERVAL * 3);
    expect(poll).not.toHaveBeenCalled();

    setVisibility('visible');
    // The catch-up runs synchronously on re-activation, before any new tick.
    expect(poll).toHaveBeenCalledTimes(1);

    advance(INTERVAL);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not refresh on return when less than one interval elapsed', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));

    setVisibility('hidden');
    advance(INTERVAL / 4);
    setVisibility('visible');

    // Data is at most one interval old — the poll's own freshness contract —
    // so rapid tab switching must not produce a request storm.
    expect(poll).not.toHaveBeenCalled();
  });

  it('does not fire while paused, and catches up when unpaused', () => {
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useVisibilityAwarePoll(poll, INTERVAL, { paused }),
      { initialProps: { paused: true } }
    );

    advance(INTERVAL * 3);
    expect(poll).not.toHaveBeenCalled();

    act(() => rerender({ paused: false }));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('does not fire while disabled', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL, { enabled: false }));

    advance(INTERVAL * 5);
    expect(poll).not.toHaveBeenCalled();
  });

  it('does NOT catch up when enabled flips true — the caller owns that fetch', () => {
    // Callers pair a precondition becoming true with their own fetch (new id,
    // workspace just started, token just arrived). Preconditions routinely take
    // longer than one interval, so a naive elapsed-based catch-up would fire a
    // duplicate request on top of the caller's on every single activation.
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useVisibilityAwarePoll(poll, INTERVAL, { enabled }),
      { initialProps: { enabled: false } }
    );

    advance(INTERVAL * 6);
    act(() => rerender({ enabled: true }));
    expect(poll).not.toHaveBeenCalled();

    // ...but normal polling starts from that moment.
    advance(INTERVAL);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('still catches up on tab return while continuously enabled', () => {
    // The enable-reset above must not swallow the hidden-tab catch-up: nothing
    // else fetches while the tab is hidden, so that elapsed time still counts.
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePoll(poll, INTERVAL, { enabled: true }));

    setVisibility('hidden');
    advance(INTERVAL * 3);
    setVisibility('visible');

    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire when enabled and visibility flip in the same commit', () => {
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ enabled, paused }: { enabled: boolean; paused: boolean }) =>
        useVisibilityAwarePoll(poll, INTERVAL, { enabled, paused }),
      { initialProps: { enabled: false, paused: true } }
    );

    setVisibility('hidden');
    advance(INTERVAL * 4);

    act(() => {
      rerender({ enabled: true, paused: false });
    });
    setVisibility('visible');

    // `enabled` became true in this window, so the caller owns the fetch.
    expect(poll).not.toHaveBeenCalled();
  });

  it('re-evaluates the catch-up when intervalMs shrinks below the elapsed time', () => {
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ intervalMs }: { intervalMs: number }) => useVisibilityAwarePoll(poll, intervalMs),
      { initialProps: { intervalMs: INTERVAL } }
    );

    advance(INTERVAL / 2);
    expect(poll).not.toHaveBeenCalled();

    // Half an interval has passed; a shorter interval means that window is now
    // overdue, so the poll must fire rather than wait out the old cadence.
    act(() => rerender({ intervalMs: INTERVAL / 4 }));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('does not fire when intervalMs grows', () => {
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ intervalMs }: { intervalMs: number }) => useVisibilityAwarePoll(poll, intervalMs),
      { initialProps: { intervalMs: INTERVAL } }
    );

    advance(INTERVAL / 2);
    act(() => rerender({ intervalMs: INTERVAL * 4 }));

    expect(poll).not.toHaveBeenCalled();
  });

  it('makes no further calls after unmount mid-flight', async () => {
    let settle!: () => void;
    const poll = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const { unmount } = renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));

    advance(INTERVAL);
    expect(poll).toHaveBeenCalledTimes(1);

    unmount();
    settle();
    advance(INTERVAL * 5);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('stays paused when hidden even if unpaused', () => {
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useVisibilityAwarePoll(poll, INTERVAL, { paused }),
      { initialProps: { paused: true } }
    );

    setVisibility('hidden');
    advance(INTERVAL * 3);
    act(() => rerender({ paused: false }));

    expect(poll).not.toHaveBeenCalled();
  });

  it('never restarts or double-fires when the callback identity changes each render', () => {
    // The loop-prevention guarantee: an unmemoized caller closure must not be
    // able to reset the timer (which would starve the poll) or trigger an extra
    // fetch. See .claude/rules/06-technical-patterns.md.
    const spy = vi.fn();
    const { rerender } = renderHook(() =>
      // A brand-new closure on every render, deliberately.
      useVisibilityAwarePoll(() => spy(), INTERVAL)
    );

    advance(INTERVAL / 2);
    act(() => rerender());
    act(() => rerender());
    advance(INTERVAL / 2);

    // One full interval elapsed across three different callback identities.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('always invokes the latest callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => useVisibilityAwarePoll(cb, INTERVAL),
      { initialProps: { cb: first } }
    );

    act(() => rerender({ cb: second }));
    advance(INTERVAL);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops polling after unmount', () => {
    const poll = vi.fn();
    const { unmount } = renderHook(() => useVisibilityAwarePoll(poll, INTERVAL));

    advance(INTERVAL);
    expect(poll).toHaveBeenCalledTimes(1);

    unmount();
    advance(INTERVAL * 5);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
