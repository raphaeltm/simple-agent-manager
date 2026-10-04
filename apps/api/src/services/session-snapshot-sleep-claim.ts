/**
 * The sleep claim: the D1 compare-and-set that hands one owner a session's sleep
 * attempt (`preparing`) or the roll-forward of an interrupted teardown
 * (`stopping`). Split out of `session-snapshot-sleep-lifecycle.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
  type SessionSnapshotSleepClaim,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SnapshotLeaseEnv = Env & {
  SESSION_SLEEP_CLAIM_LEASE_MS?: string;
  SESSION_SLEEP_MAX_ATTEMPTS?: string;
};

function sessionSleepClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
  );
}

export async function claimSessionSnapshotSleep(
  db: Db,
  env: Env,
  input: {
    chatSessionId: string;
    claimId: string;
    now?: Date;
    force?: boolean;
  }
): Promise<SessionSnapshotSleepClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - sessionSleepClaimLeaseMs(env)).toISOString();
  const maxAttempts = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const repairableStrandedFailure = and(
    eq(schema.sessionSnapshots.sleepStatus, 'failed'),
    or(isNull(schema.sessionSnapshots.sleepAfter), lte(schema.sessionSnapshots.sleepAfter, nowIso)),
    or(
      eq(schema.sessionSnapshots.status, 'degraded'),
      isNotNull(schema.sessionSnapshots.captureGeneration)
    )
  );
  const dueCondition = input.force
    ? or(
        isNull(schema.sessionSnapshots.sleepStatus),
        inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed'])
      )
    : or(
        and(
          inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed']),
          lte(schema.sessionSnapshots.sleepAfter, nowIso)
        ),
        and(
          eq(schema.sessionSnapshots.sleepStatus, 'failed'),
          isNull(schema.sessionSnapshots.sleepAfter),
          lt(schema.sessionSnapshots.sleepAttempts, maxAttempts)
        ),
        repairableStrandedFailure
      );
  // A final verified snapshot is produced inside sleepWorkspaceSession. Pending,
  // degraded, and failed captures must therefore remain claimable; requiring an
  // already-perfect snapshot here strands precisely the sessions the final
  // capture is meant to repair. Explicit sleep may also replace expired state.
  const claimableSnapshotCondition = inArray(
    schema.sessionSnapshots.status,
    input.force
      ? ['pending', 'available', 'degraded', 'failed', 'expired']
      : ['pending', 'available', 'degraded', 'failed']
  );
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'preparing',
      sleepAfter: null,
      sleepClaimId: input.claimId,
      sleepClaimedAt: nowIso,
      sleepAttempts: sql`${schema.sessionSnapshots.sleepAttempts} + 1`,
      sleepError: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        claimableSnapshotCondition,
        isNull(schema.sessionSnapshots.sleepingAt),
        or(lt(schema.sessionSnapshots.sleepAttempts, maxAttempts), repairableStrandedFailure),
        or(
          dueCondition,
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
            or(
              isNull(schema.sessionSnapshots.sleepClaimedAt),
              lte(schema.sessionSnapshots.sleepClaimedAt, staleBefore)
            )
          )
        )
      )
    );
  if ((result.meta.changes ?? 0) > 0) {
    return { status: 'claimed', claimId: input.claimId, phase: 'preparing' };
  }

  // `stopping` is the point of no return: a crashed owner is reclaimed and
  // rolled forward without consuming the pre-teardown retry budget.
  const stopping = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepClaimId: input.claimId,
      sleepClaimedAt: nowIso,
      sleepStoppingSince: sql`COALESCE(${schema.sessionSnapshots.sleepStoppingSince}, ${schema.sessionSnapshots.sleepClaimedAt}, ${schema.sessionSnapshots.updatedAt}, ${schema.sessionSnapshots.createdAt}, ${nowIso})`,
      sleepAfter: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
        or(
          lte(schema.sessionSnapshots.sleepAfter, nowIso),
          isNull(schema.sessionSnapshots.sleepClaimedAt),
          lte(schema.sessionSnapshots.sleepClaimedAt, staleBefore)
        )
      )
    );
  if ((stopping.meta.changes ?? 0) > 0) {
    return { status: 'claimed', claimId: input.claimId, phase: 'stopping' };
  }

  const snapshot = await db
    .select({
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepClaimId: schema.sessionSnapshots.sleepClaimId,
      sleepAttempts: schema.sessionSnapshots.sleepAttempts,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .get();
  if (snapshot?.sleepClaimId === input.claimId && snapshot.sleepStatus === 'preparing') {
    return { status: 'claimed', claimId: input.claimId, phase: 'preparing' };
  }
  if (snapshot?.sleepClaimId === input.claimId && snapshot.sleepStatus === 'stopping') {
    return { status: 'claimed', claimId: input.claimId, phase: 'stopping' };
  }
  const reason = !snapshot
    ? 'snapshot_missing'
    : snapshot.sleepingAt
      ? 'already_sleeping'
      : snapshot.status !== 'available' && snapshot.status !== 'degraded'
        ? 'snapshot_not_complete'
        : snapshot.sleepAttempts >= maxAttempts
          ? 'sleep_attempts_exhausted'
          : 'sleep_claim_unavailable';
  return { status: 'unavailable', reason };
}
