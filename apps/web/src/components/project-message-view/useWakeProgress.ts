/**
 * Wake-progress state for a sleeping conversation.
 *
 * Extracted from `useSessionLifecycle` (which is at the 800-line hard ceiling —
 * rule 18) and, more importantly, because wake progress has a genuinely different
 * lifetime from agent activity: it is owned by a *replacement* TaskRunner that the
 * user's browser has no direct connection to.
 *
 * ## Two inputs, one truth
 *
 * The same phase arrives by two routes and they must not fight:
 *
 *  - **hydrate** — `SessionStateSnapshot.wakePhase`, read from D1 on mount and on
 *    every fallback poll. Survives navigation; that is what PR #1865 fixed.
 *  - **push** — the `session.wake_progress` socket event, which arrives within
 *    milliseconds of the real transition instead of up to a poll interval late.
 *
 * Push wins while it is fresher, because a hydrate can legitimately carry a
 * *staler* phase than a push that has already landed: the poll response may have
 * been assembled before the runner advanced. Ordering is resolved by
 * `EXECUTION_STEP_ORDER` — wake phases only ever move forward within one wake, so
 * a lower-ordered value arriving after a higher-ordered one is stale data, not a
 * regression, and is dropped.
 *
 * State resets on `sessionId` change so one conversation's wake can never paint a
 * banner over another's.
 */

import { EXECUTION_STEP_ORDER, type TaskExecutionStep } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { WakeProgressUpdate } from '../../hooks/useChatWebSocket';
import type { SessionStateSnapshot } from '../../lib/api';

export type WakeRecoveryStatus = 'waking' | 'restored' | 'failed';

export interface WakeProgressState {
  /** True while a wake is in flight — drives banner visibility. */
  isWaking: boolean;
  /** Current phase, or null if the wake is claimed but no step reported yet. */
  wakePhase: TaskExecutionStep | null;
}

export interface UseWakeProgressReturn extends WakeProgressState {
  /** Fold a server snapshot (mount hydrate or poll) into wake state. */
  hydrateWakeProgress: (state: SessionStateSnapshot | null | undefined) => void;
  /** Apply a pushed `session.wake_progress` delta. */
  applyWakeProgress: (update: WakeProgressUpdate) => void;
  /** Clear wake state — called when the session leaves `sleeping`. */
  clearWakeProgress: () => void;
}

function isForwardProgress(
  next: TaskExecutionStep | null,
  current: TaskExecutionStep | null
): boolean {
  if (next === null) return current === null;
  if (current === null) return true;
  return EXECUTION_STEP_ORDER[next] >= EXECUTION_STEP_ORDER[current];
}

export function useWakeProgress(sessionId: string | undefined): UseWakeProgressReturn {
  const [isWaking, setIsWaking] = useState(false);
  const [wakePhase, setWakePhase] = useState<TaskExecutionStep | null>(null);

  /**
   * Latches once this wake reaches a terminal status.
   *
   * A poll response is assembled server-side before the client reads it, so a
   * poll that started before the wake finished can land *after* the push that
   * already reported `restored`. Without this latch that stale snapshot re-opens
   * the banner on a session that has finished waking — the status-level twin of
   * the phase-ordering guard.
   */
  const settledRef = useRef(false);

  // A wake belongs to exactly one conversation. Switching sessions must not carry
  // the previous conversation's banner across.
  useEffect(() => {
    setIsWaking(false);
    setWakePhase(null);
    settledRef.current = false;
  }, [sessionId]);

  const clearWakeProgress = useCallback(() => {
    setIsWaking(false);
    setWakePhase(null);
  }, []);

  const applyStatus = useCallback(
    (status: WakeRecoveryStatus | null | undefined, phase: TaskExecutionStep | null) => {
      if (status !== 'waking') {
        // 'restored' and 'failed' are both terminal for the banner. A failure
        // surfaces through the existing resume-error path, not this indicator.
        if (status === 'restored' || status === 'failed') settledRef.current = true;
        setIsWaking(false);
        setWakePhase(null);
        return;
      }
      // A late 'waking' snapshot cannot un-finish a wake that already settled.
      if (settledRef.current) return;
      setIsWaking(true);
      setWakePhase((current) => (isForwardProgress(phase, current) ? phase : current));
    },
    []
  );

  const hydrateWakeProgress = useCallback(
    (state: SessionStateSnapshot | null | undefined) => {
      if (!state) return;
      applyStatus(state.recoveryStatus ?? null, state.wakePhase ?? null);
    },
    [applyStatus]
  );

  const applyWakeProgress = useCallback(
    (update: WakeProgressUpdate) => {
      applyStatus(update.recoveryStatus, update.wakePhase);
    },
    [applyStatus]
  );

  return {
    isWaking,
    wakePhase,
    hydrateWakeProgress,
    applyWakeProgress,
    clearWakeProgress,
  };
}
