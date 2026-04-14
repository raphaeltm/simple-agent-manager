import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useScrollLock } from '../../../src/hooks/useScrollLock';

describe('useScrollLock', () => {
  afterEach(() => {
    // Reset body style after each test
    document.body.style.overflow = '';
  });

  it('sets overflow hidden when active', () => {
    renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('does not set overflow when inactive', () => {
    renderHook(() => useScrollLock(false));
    expect(document.body.style.overflow).toBe('');
  });

  it('restores overflow on unmount', () => {
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('reference counts multiple locks', () => {
    const hook1 = renderHook(() => useScrollLock(true));
    const hook2 = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe('hidden');

    // Unmounting one lock should keep overflow hidden (another is still active)
    hook1.unmount();
    expect(document.body.style.overflow).toBe('hidden');

    // Unmounting the last lock should restore overflow
    hook2.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('restores overflow when toggled from active to inactive', () => {
    const { rerender } = renderHook(
      ({ active }) => useScrollLock(active),
      { initialProps: { active: true } },
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender({ active: false });
    expect(document.body.style.overflow).toBe('');
  });
});
