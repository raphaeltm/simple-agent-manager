/**
 * Bounded maintenance for agent secret requests.
 *
 * Five-minute cron sweep (`runRuntimeSecretRequestSweep`):
 * - marks pending requests past their deadline `expired` and tells each requesting agent, so no
 *   agent waits forever. Each selected row leaves the candidate set through the compare-and-set,
 *   whether or not its notice is queued (`.claude/rules/47`);
 * - retries an outcome notice that could not be queued (`notified_at IS NULL`), only within
 *   `secrets.notifyRetryMinutes` of the outcome, so a permanently failing target ages out.
 * Both steps together touch at most `secrets.expirySweepBatchSize` rows, and each row costs one
 * D1 write and one ProjectData RPC, which keeps a tick within the background I/O budget
 * (`.claude/rules/60`). An idle tick is two indexed reads that return nothing.
 *
 * Daily purge (`purgeRuntimeSecretMaterial`): deletes collected values whose TTL has passed
 * (readers already refuse them, see `projectRuntimeEnvUnexpired`) and finished request records
 * older than the retention window that no remaining value points at. It repeats batches of
 * `secrets.sweepBatchSize` until nothing is left or `secrets.purgeBudgetSeconds` runs out:
 * at the defaults (50 rows per statement, tens of milliseconds per statement) that is several
 * thousand rows per day, and an unfinished backlog continues the next day (`.claude/rules/81`).
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte, ne, notExists } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getRuntimeSecretRequestLimits } from './runtime-secret-request-settings';
import { notifyAgent } from './runtime-secret-requests';

export interface RuntimeSecretRequestSweepStats {
  expired: number;
  agentsNotified: number;
  noticesRetried: number;
}

type Outcome = 'fulfilled' | 'declined' | 'expired';

function outcomeOf(status: string): Outcome | null {
  return status === 'fulfilled' || status === 'declined' || status === 'expired' ? status : null;
}

/**
 * Grace before the sweep retries a notice, so it never races the request handler's own first
 * attempt. A fixed ordering margin, not a tunable: it only has to exceed one request's duration,
 * and the delivery id makes a duplicate attempt harmless either way.
 */
const NOTICE_RETRY_GRACE_MS = 60_000;

export async function runRuntimeSecretRequestSweep(
  env: Env,
  now = Date.now()
): Promise<RuntimeSecretRequestSweepStats> {
  const db = drizzle(env.DATABASE, { schema });
  const limits = await getRuntimeSecretRequestLimits(env);
  let budget = limits.expirySweepBatchSize;
  let expired = 0;
  let agentsNotified = 0;
  let noticesRetried = 0;

  const due = await db
    .select()
    .from(schema.runtimeSecretRequests)
    .where(
      and(
        eq(schema.runtimeSecretRequests.status, 'pending'),
        lte(schema.runtimeSecretRequests.expiresAt, now)
      )
    )
    .orderBy(schema.runtimeSecretRequests.expiresAt)
    .limit(budget);
  for (const row of due) {
    const claimed = await db
      .update(schema.runtimeSecretRequests)
      .set({ status: 'expired', resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.runtimeSecretRequests.id, row.id),
          eq(schema.runtimeSecretRequests.status, 'pending')
        )
      )
      .returning({ id: schema.runtimeSecretRequests.id });
    if (claimed.length !== 1) continue;
    expired += 1;
    const resolved = { ...row, status: 'expired', resolvedAt: now, updatedAt: now };
    if (await notifyAgent(env, db, resolved, 'expired', null)) agentsNotified += 1;
  }
  budget -= due.length;

  if (budget > 0) {
    const unnotified = await db
      .select({ request: schema.runtimeSecretRequests, resolverName: schema.users.name })
      .from(schema.runtimeSecretRequests)
      .leftJoin(schema.users, eq(schema.users.id, schema.runtimeSecretRequests.resolvedBy))
      .where(
        and(
          isNull(schema.runtimeSecretRequests.notifiedAt),
          ne(schema.runtimeSecretRequests.status, 'pending'),
          gt(schema.runtimeSecretRequests.resolvedAt, now - limits.notifyRetryMinutes * 60_000),
          lte(schema.runtimeSecretRequests.resolvedAt, now - NOTICE_RETRY_GRACE_MS)
        )
      )
      .orderBy(schema.runtimeSecretRequests.resolvedAt)
      .limit(budget);
    for (const { request, resolverName } of unnotified) {
      const outcome = outcomeOf(request.status);
      if (!outcome) continue;
      // Same delivery id as the first attempt, so a notice that did land is not duplicated.
      if (await notifyAgent(env, db, request, outcome, resolverName ?? null)) noticesRetried += 1;
    }
  }

  if (expired > 0 || noticesRetried > 0) {
    log.info('runtime_secret_request.sweep', { expired, agentsNotified, noticesRetried });
  }
  return { expired, agentsNotified, noticesRetried };
}

