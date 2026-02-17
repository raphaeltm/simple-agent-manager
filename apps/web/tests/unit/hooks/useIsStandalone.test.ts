import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsStandalone } from '../../../src/hooks/useIsStandalone';

describe('useIsStandalone', () => {
  let listeners: Map<string, (e: MediaQueryListEvent) => void>;
  let matchesValue: boolean;

  beforeEach(() => {
    listeners = new Map();
    matchesValue = false;

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: matchesValue,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
          listeners.set(query, handler);
        }),
        removeEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
          if (listeners.get(query) === handler) {
            listeners.delete(query);
          }
        }),
        dispatchEvent: vi.fn(),
      })),
    });

    // Reset navigator.standalone
    Object.defineProperty(navigator, 'standalone', {
      writable: true,
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when not in standalone mode', () => {
    matchesValue = false;
    const { result } = renderHook(() => useIsStandalone());
    expect(result.current).toBe(false);
  });

  it('returns true when display-mode: standalone matches', () => {
    matchesValue = true;
    const { result } = renderHook(() => useIsStandalone());
    expect(result.current).toBe(true);
  });

  it('returns true when navigator.standalone is true (iOS Safari)', () => {
    matchesValue = false;
    Object.defineProperty(navigator, 'standalone', {
      writable: true,
      configurable: true,
      value: true,
    });

    const { result } = renderHook(() => useIsStandalone());
    expect(result.current).toBe(true);
  });

  it('reacts to matchMedia change events', () => {
    matchesValue = false;
    const { result } = renderHook(() => useIsStandalone());
    expect(result.current).toBe(false);

    act(() => {
      const handler = listeners.get('(display-mode: standalone)');
      handler?.({ matches: true } as MediaQueryListEvent);
    });

    expect(result.current).toBe(true);
  });

  it('cleans up listener on unmount', () => {
    matchesValue = false;
    const { unmount } = renderHook(() => useIsStandalone());

    expect(listeners.has('(display-mode: standalone)')).toBe(true);
    unmount();
    expect(listeners.has('(display-mode: standalone)')).toBe(false);
  });
});
