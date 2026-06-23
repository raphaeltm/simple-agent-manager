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
  const [promptStartedAt, setPromptStartedAt] = useState<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const verifyAbortRef = useRef<AbortController | null>(null);

  const clearActivity = useCallback(() => {
    setAgentActivity('idle');
    setPromptStartedAt(null);
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

  // onAgentActivity('prompting' | 'idle', promptStartedAt?)
  const onAgentActivity = useCallback((activity: 'prompting' | 'idle', startedAt?: number | null) => {
    setAgentActivity(activity === 'prompting' ? 'prompting' : 'idle');
    setPromptStartedAt(activity === 'prompting' ? (startedAt ?? Date.now()) : null);
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

  // onSessionStopped / onAgentCompleted — authoritative idle that must also kill the verify timer.
  const onTerminalIdle = useCallback(() => {
    setAgentActivity('idle');
    setPromptStartedAt(null);
    clearTimeout(idleTimerRef.current);
    verifyAbortRef.current?.abort();
    verifyAbortRef.current = null;
  }, []);

  // Session-change cleanup effect
  useEffect(() => {
    clearTimeout(idleTimerRef.current);
    verifyAbortRef.current?.abort();
    verifyAbortRef.current = null;
    return () => { clearTimeout(idleTimerRef.current); verifyAbortRef.current?.abort(); };
  }, [sessionId]);

  return { agentActivity, promptStartedAt, onAgentActivity, onAgentMessage, onTerminalIdle };
}

/** Render the mirror hook with a `verifyActivity` mock resolving (or rejecting) as configured. */
function setup(
  verifyResult: 'prompting' | 'idle' | Error = 'prompting',
  sessionId = 'sess-1',
) {
  const verifyActivity =
    verifyResult instanceof Error
      ? vi.fn().mockRejectedValue(verifyResult)
      : vi.fn().mockResolvedValue(verifyResult);
  const view = renderHook(
    ({ sid }: { sid: string }) => useStatusTimerMirror(sid, verifyActivity),
    { initialProps: { sid: sessionId } },
  );
  return { verifyActivity, ...view };
}

/** Advance fake timers and flush the verify promise microtasks. */
async function advance(ms = IDLE_TIMEOUT_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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
    const { result, verifyActivity } = setup('prompting');

    act(() => { result.current.onAgentActivity('prompting', 1000); });
    expect(result.current.agentActivity).toBe('prompting');
    expect(result.current.promptStartedAt).toBe(1000);

    // First 30s silence — timer fires, verifies, sees 'prompting', re-arms.
    await advance();
    expect(verifyActivity).toHaveBeenCalledTimes(1);
    expect(result.current.agentActivity).toBe('prompting');
    // The elapsed-time anchor survives the re-arm (not reset on each verify).
    expect(result.current.promptStartedAt).toBe(1000);

    // Second 30s silence — still prompting, still alive (no false idle).
    await advance();
    expect(verifyActivity).toHaveBeenCalledTimes(2);
    expect(result.current.agentActivity).toBe('prompting');
    expect(result.current.promptStartedAt).toBe(1000);
  });

  // T2: decay to idle when DO confirms the prompt is no longer active
  it('decays to idle when DO reports activity is no longer prompting', async () => {
    const { result, verifyActivity } = setup('idle');

    act(() => { result.current.onAgentActivity('prompting', 1000); });
    expect(result.current.agentActivity).toBe('prompting');
    expect(result.current.promptStartedAt).toBe(1000);

    await advance();
    expect(verifyActivity).toHaveBeenCalledTimes(1);
    expect(result.current.agentActivity).toBe('idle');
    // Decay-to-idle must also clear the elapsed-time anchor so the UI timer stops.
    expect(result.current.promptStartedAt).toBeNull();
  });

  // Regression: an agent message must NOT arm a blind decay timer.
  it('an agent message verifies DO state before decaying (no blind decay)', async () => {
    const { result, verifyActivity } = setup('prompting');

    // Streaming output arrives — shows 'responding'.
    act(() => { result.current.onAgentMessage(); });
    expect(result.current.agentActivity).toBe('responding');

    // 30s of silence after the message: the OLD blind timer would have flipped to 'idle'
    // here. The shared timer verifies DO state first and re-arms because it's still prompting.
    await advance();
    expect(verifyActivity).toHaveBeenCalledTimes(1);
    expect(result.current.agentActivity).not.toBe('idle');
  });

  // Regression: message after a prompting event does not clobber the verified timer.
  it('a message during a prompt keeps verifying DO state (timers do not fight)', async () => {
    const { result, verifyActivity } = setup('prompting');

    act(() => { result.current.onAgentActivity('prompting'); });
    act(() => { result.current.onAgentMessage(); });

    // After a full timeout the bar is still alive (verified, not blindly decayed).
    await advance();
    expect(verifyActivity).toHaveBeenCalled();
    expect(result.current.agentActivity).toBe('responding');
  });

  // Authoritative idle from the DO stops the timer immediately.
  it('onAgentActivity("idle") clears the timer and does not verify', async () => {
    const { result, verifyActivity } = setup('prompting');

    act(() => { result.current.onAgentActivity('prompting', 1000); });
    expect(result.current.promptStartedAt).toBe(1000);
    act(() => { result.current.onAgentActivity('idle'); });
    expect(result.current.agentActivity).toBe('idle');
    expect(result.current.promptStartedAt).toBeNull();

    await advance(IDLE_TIMEOUT_MS * 2);
    expect(verifyActivity).not.toHaveBeenCalled();
    expect(result.current.agentActivity).toBe('idle');
  });

  // Timer is cleared on session switch (no cross-session false idle / stale verify).
  it('clears the timer on session switch', async () => {
    const { result, rerender, verifyActivity } = setup('prompting');

    act(() => { result.current.onAgentActivity('prompting'); });

    // Switch sessions before the timer fires.
    rerender({ sid: 'sess-2' });

    await advance(IDLE_TIMEOUT_MS * 2);
    // The pre-switch timer was cleared/aborted, so no verify call leaked through.
    expect(verifyActivity).not.toHaveBeenCalled();
  });

  // Regression: a terminal idle (session stopped / agent completed) must cancel any pending
  // verify timer so it cannot re-arm and flash the status bar back on after the prompt ends.
  it('terminal idle cancels a pending verify timer (no flash-back-on)', async () => {
    const { result, verifyActivity } = setup('prompting');

    act(() => { result.current.onAgentActivity('prompting', 1000); });
    expect(result.current.agentActivity).toBe('prompting');

    // Session is stopped / agent completes while a verify timer is still armed.
    act(() => { result.current.onTerminalIdle(); });
    expect(result.current.agentActivity).toBe('idle');
    expect(result.current.promptStartedAt).toBeNull();

    // The previously-armed timer must NOT fire a verify or re-arm the bar.
    await advance(IDLE_TIMEOUT_MS * 2);
    expect(verifyActivity).not.toHaveBeenCalled();
    expect(result.current.agentActivity).toBe('idle');
  });

  // Verify failure decays to idle (fail-safe).
  it('decays to idle when the DO verify call fails', async () => {
    const { result } = setup(new Error('network'));

    act(() => { result.current.onAgentActivity('prompting'); });
    await advance();
    expect(result.current.agentActivity).toBe('idle');
  });
});
