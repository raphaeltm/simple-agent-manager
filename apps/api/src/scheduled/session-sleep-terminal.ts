import { and, eq, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { TERMINAL_SESSION_SLEEP_STATUS } from '../services/session-snapshot-sleep-failure';
export { TERMINAL_SESSION_SLEEP_STATUS } from '../services/session-snapshot-sleep-failure';

type SleepIntentCandidate = {
  snapshotId: string;
  workspaceId: string | null;
  userId: string;
  sleepStatus: string | null;
  sleepClaimId: string | null;
  sleepClaimedAt: string | null;
  sleepAfter: string | null;
  sleepAttempts: number;
  status: string;
  captureGeneration: string | null;
  updatedAt: string;
};

export async function terminalizeMissingSleepSource(
  db: ReturnType<typeof drizzle<typeof schema>>,
  candidate: SleepIntentCandidate,
  now: Date
): Promise<boolean> {
  // Retire only the obsolete sleep intent. Snapshot artifacts and recovery state
  // must survive. A wake, new capture, claim renewal, or metadata repair wins
  // over this stale sweep observation.
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: TERMINAL_SESSION_SLEEP_STATUS,
      sleepAfter: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      sleepError: candidate.workspaceId
        ? 'Workspace metadata missing during automatic sleep'
        : 'Snapshot has no source workspace',
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.id, candidate.snapshotId),
        sql`${schema.sessionSnapshots.workspaceId} IS ${candidate.workspaceId}`,
        sql`${schema.sessionSnapshots.sleepStatus} IS ${candidate.sleepStatus}`,
        sql`${schema.sessionSnapshots.sleepClaimId} IS ${candidate.sleepClaimId}`,
        sql`${schema.sessionSnapshots.sleepClaimedAt} IS ${candidate.sleepClaimedAt}`,
        sql`${schema.sessionSnapshots.sleepAfter} IS ${candidate.sleepAfter}`,
        eq(schema.sessionSnapshots.sleepAttempts, candidate.sleepAttempts),
        eq(schema.sessionSnapshots.status, candidate.status),
        sql`${schema.sessionSnapshots.captureGeneration} IS ${candidate.captureGeneration}`,
        eq(schema.sessionSnapshots.updatedAt, candidate.updatedAt),
        isNull(schema.sessionSnapshots.sleepingAt),
        sql`NOT EXISTS (SELECT 1 FROM ${schema.workspaces}
      WHERE ${schema.workspaces.id} = ${candidate.workspaceId}
        AND ${schema.workspaces.userId} = ${candidate.userId}
        AND ${schema.workspaces.projectId} IS NOT NULL
        AND ${schema.workspaces.chatSessionId} IS NOT NULL)`
      )
    );
  return (result.meta.changes ?? 0) > 0;
}
