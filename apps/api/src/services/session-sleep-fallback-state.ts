/**
 * Durable D1 transitions of the bounded sleep-failure episode
 * (`session-sleep-episode.ts`). Every write is a compare-and-set on the state its
 * caller observed, so a duplicate sweep, a late capture completion, or a follow-up
 * message that changed the row in between makes it a no-op instead of a clobber.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  sessionLifecycleError,
} from './session-snapshot-artifacts';
import {
  deleteAbandonedSessionSnapshotObjects,
  sessionSnapshotCaptureKeys,
} from './session-snapshot-capture-cleanup';
import { TERMINAL_SESSION_SLEEP_STATUS } from './session-snapshot-sleep-failure';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Abandon a capture generation that is still in flight. Its `/progress`, artifact and
 * `/complete` callbacks then get 409 (generation no longer current), so a late upload
 * from a slow or pre-fix agent cannot change the recovery point the fallback is about
 * to rely on. Objects it uploaded are deleted; the completed generation's recorded keys
 * are always kept. Returns false when the capture already finished or was replaced.
 */
export async function abandonSessionSnapshotCapture(
  db: Db,
  env: Env,
  input: { chatSessionId: string; generation: string; now?: Date }
): Promise<boolean> {
  const snapshots = schema.sessionSnapshots;
  const result = await db
    .update(snapshots)
    .set({
      captureGeneration: null,
      captureError: null,
      authorizedHomeBytes: null,
      authorizedHomeSha256: null,
      authorizedWipBytes: null,
      authorizedWipSha256: null,
      updatedAt: (input.now ?? new Date()).toISOString(),
    })
    .where(
      and(
        eq(snapshots.chatSessionId, input.chatSessionId),
        eq(snapshots.captureGeneration, input.generation)
      )
    );
  if ((result.meta.changes ?? 0) === 0) return false;
  const recorded = await db
    .select({
      homeR2Key: snapshots.homeR2Key,
      wipR2Key: snapshots.wipR2Key,
      manifestR2Key: snapshots.manifestR2Key,
    })
    .from(snapshots)
    .where(eq(snapshots.chatSessionId, input.chatSessionId))
    .get();
  await deleteAbandonedSessionSnapshotObjects(env, {
    chatSessionId: input.chatSessionId,
    generation: input.generation,
    keys: sessionSnapshotCaptureKeys(env, input.chatSessionId, input.generation),
    keep: [recorded?.homeR2Key, recorded?.wipR2Key, recorded?.manifestR2Key],
  });
  return true;
}

/**
 * Cross the fallback's point of no return: `preparing` → `stopping`, recording the
 * fallback decision in the same write. Requires the claim this caller holds, the exact
 * recovery-point generation it verified, and no capture in flight — so a capture that
 * completed in the meantime (possibly a complete one) wins and the fallback re-decides.
 */
