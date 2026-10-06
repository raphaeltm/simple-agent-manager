/**
 * Live wake-progress broadcast for sleeping conversations.
 *
 * ## Why this exists
 *
 * Waking a sleeping VM conversation takes minutes. The durable record of that
 * wake lives entirely in D1 (`session_snapshots.recovery_status` plus the
 * replacement TaskRunner's `tasks.execution_step`), and this DO reads DO-local
 * SQLite — so before this module the browser could only discover wake progress by
 * polling the chat detail endpoint. The banner lagged a full poll interval behind
 * reality, which on a ~6-minute wake reads as "nothing is happening".
 *
 * This module is the push half: the TaskRunner driving the wake calls
 * `publishSessionWakeProgress` at each step transition, and connected clients get
 * the phase immediately over the socket they already hold.
 *
 * ## Deliberately not persisted here
 *
 * D1 stays the single source of truth. This broadcast is a live delta only, so a
 * client that missed it (offline, or mounted later) still rebuilds the exact same
 * state from `routes/chat/wake-state.ts` on its next hydrate. Persisting a mirror
 * copy in DO SQLite would add a second writer of the same fact and a DO migration
 * for no gain — see rule 44 on dual-write divergence.
 *
 * Both halves speak `TaskExecutionStep`, so a hydrate and a broadcast that race
 * cannot disagree about what a phase means.
 */

import type { TaskExecutionStep } from '@simple-agent-manager/shared';

/** Event name clients subscribe to. Additive — no existing event changes shape. */
export const SESSION_WAKE_PROGRESS_EVENT = 'session.wake_progress';

export type SessionWakeRecoveryStatus = 'waking' | 'restored' | 'failed';

export interface SessionWakeProgressInput {
  chatSessionId: string;
  recoveryStatus: SessionWakeRecoveryStatus;
  /** Null when the wake is claimed but the runner has not reported a step yet. */
  wakePhase?: TaskExecutionStep | null;
}

export interface SessionWakeProgressHooks {
  broadcastEvent(type: string, payload: Record<string, unknown>, sessionId?: string): void;
}

/**
 * Broadcast a wake phase transition to everyone watching this chat session.
 *
 * Scoped to `chatSessionId` so a wake in one conversation never renders a banner
 * in another. Callers are expected to be idempotent about *when* they call this
 * (the TaskRunner only calls it on a real step change); this function does not
 * dedupe, it just emits.
 */
export function publishSessionWakeProgress(
  hooks: SessionWakeProgressHooks,
  input: SessionWakeProgressInput,
  now: number
): void {
  hooks.broadcastEvent(
    SESSION_WAKE_PROGRESS_EVENT,
    {
      sessionId: input.chatSessionId,
      recoveryStatus: input.recoveryStatus,
      wakePhase: input.wakePhase ?? null,
      at: now,
    },
    input.chatSessionId
  );
}