export interface RuntimeSecretPurgeStats {
  valuesPurged: number;
  requestsPurged: number;
  /** True when the time budget ran out with rows still to delete; tomorrow's run continues. */
  incomplete: boolean;
}

export async function purgeRuntimeSecretMaterial(
  env: Env,
  now = Date.now()
): Promise<RuntimeSecretPurgeStats> {
  const db = drizzle(env.DATABASE, { schema });
  const limits = await getRuntimeSecretRequestLimits(env);
  const deadline = Date.now() + limits.purgeBudgetSeconds * 1_000;
  const retentionCutoff = now - limits.historyRetentionDays * 86_400_000;
  let valuesPurged = 0;
  let requestsPurged = 0;

  // Ids first, then delete by id: D1 has no DELETE ... LIMIT, and the batch bounds each write.
  const purgeValues = async (): Promise<number> => {
    const ids = (
      await db
        .select({ id: schema.projectRuntimeEnvVars.id })
        .from(schema.projectRuntimeEnvVars)
        .where(
          and(
            isNotNull(schema.projectRuntimeEnvVars.expiresAt),
            lte(schema.projectRuntimeEnvVars.expiresAt, now)
          )
        )
        .limit(limits.sweepBatchSize)
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    // Re-check expiry in the delete: a manual write in between clears it and keeps the row.
    await db
      .delete(schema.projectRuntimeEnvVars)
      .where(
        and(
          inArray(schema.projectRuntimeEnvVars.id, ids),
          lte(schema.projectRuntimeEnvVars.expiresAt, now)
        )
      );
    return ids.length;
  };

  const purgeRequests = async (): Promise<number> => {
    const ids = (
      await db
        .select({ id: schema.runtimeSecretRequests.id })
        .from(schema.runtimeSecretRequests)
        .where(
          and(
            isNotNull(schema.runtimeSecretRequests.resolvedAt),
            lte(schema.runtimeSecretRequests.resolvedAt, retentionCutoff),
            // Keep the record while a value it supplied still exists: it is that value's
            // provenance.
            notExists(
              db
                .select({ id: schema.projectRuntimeEnvVars.id })
                .from(schema.projectRuntimeEnvVars)
                .where(
                  eq(schema.projectRuntimeEnvVars.secretRequestId, schema.runtimeSecretRequests.id)
                )
            )
          )
        )
        .limit(limits.sweepBatchSize)
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    await db
      .delete(schema.runtimeSecretRequests)
      .where(
        and(
          inArray(schema.runtimeSecretRequests.id, ids),
          lte(schema.runtimeSecretRequests.resolvedAt, retentionCutoff)
        )
      );
    return ids.length;
  };

  let valuesDone = false;
  let requestsDone = false;
  while (Date.now() < deadline && !(valuesDone && requestsDone)) {
    if (!valuesDone) {
      const deleted = await purgeValues();
      valuesPurged += deleted;
      valuesDone = deleted < limits.sweepBatchSize;
    }
    // Values first: a value deleted above may release its request record in the same run.
    if (valuesDone && !requestsDone && Date.now() < deadline) {
      const deleted = await purgeRequests();
      requestsPurged += deleted;
      requestsDone = deleted < limits.sweepBatchSize;
    }
  }
  const stats = { valuesPurged, requestsPurged, incomplete: !(valuesDone && requestsDone) };
  log.info('runtime_secret_request.purge_completed', stats);
  return stats;
}