export async function beginSessionSnapshotFallbackStopping(
  db: Db,
  input: {
    chatSessionId: string;
    claimId: string;
    generation: string;
    status: string;
    degradation: string;
    recordJson: string;
    now?: Date;
  }
): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const snapshots = schema.sessionSnapshots;
  const result = await db
    .update(snapshots)
    .set({
      sleepStatus: 'stopping',
      sleepAfter: null,
      sleepClaimedAt: nowIso,
      sleepStoppingSince: sql`COALESCE(${snapshots.sleepStoppingSince}, ${nowIso})`,
      sleepFallbackJson: input.recordJson,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(snapshots.chatSessionId, input.chatSessionId),
        eq(snapshots.sleepStatus, 'preparing'),
        eq(snapshots.sleepClaimId, input.claimId),
        eq(snapshots.snapshotGeneration, input.generation),
        eq(snapshots.status, input.status),
        eq(snapshots.degradation, input.degradation),
        isNull(snapshots.captureGeneration),
        isNull(snapshots.sleepingAt)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Step back from `stopping` when the transcript could not take the fallback notice.
 * Safe only before any teardown I/O: nothing irreversible has happened yet. Counts as a
 * failed attempt, so a transcript store that stays down ends the episode at the ceiling.
 */
export async function revertSessionSnapshotFallbackStopping(
  db: Db,
  env: Env,
  input: { chatSessionId: string; claimId: string; error: string; now?: Date }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const retryDelayMs = parsePositiveInt(
    env.SESSION_SLEEP_RETRY_DELAY_MS,
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
  );
  const snapshots = schema.sessionSnapshots;
  const result = await db
    .update(snapshots)
    .set({
      sleepStatus: 'failed',
      sleepAfter: new Date(now.getTime() + retryDelayMs).toISOString(),
      sleepError: sessionLifecycleError(env, input.error),
      sleepEpisodeFailures: sql`COALESCE(${snapshots.sleepEpisodeFailures}, 0) + 1`,
      sleepFallbackJson: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(snapshots.chatSessionId, input.chatSessionId),
        eq(snapshots.sleepStatus, 'stopping'),
        eq(snapshots.sleepClaimId, input.claimId),
        isNull(snapshots.sleepingAt)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

/** Which writer is ending the episode, and the exact state it observed. */
export type BlockedEpisodeExpectation =
  | { kind: 'claim'; claimId: string }
  | { kind: 'observed'; sleepStatus: string | null; sleepEpisodeFailures: number };

/**
 * End the episode blocked: no retry, no teardown, the decision recorded for the chat
 * notice and for diagnosis. Leaves the shape every "gave up" reader expects
 * (`isSessionSleepExhausted`: `terminal_failed`, no retry time).
 */
export async function blockSessionSleepEpisode(
  db: Db,
  env: Env,
  input: {
    chatSessionId: string;
    recordJson: string;
    error: string;
    expected: BlockedEpisodeExpectation;
    now?: Date;
  }
): Promise<boolean> {
  const snapshots = schema.sessionSnapshots;
  const expectation =
    input.expected.kind === 'claim'
      ? and(
          eq(snapshots.sleepStatus, 'preparing'),
          eq(snapshots.sleepClaimId, input.expected.claimId)
        )
      : and(
          sql`${snapshots.sleepStatus} IS ${input.expected.sleepStatus}`,
          sql`COALESCE(${snapshots.sleepEpisodeFailures}, 0) = ${input.expected.sleepEpisodeFailures}`,
          sql`${snapshots.sleepStatus} IS NOT 'stopping'`
        );
  const result = await db
    .update(snapshots)
    .set({
      sleepStatus: TERMINAL_SESSION_SLEEP_STATUS,
      sleepAfter: null,
      sleepError: sessionLifecycleError(env, input.error),
      sleepFallbackJson: input.recordJson,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: (input.now ?? new Date()).toISOString(),
    })
    .where(
      and(
        eq(snapshots.chatSessionId, input.chatSessionId),
        isNull(snapshots.sleepingAt),
        expectation
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Workspace states in which a sleep intent can never run: nothing is left to snapshot
 * or stop. A `stopping` intent is retired only once its workspace is `deleted`, because
 * a stopped or errored workspace may still be finished by the roll-forward.
 */
const DEAD_WORKSPACE_STATUSES = ['stopped', 'deleted', 'error'] as const;

export function isDeadSleepIntentWorkspace(
  sleepStatus: string | null,
  workspaceStatus: string | null
): boolean {
  if (!workspaceStatus) return false;
  if (sleepStatus === 'stopping') return workspaceStatus === 'deleted';
  return (DEAD_WORKSPACE_STATUSES as readonly string[]).includes(workspaceStatus);
}

/**
 * Retire a sleep intent whose workspace is gone, so the sweep stops re-selecting it
 * forever (11 such intents re-deferred every five minutes in production on 2026-10-04,
 * some since August). The intent is cleared rather than terminalized: a stopped or
 * errored workspace can be restarted, and a restarted one must get a fresh intent from
 * `reconcileUnscheduledSessionSleeps`. Snapshot artifacts and recovery state are kept.
 */
export async function retireDeadWorkspaceSleepIntent(
  db: Db,
  input: {
    snapshotId: string;
    workspaceId: string;
    workspaceStatus: string;
    sleepStatus: string | null;
    sleepAttempts: number;
    now: Date;
  }
): Promise<boolean> {
  const snapshots = schema.sessionSnapshots;
  const result = await db
    .update(snapshots)
    .set({
      sleepStatus: null,
      sleepAfter: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      sleepEpisodeStartedAt: null,
      sleepEpisodeFailures: 0,
      sleepError: `Sleep intent retired: workspace is ${input.workspaceStatus}`,
      updatedAt: input.now.toISOString(),
    })
    .where(
      and(
        eq(snapshots.id, input.snapshotId),
        eq(snapshots.workspaceId, input.workspaceId),
        sql`${snapshots.sleepStatus} IS ${input.sleepStatus}`,
        eq(snapshots.sleepAttempts, input.sleepAttempts),
        isNull(snapshots.sleepingAt),
        sql`EXISTS (SELECT 1 FROM ${schema.workspaces}
          WHERE ${schema.workspaces.id} = ${input.workspaceId}
            AND ${schema.workspaces.status} = ${input.workspaceStatus})`
      )
    );
  return (result.meta.changes ?? 0) > 0;
}
