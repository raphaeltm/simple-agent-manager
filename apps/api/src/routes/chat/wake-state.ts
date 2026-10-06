/**
 * Wake progress hydration for the chat session detail endpoint.
 *
 * A sleeping VM conversation is woken by a replacement TaskRunner. Two D1 rows
 * describe that wake:
 *
 *   session_snapshots.recovery_status   -- 'waking' | 'restored' | 'failed'
 *   tasks.execution_step                -- which phase the replacement runner is in
 *
 * The ProjectData DO cannot serve either one: `getSessionState()` reads DO-local
 * SQLite, and both of these live in D1. So the detail route reads them here and
 * folds them into the `SessionStateSnapshot` the client hydrates from on mount.
 *
 * This is the *pull* half of wake visibility, and it is what makes the wake banner
 * survive a navigate-away-and-back (PR #1865). The *push* half — live phase deltas
 * without waiting for a poll — is `session.wake_progress`, broadcast from
 * `durable-objects/project-data/session-wake-progress.ts`.
 *
 * Both halves report the same vocabulary (`TaskExecutionStep`), so a hydrate and a
 * broadcast that race cannot disagree about what phase means.
 */

import { isTaskExecutionStep, type SessionStateSnapshot } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';

type Db = DrizzleD1Database<typeof schema>;

export type SessionRecoveryStatus = 'waking' | 'restored' | 'failed';

function isRecoveryStatus(value: unknown): value is SessionRecoveryStatus {
  return value === 'waking' || value === 'restored' || value === 'failed';
}

/**
 * Empty state used when a sleeping session has recovery info in D1 but the DO has
 * no persisted activity row to merge it into (e.g. the DO was evicted, or the
 * session never produced VM-side activity). Without this the recovery status would
 * be silently dropped and the banner would not render on mount.
 */
const EMPTY_STATE: SessionStateSnapshot = {
  activity: 'idle',
  activityAt: 0,
  statusError: null,
  currentPlan: null,
  planUpdatedAt: null,
  promptStartedAt: null,
  agentType: null,
  lastStopReason: null,
  runtimeWorkState: null,
  runtimeWorkCount: null,
  runtimeWorkSource: null,
  runtimeWorkUpdatedAt: null,
  runtimeWorkProgressAt: null,
};

/**
 * Fold D1 wake progress into a DO-sourced session state snapshot.
 *
 * Single D1 round-trip: a LEFT JOIN from `session_snapshots` to `tasks` via
 * `recovery_task_id`, replacing the pre-existing standalone snapshot SELECT. The
 * endpoint's round-trip count is therefore unchanged (rule 60).
 *
 * Non-fatal by construction: a malformed row, a missing join target, or a D1
 * failure degrades to "no wake info" and the caller returns the session without
 * it. A wake indicator is never worth a 500 on the session detail route
 * (rule 50).
 */
export async function attachWakeState(
  db: Db,
  state: SessionStateSnapshot | null,
  args: { projectId: string; sessionId: string; sessionStatus: unknown }
): Promise<SessionStateSnapshot | null> {
  if (args.sessionStatus !== 'sleeping') return state;

  try {
    const [row] = await db
      .select({
        recoveryStatus: schema.sessionSnapshots.recoveryStatus,
        executionStep: schema.tasks.executionStep,
      })
      .from(schema.sessionSnapshots)
      .leftJoin(schema.tasks, eq(schema.tasks.id, schema.sessionSnapshots.recoveryTaskId))
      .where(eq(schema.sessionSnapshots.chatSessionId, args.sessionId))
      .limit(1);

    if (!row) return state;

    const recoveryStatus = isRecoveryStatus(row.recoveryStatus) ? row.recoveryStatus : null;
    if (!recoveryStatus) return state;

    // Only a wake that is actually in flight has a meaningful phase. A 'restored'
    // or 'failed' snapshot keeps whatever step the finished recovery task last
    // wrote, which would otherwise render as stale progress on a settled session.
    const wakePhase =
      recoveryStatus === 'waking' && isTaskExecutionStep(row.executionStep)
        ? row.executionStep
        : null;

    return { ...(state ?? EMPTY_STATE), recoveryStatus, wakePhase };
  } catch (err) {
    log.warn('chat.recovery_status_lookup_failed', {
      projectId: args.projectId,
      sessionId: args.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return state;
  }
}
