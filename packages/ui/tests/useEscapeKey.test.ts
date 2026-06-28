import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useEscapeKey } from '../src/hooks/useEscapeKey';

describe('useEscapeKey', () => {
  it('calls callback when Escape is pressed', () => {
    const callback = vi.fn();
    renderHook(() => useEscapeKey(callback));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not call callback for non-Escape keys', () => {
    const callback = vi.fn();
    renderHook(() => useEscapeKey(callback));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not call callback when disabled', () => {
    const callback = vi.fn();
    renderHook(() => useEscapeKey(callback, false));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('uses latest callback without resubscribing', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useEscapeKey(cb),
      { initialProps: { cb: callback1 } },
    );

    // Update callback
    rerender({ cb: callback2 });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    // Only the latest callback should be called
    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(callback));

    unmount();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(callback).not.toHaveBeenCalled();
  });
});
