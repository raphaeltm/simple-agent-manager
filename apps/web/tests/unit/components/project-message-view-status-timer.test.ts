/**
 * Tests for the agent status bar verify-before-decay timer in useSessionLifecycle.
 *
 * Regression coverage for the blind-decay bug: the `onMessage` handler used to arm a
 * blind 30s `setTimeout(() => setActivity('idle'))` that clobbered the verify-before-decay
 * timer set by `onAgentActivity('prompting')`. During a >30s tool-call silence the blind
 * timer fired and flipped the status bar (and Cancel button) to idle even though the DO
 * still reported `state.activity === 'prompting'`.
 *
 * The fix routes BOTH handlers through a single shared `startVerifyDecayTimer` that verifies
 * DO state before decaying. These tests are the deferred T1/T2 from the 2026-06-11 task.
 *
 * Since useSessionLifecycle is a large hook (WebSocket, routing, many deps) that's hard to
 * render in isolation, we extract the timer interaction into a focused mirror hook — the
 * same approach used in project-message-view-recovery.test.ts.
 */
import { act, renderHook } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IDLE_TIMEOUT_MS = 30_000;

type AgentActivityState = 'idle' | 'prompting' | 'responding';

/**
 * Mirrors the shared verify-before-decay timer logic from useSessionLifecycle.
 * `verifyActivity` stands in for the DO state fetch (getChatSession → state.activity).
 */
function useStatusTimerMirror(
  sessionId: string,
  verifyActivity: () => Promise<'prompting' | 'idle'>,
) {
  const [agentActivity, setAgentActivity] = useState<AgentActivityState>('idle');
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const verifyAbortRef = useRef<AbortController | null>(null);

  const clearActivity = useCallback(() => {
    setAgentActivity('idle');
  }, []);

  const startVerifyDecayTimer = useCallback(() => {
    clearTimeout(idleTimerRef.current);
    verifyAbortRef.current?.abort();
    const abortController = new AbortController();
    verifyAbortRef.current = abortController;
    const armVerifyTimer = () => {
      idleTimerRef.current = setTimeout(async () => {
        if (abortController.signal.aborted) return;
        try {
          const activity = await verifyActivity();
          if (abortController.signal.aborted) return;
          if (activity === 'prompting') {
            armVerifyTimer();
          } else {
            clearActivity();
          }
        } catch {
          if (!abortController.signal.aborted) clearActivity();
        }
      }, IDLE_TIMEOUT_MS);
    };
    armVerifyTimer();
  }, [clearActivity, verifyActivity]);

  // onAgentActivity('prompting' | 'idle')
  const onAgentActivity = useCallback((activity: 'prompting' | 'idle') => {
    setAgentActivity(activity === 'prompting' ? 'prompting' : 'idle');
    if (activity === 'prompting') {
      startVerifyDecayTimer();
    } else {
      clearTimeout(idleTimerRef.current);
      verifyAbortRef.current?.abort();
      verifyAbortRef.current = null;
    }
  }, [startVerifyDecayTimer]);

  // onMessage (non-user agent output)
  const onAgentMessage = useCallback(() => {
    setAgentActivity('responding');
    startVerifyDecayTimer();
  }, [startVerifyDecayTimer]);

  // Session-change cleanup effect
  useEffect(() => {
    clearTimeout(idleTimerRef.current);
    verifyAbortRef.current?.abort();
    verifyAbortRef.current = null;
    return () => { clearTimeout(idleTimerRef.current); verifyAbortRef.current?.abort(); };
  }, [sessionId]);

  return { agentActivity, onAgentActivity, onAgentMessage };
}

