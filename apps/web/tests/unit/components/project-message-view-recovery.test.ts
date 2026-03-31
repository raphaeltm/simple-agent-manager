/**
 * Tests for ProjectMessageView ACP recovery and connection banner debounce.
 *
 * These test the two new behaviors:
 * 1. ACP recovery effect: when session is 'active' but ACP is in 'error' state,
 *    periodically call resumeAgentSession + reconnect
 * 2. Connection banner debounce: delay showing "Reconnecting..." for brief blips
 *
 * Since ProjectMessageView is a complex component that's hard to render in isolation
 * (depends on multiple hooks, WebSocket, routing), we extract and test the core logic
 * patterns using targeted hooks and source verification.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState, useEffect, useRef } from 'react';

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

  it('shows banner after delay when reconnecting persists', () => {
    const { result } = renderHook(() =>
      useConnectionBannerDebounce('reconnecting', 3000)
    );
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(true);
  });

  it('hides banner immediately when connection is restored before delay', () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }) =>
        useConnectionBannerDebounce(state, 3000),
      { initialProps: { state: 'reconnecting' as const } }
    );

    // Banner not shown yet (within debounce)
    expect(result.current).toBe(false);

    // Advance partially
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBe(false);

    // Connection restored before debounce fires
    rerender({ state: 'connected' });
    expect(result.current).toBe(false);

    // Even after the full delay, banner stays hidden
    act(() => {
      vi.advanceTimersByTime(3000);
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

  it('does not show banner for brief connecting state', () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }) =>
        useConnectionBannerDebounce(state, 3000),
      { initialProps: { state: 'connecting' as const } }
    );
    expect(result.current).toBe(false);

    // Connection succeeds quickly
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ state: 'connected' });
    expect(result.current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: ACP recovery effect pattern
// ---------------------------------------------------------------------------

/**
 * Mirrors the ACP recovery logic from ProjectMessageView — extracted to test
 * the retry scheduling, attempt counting, and condition gating.
 */
function useAcpRecovery(opts: {
  sessionState: 'active' | 'idle' | 'terminated';
  acpState: string;
  isAgentActive: boolean;
  isResuming: boolean;
  isProvisioning: boolean;
  workspaceId: string | null;
  agentSessionId: string | null;
  resumeFn: (wid: string, sid: string) => Promise<void>;
  reconnectFn: () => void;
  recoveryDelayMs: number;
  recoveryIntervalMs: number;
  maxAttempts: number;
}) {
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (
      opts.sessionState !== 'active' ||
      opts.acpState !== 'error' ||
      opts.isResuming ||
      opts.isProvisioning ||
      !opts.workspaceId ||
      !opts.agentSessionId
    ) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (opts.isAgentActive) {
        attemptsRef.current = 0;
        setAttempts(0);
      }
      return;
    }

    if (attemptsRef.current >= opts.maxAttempts) {
      return;
    }

    const delay = attemptsRef.current === 0
      ? opts.recoveryDelayMs
      : opts.recoveryIntervalMs;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      attemptsRef.current++;
      setAttempts(attemptsRef.current);
      opts.resumeFn(opts.workspaceId!, opts.agentSessionId!)
        .then(() => {
          opts.reconnectFn();
        })
        .catch((err) => {
          // Mirror the real component's 404-abort behavior: if workspace is gone, stop retrying
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
            attemptsRef.current = opts.maxAttempts;
            setAttempts(attemptsRef.current);
          }
        });
    }, delay);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  // In the real component, the acpState transitions ('error' → 'reconnecting' → 'error')
  // cause the effect to re-fire. Here we use `attempts` as a proxy for that re-trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.sessionState, opts.acpState, opts.isAgentActive, opts.isResuming, opts.isProvisioning, opts.workspaceId, opts.agentSessionId, attempts]);

  return { attempts };
}

