import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useClickOutside } from '../src/hooks/useClickOutside';
import { createRef } from 'react';

describe('useClickOutside', () => {
  it('calls callback when clicking outside the ref element', () => {
    const callback = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(ref, 'current', { value: element, writable: true });

    renderHook(() => useClickOutside(ref, callback));

    // Click outside the element
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(callback).toHaveBeenCalledTimes(1);

    document.body.removeChild(element);
  });

  it('does not call callback when clicking inside the ref element', () => {
    const callback = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(ref, 'current', { value: element, writable: true });

    renderHook(() => useClickOutside(ref, callback));

    // Click inside the element
    act(() => {
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(callback).not.toHaveBeenCalled();

    document.body.removeChild(element);
  });

  it('does not call callback when disabled', () => {
    const callback = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(ref, 'current', { value: element, writable: true });

    renderHook(() => useClickOutside(ref, callback, false));

    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(callback).not.toHaveBeenCalled();

    document.body.removeChild(element);
  });

  it('uses latest callback without resubscribing', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(ref, 'current', { value: element, writable: true });

    const { rerender } = renderHook(
      ({ cb }) => useClickOutside(ref, cb),
      { initialProps: { cb: callback1 } },
    );

    rerender({ cb: callback2 });

    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledTimes(1);

    document.body.removeChild(element);
  });

  it('cleans up listener on unmount', () => {
    const callback = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const element = document.createElement('div');
    document.body.appendChild(element);
    Object.defineProperty(ref, 'current', { value: element, writable: true });

    const { unmount } = renderHook(() => useClickOutside(ref, callback));

    unmount();

    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(callback).not.toHaveBeenCalled();

    document.body.removeChild(element);
  });
});
