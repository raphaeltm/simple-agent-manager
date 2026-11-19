import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from '../../../src/hooks/useMediaQuery';

/** A matchMedia whose per-query state the test flips, firing `change` like a browser does. */
function installMatchMedia() {
  const state = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  const matchMedia = vi.fn((query: string) => ({
    get matches() {
      return state.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      const set = listeners.get(query) ?? new Set();
      set.add(listener);
      listeners.set(query, set);
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.get(query)?.delete(listener);
    }),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(window, 'matchMedia', { writable: true, value: matchMedia });
  return {
    set(query: string, matches: boolean) {
      state.set(query, matches);
      for (const listener of listeners.get(query) ?? []) listener();
    },
    listenerCount: (query: string) => listeners.get(query)?.size ?? 0,
  };
}

const WIDE = '(min-width: 1024px)';
const NARROW = '(max-width: 767px)';

describe('useMediaQuery', () => {
  const original = window.matchMedia;
  let media: ReturnType<typeof installMatchMedia>;

  beforeEach(() => {
    media = installMatchMedia();
  });
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: original });
  });

  it('starts from the current match and follows changes', () => {
    media.set(WIDE, true);
    const { result } = renderHook(() => useMediaQuery(WIDE));
    expect(result.current).toBe(true);

    act(() => media.set(WIDE, false));
    expect(result.current).toBe(false);
    act(() => media.set(WIDE, true));
    expect(result.current).toBe(true);
  });

  it('ignores changes to other queries', () => {
    const { result } = renderHook(() => useMediaQuery(WIDE));
    act(() => media.set(NARROW, true));
    expect(result.current).toBe(false);
  });

  it('moves its listener when the query changes, and removes it on unmount', () => {
    const { result, rerender, unmount } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: WIDE },
    });
    expect(media.listenerCount(WIDE)).toBe(1);

    media.set(NARROW, true);
    rerender({ query: NARROW });
    expect(result.current).toBe(true);
    expect(media.listenerCount(WIDE)).toBe(0);
    expect(media.listenerCount(NARROW)).toBe(1);

    unmount();
    expect(media.listenerCount(NARROW)).toBe(0);
  });

  it('is false where matchMedia does not exist', () => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: undefined });
    const { result } = renderHook(() => useMediaQuery(WIDE));
    expect(result.current).toBe(false);
  });
});
