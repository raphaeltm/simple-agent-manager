import { act,renderHook } from '@testing-library/react';
import { beforeAll,describe, expect, it, vi } from 'vitest';

import { useGlobalCommandPalette } from '../../../src/hooks/useGlobalCommandPalette';

// Stub navigator.platform for consistent behavior
beforeAll(() => {
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    writable: true,
  });
});

function fireKeyDown(key: string, opts: Partial<KeyboardEvent> = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(event);
}

describe('useGlobalCommandPalette', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());
    expect(result.current.isOpen).toBe(false);
  });

  it('opens with open()', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
  });

  it('closes with close()', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it('toggles with toggle()', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);
  });

  it('toggles on Cmd+K (macOS)', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());

    act(() => fireKeyDown('k', { metaKey: true }));
    expect(result.current.isOpen).toBe(true);

    act(() => fireKeyDown('k', { metaKey: true }));
    expect(result.current.isOpen).toBe(false);
  });

  it('does not toggle on K without modifier', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());
    act(() => fireKeyDown('k'));
    expect(result.current.isOpen).toBe(false);
  });

  it('does not toggle on Cmd+Shift+K', () => {
    const { result } = renderHook(() => useGlobalCommandPalette());
    act(() => fireKeyDown('k', { metaKey: true, shiftKey: true }));
    expect(result.current.isOpen).toBe(false);
  });

  it('cleans up event listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useGlobalCommandPalette());
    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
      { capture: true },
    );
    removeEventListenerSpy.mockRestore();
  });
});
