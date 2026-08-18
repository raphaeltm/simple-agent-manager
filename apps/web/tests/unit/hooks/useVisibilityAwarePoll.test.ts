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

  it('does not fire while disabled, and catches up when enabled', () => {
    const poll = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useVisibilityAwarePoll(poll, INTERVAL, { enabled }),
      { initialProps: { enabled: false } }
    );

    advance(INTERVAL * 3);
    expect(poll).not.toHaveBeenCalled();

    act(() => rerender({ enabled: true }));
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