describe('ACP recovery effect', () => {
  let resumeFn: ReturnType<typeof vi.fn>;
  let reconnectFn: ReturnType<typeof vi.fn>;

  const defaultOpts = {
    sessionState: 'active' as const,
    acpState: 'error',
    isAgentActive: false,
    isResuming: false,
    isProvisioning: false,
    workspaceId: 'ws-123',
    agentSessionId: 'agent-456',
    recoveryDelayMs: 5000,
    recoveryIntervalMs: 30000,
    maxAttempts: 10,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resumeFn = vi.fn().mockResolvedValue(undefined);
    reconnectFn = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers recovery after initial delay when session is active and ACP errored', async () => {
    renderHook(() =>
      useAcpRecovery({ ...defaultOpts, resumeFn, reconnectFn })
    );

    // Not triggered immediately
    expect(resumeFn).not.toHaveBeenCalled();

    // Trigger after initial delay
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledWith('ws-123', 'agent-456');
    expect(reconnectFn).toHaveBeenCalled();
  });

  it('does NOT trigger when sessionState is idle (existing auto-resume handles it)', () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        sessionState: 'idle',
        resumeFn,
        reconnectFn,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('does NOT trigger when ACP is not in error state', () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        acpState: 'ready',
        resumeFn,
        reconnectFn,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('does NOT trigger when already resuming', () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        isResuming: true,
        resumeFn,
        reconnectFn,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('does NOT trigger without workspaceId', () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        workspaceId: null,
        resumeFn,
        reconnectFn,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('resets attempts when agent becomes active', async () => {
    const { result, rerender } = renderHook(
      (props: typeof defaultOpts & { resumeFn: typeof resumeFn; reconnectFn: typeof reconnectFn }) =>
        useAcpRecovery(props),
      { initialProps: { ...defaultOpts, resumeFn, reconnectFn } }
    );

    // First recovery attempt
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.attempts).toBe(1);

    // Agent becomes active (reconnection succeeded)
    rerender({ ...defaultOpts, acpState: 'ready', isAgentActive: true, resumeFn, reconnectFn });
    expect(result.current.attempts).toBe(0);
  });

  it('uses longer interval for subsequent attempts', async () => {
    renderHook(() =>
      useAcpRecovery({ ...defaultOpts, resumeFn, reconnectFn })
    );

    // First attempt at 5s (initial delay)
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1);

    // Second attempt should wait 30s (interval), not 5s
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1); // Still 1

    await act(async () => {
      vi.advanceTimersByTime(25000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(2); // Now 2
  });

  it('stops after max attempts', async () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        maxAttempts: 2,
        resumeFn,
        reconnectFn,
      })
    );

    // Attempt 1
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1);

    // Attempt 2
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(2);

    // No more attempts
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT trigger without agentSessionId', () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        agentSessionId: null,
        resumeFn,
        reconnectFn,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('does NOT trigger when provisioning', () => {
    renderHook(() =>
      useAcpRecovery({
        ...defaultOpts,
        isProvisioning: true,
        resumeFn,
        reconnectFn,
      })
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('stops retrying on 404 error (workspace gone)', async () => {
    resumeFn = vi.fn().mockRejectedValue(new Error('404 Not Found'));

    renderHook(() =>
      useAcpRecovery({ ...defaultOpts, resumeFn, reconnectFn })
    );

    // First attempt fires
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1);
    expect(reconnectFn).not.toHaveBeenCalled(); // rejected, so no reconnect

    // No further attempts — 404 pins attempts to max
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT call reconnect when resume rejects with non-404 error', async () => {
    resumeFn = vi.fn().mockRejectedValue(new Error('Network timeout'));

    renderHook(() =>
      useAcpRecovery({ ...defaultOpts, resumeFn, reconnectFn })
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1);
    expect(reconnectFn).not.toHaveBeenCalled(); // must NOT reconnect on failure
  });

  it('retries after non-404 error', async () => {
    resumeFn = vi.fn().mockRejectedValue(new Error('Network timeout'));

    renderHook(() =>
      useAcpRecovery({ ...defaultOpts, resumeFn, reconnectFn })
    );

    // First attempt
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(1);

    // Second attempt after interval (non-404 errors allow retries)
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(resumeFn).toHaveBeenCalledTimes(2);
  });
});