describe('Agent status verify-before-decay timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // T1: status bar persists through long silence while DO still reports prompting
  it('re-arms instead of decaying when DO still reports prompting after timeout', async () => {
    const verifyActivity = vi.fn().mockResolvedValue('prompting' as const);
    const { result } = renderHook(() => useStatusTimerMirror('sess-1', verifyActivity));

    act(() => { result.current.onAgentActivity('prompting'); });
    expect(result.current.agentActivity).toBe('prompting');

    // First 30s silence — timer fires, verifies, sees 'prompting', re-arms.
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS); });
    expect(verifyActivity).toHaveBeenCalledTimes(1);
    expect(result.current.agentActivity).toBe('prompting');

    // Second 30s silence — still prompting, still alive (no false idle).
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS); });
    expect(verifyActivity).toHaveBeenCalledTimes(2);
    expect(result.current.agentActivity).toBe('prompting');
  });

  // T2: decay to idle when DO confirms the prompt is no longer active
  it('decays to idle when DO reports activity is no longer prompting', async () => {
    const verifyActivity = vi.fn().mockResolvedValue('idle' as const);
    const { result } = renderHook(() => useStatusTimerMirror('sess-1', verifyActivity));

    act(() => { result.current.onAgentActivity('prompting'); });
    expect(result.current.agentActivity).toBe('prompting');

    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS); });
    expect(verifyActivity).toHaveBeenCalledTimes(1);
    expect(result.current.agentActivity).toBe('idle');
  });

  // Regression: an agent message must NOT arm a blind decay timer.
  it('an agent message verifies DO state before decaying (no blind decay)', async () => {
    const verifyActivity = vi.fn().mockResolvedValue('prompting' as const);
    const { result } = renderHook(() => useStatusTimerMirror('sess-1', verifyActivity));

    // Streaming output arrives — shows 'responding'.
    act(() => { result.current.onAgentMessage(); });
    expect(result.current.agentActivity).toBe('responding');

    // 30s of silence after the message: the OLD blind timer would have flipped to 'idle'
    // here. The shared timer verifies DO state first and re-arms because it's still prompting.
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS); });
    expect(verifyActivity).toHaveBeenCalledTimes(1);
    expect(result.current.agentActivity).not.toBe('idle');
  });

  // Regression: message after a prompting event does not clobber the verified timer.
  it('a message during a prompt keeps verifying DO state (timers do not fight)', async () => {
    const verifyActivity = vi.fn().mockResolvedValue('prompting' as const);
    const { result } = renderHook(() => useStatusTimerMirror('sess-1', verifyActivity));

    act(() => { result.current.onAgentActivity('prompting'); });
    act(() => { result.current.onAgentMessage(); });

    // After a full timeout the bar is still alive (verified, not blindly decayed).
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS); });
    expect(verifyActivity).toHaveBeenCalled();
    expect(result.current.agentActivity).not.toBe('idle');
  });

  // Authoritative idle from the DO stops the timer immediately.
  it('onAgentActivity("idle") clears the timer and does not verify', async () => {
    const verifyActivity = vi.fn().mockResolvedValue('prompting' as const);
    const { result } = renderHook(() => useStatusTimerMirror('sess-1', verifyActivity));

    act(() => { result.current.onAgentActivity('prompting'); });
    act(() => { result.current.onAgentActivity('idle'); });
    expect(result.current.agentActivity).toBe('idle');

    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2); });
    expect(verifyActivity).not.toHaveBeenCalled();
    expect(result.current.agentActivity).toBe('idle');
  });

  // Timer is cleared on session switch (no cross-session false idle / stale verify).
  it('clears the timer on session switch', async () => {
    const verifyActivity = vi.fn().mockResolvedValue('prompting' as const);
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useStatusTimerMirror(sid, verifyActivity),
      { initialProps: { sid: 'sess-1' } },
    );

    act(() => { result.current.onAgentActivity('prompting'); });

    // Switch sessions before the timer fires.
    rerender({ sid: 'sess-2' });

    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2); });
    // The pre-switch timer was cleared/aborted, so no verify call leaked through.
    expect(verifyActivity).not.toHaveBeenCalled();
  });

  // Verify failure decays to idle (fail-safe).
  it('decays to idle when the DO verify call fails', async () => {
    const verifyActivity = vi.fn().mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useStatusTimerMirror('sess-1', verifyActivity));

    act(() => { result.current.onAgentActivity('prompting'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS); });
    expect(result.current.agentActivity).toBe('idle');
  });
});
