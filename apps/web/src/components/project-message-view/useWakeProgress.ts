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
 *
 * The settled latch (below) is per wake attempt. A conversation can wake, sleep and
 * wake again while the tab stays open, and the server names each wake attempt
 * (`wakeAttemptId`), so a snapshot of a different attempt is a new wake, while one of
 * the attempt that already settled is stale.
 */

import {
  EXECUTION_STEP_ORDER,
  type TaskExecutionStep,
  type WakeWaitReason,
} from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { WakeProgressUpdate } from '../../hooks/useChatWebSocket';
import type { SessionStateSnapshot } from '../../lib/api';

export type WakeRecoveryStatus = 'waking' | 'restored' | 'failed';

/** Why the wake is waiting, as reported by the server (`routes/chat/wake-state.ts`). */
export interface WakeWait {
  reason: WakeWaitReason;
  /** ISO time of the next retry, when one is scheduled. */
  retryAt: string | null;
}

export interface WakeProgressState {
  /** True while a wake is in flight — drives banner visibility. */
  isWaking: boolean;
  /** Current phase, or null if the wake is claimed but no step reported yet. */
  wakePhase: TaskExecutionStep | null;
  /** Why the wake is waiting. Never opens the banner by itself; only labels it. */
  wakeWait: WakeWait | null;
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
  const [wakeWait, setWakeWait] = useState<WakeWait | null>(null);

  /**
   * Latches once a wake reaches a terminal status, and remembers which attempt.
   *
   * A poll response is assembled server-side before the client reads it, so a
   * poll that started before the wake finished can land *after* the push that
   * already reported `restored`. Without this latch that stale snapshot re-opens
   * the banner on a session that has finished waking — the status-level twin of
   * the phase-ordering guard.
   *
   * The latch is scoped to the attempt that settled. A `waking` snapshot naming a
   * different attempt is the next wake of the same conversation and re-arms it.
   * Without an attempt id on either side the latch holds, as it did before ids
   * existed: a stale banner is worse than a missing one. Every wake claim writes an
   * id (`services/session-recovery.ts`), so only a claim made before the
   * `recovery_attempt_id` column existed can settle without one.
   */
  const settledRef = useRef<{ attemptId: string | null } | null>(null);
  /** The newest wake attempt a snapshot has named. Pushes carry no attempt id. */
  const lastAttemptIdRef = useRef<string | null>(null);

  // A wake belongs to exactly one conversation. Switching sessions must not carry
  // the previous conversation's banner across.
  useEffect(() => {
    setIsWaking(false);
    setWakePhase(null);
    setWakeWait(null);
    settledRef.current = null;
    lastAttemptIdRef.current = null;
  }, [sessionId]);

  const clearWakeProgress = useCallback(() => {
    setIsWaking(false);
    setWakePhase(null);
    setWakeWait(null);
  }, []);

  const applyStatus = useCallback(
    (
      status: WakeRecoveryStatus | null | undefined,
      phase: TaskExecutionStep | null,
      attemptId?: string | null
    ): boolean => {
      if (attemptId) {
        // Attempt ids are ULIDs, so they sort by creation time. A snapshot naming an
        // older attempt than one already seen is a stale poll: it must not end or
        // restart the newer wake.
        if (lastAttemptIdRef.current && attemptId < lastAttemptIdRef.current) return false;
        lastAttemptIdRef.current = attemptId;
      }
      if (status !== 'waking') {
        // 'restored' and 'failed' are both terminal for the banner. A failure
        // surfaces through the existing resume-error path, not this indicator.
        if (status === 'restored' || status === 'failed') {
          settledRef.current = { attemptId: attemptId ?? lastAttemptIdRef.current };
        }
        setIsWaking(false);
        setWakePhase(null);
        setWakeWait(null);
        return true;
      }
      const settled = settledRef.current;
      if (settled) {
        // A late 'waking' snapshot cannot un-finish a wake that already settled; a
        // snapshot of a different attempt is a new wake and re-arms the latch.
        const newAttempt = !!attemptId && !!settled.attemptId && attemptId !== settled.attemptId;
        if (!newAttempt) return false;
        settledRef.current = null;
        setWakePhase(null);
      }
      setIsWaking(true);
      setWakePhase((current) => (isForwardProgress(phase, current) ? phase : current));
      return true;
    },
    []
  );

  const hydrateWakeProgress = useCallback(
    (state: SessionStateSnapshot | null | undefined) => {
      if (!state) return;
      const applied = applyStatus(
        state.recoveryStatus ?? null,
        state.wakePhase ?? null,
        state.wakeAttemptId
      );
      // A snapshot the latch rejected as stale must not relabel the current wake either.
      if (!applied) return;
      // Only the pull path carries the reason. A pushed phase can outdate it, so the
      // banner shows it only for the phase it describes (`WakeProgressBanner`).
      setWakeWait(
        state.waitReason ? { reason: state.waitReason, retryAt: state.waitRetryAt ?? null } : null
      );
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
    wakeWait,
    hydrateWakeProgress,
    applyWakeProgress,
    clearWakeProgress,
  };
}
