/**
 * Row conditions shared by the snapshot recovery claim
 * (`session-snapshot-recovery-lifecycle.ts`) and the wake-outcome writers
 * (`session-snapshot-wake-outcome.ts`). Internal: not re-exported by the
 * `session-snapshots` barrel.
 */
import { and, eq, exists, isNotNull, not, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

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
