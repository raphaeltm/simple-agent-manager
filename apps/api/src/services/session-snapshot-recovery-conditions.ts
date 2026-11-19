/**
 * Row conditions shared by the snapshot recovery claim
 * (`session-snapshot-recovery-lifecycle.ts`) and the wake-outcome writers
 * (`session-snapshot-wake-outcome.ts`). Internal: not re-exported by the
 * `session-snapshots` barrel.
 */
import { and, eq, exists, isNotNull, not, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS } from './session-snapshot-artifacts';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Recovery-task statuses under which a VM wake is still in flight. The resumer
 * (`claimSessionSnapshotRecovery`) renews a stale `waking` claim only while its task
 * is in one of these, and the dead-wake sweep
 * (`scheduled/session-wake-claim-reconciliation.ts`) ends a claim only when its task
 * is in none of them. One list, so the two can never disagree (rule 58).
 */
export const LIVE_WAKE_TASK_STATUSES = [
  'queued',
  'delegated',
  'in_progress',
  'awaiting_followup',
] as const;

export function isLiveWakeTaskStatus(status: string): boolean {
  return (LIVE_WAKE_TASK_STATUSES as readonly string[]).includes(status);
}

/** SQL list literal of `LIVE_WAKE_TASK_STATUSES`, for raw D1 statements. */
export const LIVE_WAKE_TASK_STATUS_SQL = LIVE_WAKE_TASK_STATUSES.map((s) => `'${s}'`).join(', ');

/** How long a `waking` claim is honoured before it counts as stale. */
export function sessionRecoveryClaimLeaseMs(env: {
  SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS?: string;
}): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS
  );
}

export function restorableSnapshotCondition() {
  return or(
    and(
      eq(schema.sessionSnapshots.status, 'available'),
      eq(schema.sessionSnapshots.degradation, 'none')
    ),
    and(
      eq(schema.sessionSnapshots.status, 'degraded'),
      isNotNull(schema.sessionSnapshots.degradation),
      sql`${schema.sessionSnapshots.degradation} != 'none'`
    )
  );
}

export function archiveMigrationFenceCondition(db: Db, chatSessionId: string) {
  return not(
    exists(
      db
        .select({ sessionId: schema.projectDataSessionLocations.sessionId })
        .from(schema.projectDataSessionLocations)
        .where(
          and(
            eq(schema.projectDataSessionLocations.sessionId, chatSessionId),
            not(eq(schema.projectDataSessionLocations.locationState, 'root'))
          )
        )
    )
  );
}
