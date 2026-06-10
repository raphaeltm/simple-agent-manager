import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePrefersReducedMotion } from '../../../src/hooks/usePrefersReducedMotion';

function installMatchMedia(initialMatches: boolean) {
  let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: initialMatches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_event: string, handler: (event: MediaQueryListEvent) => void) => {
      changeHandler = handler;
    }),
    removeEventListener: vi.fn((_event: string, handler: (event: MediaQueryListEvent) => void) => {
      if (changeHandler === handler) changeHandler = null;
    }),
    dispatchEvent: vi.fn(() => false),
  } satisfies MediaQueryList;

  window.matchMedia = vi.fn(() => mql);

  return {
    mql,
    change(matches: boolean) {
      mql.matches = matches;
      changeHandler?.({ matches } as MediaQueryListEvent);
    },
  };
}

describe('usePrefersReducedMotion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when matchMedia is unavailable', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it('uses the initial media query match state', () => {
    installMatchMedia(true);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(true);
  });

  it('updates when the media query changes and unsubscribes on unmount', () => {
    const media = installMatchMedia(false);

    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      media.change(true);
    });

    expect(result.current).toBe(true);

    unmount();
    expect(media.mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
