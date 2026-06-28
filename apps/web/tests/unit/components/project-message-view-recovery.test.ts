/**
 * Tests for ProjectMessageView connection banner debounce.
 *
 * The connection banner debounce logic mirrors the production implementation
 * in useConnectionRecovery.ts — delay showing "Reconnecting..." for brief blips.
 *
 * NOTE: The ACP recovery mirror hook was removed because the production code
 * now uses useConnectionRecovery (apps/web/src/components/project-message-view/useConnectionRecovery.ts)
 * which has a fundamentally different approach (DO-only, no ACP WebSocket).
 * Tests for connection recovery should target the production hook directly.
 */
import { act,renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Test 1: Connection banner debounce hook pattern
// ---------------------------------------------------------------------------

/**
 * Mirrors the debounce logic from ProjectMessageView — extracted here to test
 * the timing behavior independently of the full component.
 */
function useConnectionBannerDebounce(
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected',
  delayMs: number
) {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (connectionState === 'connected' || connectionState === 'disconnected') {
      setShowBanner(connectionState === 'disconnected');
      return;
    }
    const timer = setTimeout(() => {
      setShowBanner(true);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [connectionState, delayMs]);

  return showBanner;
}

describe('Connection banner debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not show banner immediately when reconnecting', () => {
    const { result } = renderHook(() =>
      useConnectionBannerDebounce('reconnecting', 3000)
    );
    expect(result.current).toBe(false);
  });

  it('shows banner after delay when reconnecting persists', async () => {
    const { result } = renderHook(() =>
      useConnectionBannerDebounce('reconnecting', 3000)
    );
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toBe(true);
  });

  it('hides banner immediately when connection is restored before delay', async () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }) =>
        useConnectionBannerDebounce(state, 3000),
      { initialProps: { state: 'reconnecting' as const } }
    );

    // Banner not shown yet (within debounce)
    expect(result.current).toBe(false);

    // Advance partially
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current).toBe(false);

    // Connection restored before debounce fires
    rerender({ state: 'connected' });
    expect(result.current).toBe(false);

    // Even after the full delay, banner stays hidden
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toBe(false);
  });

  it('shows banner immediately for permanent disconnection', () => {
    const { result } = renderHook(() =>
      useConnectionBannerDebounce('disconnected', 3000)
    );
    // Permanent disconnect shows immediately
    expect(result.current).toBe(true);
  });

  it('does not show banner for brief connecting state', async () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }) =>
        useConnectionBannerDebounce(state, 3000),
      { initialProps: { state: 'connecting' as const } }
    );
    expect(result.current).toBe(false);

    // Connection succeeds quickly
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    rerender({ state: 'connected' });
    expect(result.current).toBe(false);
  });
});

// NOTE: The ACP recovery mirror hook and its tests were removed because the
// production code now uses useConnectionRecovery
// (apps/web/src/components/project-message-view/useConnectionRecovery.ts)
// which handles idle-session auto-resume via a DO-only approach (no ACP WebSocket).
// Tests for connection recovery should be written against the production hook.
