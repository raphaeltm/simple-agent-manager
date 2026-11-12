/**
 * Bounded maintenance for agent secret requests.
 *
 * - `expireRuntimeSecretRequests` (5-minute cron sweep): marks pending requests past their
 *   deadline `expired` and tells each requesting agent, so no agent waits forever. Each selected
 *   row leaves the candidate set through the compare-and-set, whether or not the wake is queued
 *   (`.claude/rules/47`).
 * - `purgeRuntimeSecretMaterial` (daily cron): deletes collected values whose TTL has passed
 *   (readers already refuse them, see `projectRuntimeEnvUnexpired`) and finished request records
 *   older than the retention window.
 */
import { and, eq, inArray, isNotNull, lte, notExists } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { deliverRuntimeSecretRequestOutcome } from './runtime-secret-request-delivery';
import { getRuntimeSecretRequestLimits } from './runtime-secret-request-settings';

export interface RuntimeSecretRequestExpiryStats {
  expired: number;
  agentsNotified: number;
}

export async function expireRuntimeSecretRequests(
  env: Env,
  now = Date.now()
): Promise<RuntimeSecretRequestExpiryStats> {
  const db = drizzle(env.DATABASE, { schema });
  const limits = await getRuntimeSecretRequestLimits(env);
  const candidates = await db
    .select()
    .from(schema.runtimeSecretRequests)
    .where(
      and(
        eq(schema.runtimeSecretRequests.status, 'pending'),
        lte(schema.runtimeSecretRequests.expiresAt, now)
      )
    )
    .orderBy(schema.runtimeSecretRequests.expiresAt)
    .limit(limits.sweepBatchSize);
  let expired = 0;
  let agentsNotified = 0;
  for (const row of candidates) {
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
    if (await deliverRuntimeSecretRequestOutcome(env, resolved, 'expired', null)) {
      agentsNotified += 1;
    }
  }
  if (expired > 0) {
    log.info('runtime_secret_request.expired', { expired, agentsNotified });
  }
  return { expired, agentsNotified };
}

export interface RuntimeSecretPurgeStats {
  valuesPurged: number;
  requestsPurged: number;
}

export async function purgeRuntimeSecretMaterial(
  env: Env,
  now = Date.now()
): Promise<RuntimeSecretPurgeStats> {
  const db = drizzle(env.DATABASE, { schema });
  const limits = await getRuntimeSecretRequestLimits(env);

  // Ids first, then delete by id: D1 has no DELETE ... LIMIT, and the batch bounds the write.
  const expiredValues = await db
    .select({ id: schema.projectRuntimeEnvVars.id })
    .from(schema.projectRuntimeEnvVars)
    .where(
      and(
        isNotNull(schema.projectRuntimeEnvVars.expiresAt),
        lte(schema.projectRuntimeEnvVars.expiresAt, now)
      )
    )
    .limit(limits.sweepBatchSize);
  const valueIds = expiredValues.map((row) => row.id);
  if (valueIds.length > 0) {
    await db
      .delete(schema.projectRuntimeEnvVars)
      .where(
        and(
          inArray(schema.projectRuntimeEnvVars.id, valueIds),
          lte(schema.projectRuntimeEnvVars.expiresAt, now)
        )
      );
  }

  const retentionCutoff = now - limits.historyRetentionDays * 86_400_000;
  const oldRequests = await db
    .select({ id: schema.runtimeSecretRequests.id })
    .from(schema.runtimeSecretRequests)
    .where(
      and(
        isNotNull(schema.runtimeSecretRequests.resolvedAt),
        lte(schema.runtimeSecretRequests.resolvedAt, retentionCutoff),
        // Keep the record while a value it supplied still exists: it is that value's provenance.
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
    .limit(limits.sweepBatchSize);
  const requestIds = oldRequests.map((row) => row.id);
  if (requestIds.length > 0) {
    await db
      .delete(schema.runtimeSecretRequests)
      .where(
        and(
          inArray(schema.runtimeSecretRequests.id, requestIds),
          lte(schema.runtimeSecretRequests.resolvedAt, retentionCutoff)
        )
      );
  }
  const stats = { valuesPurged: valueIds.length, requestsPurged: requestIds.length };
  log.info('runtime_secret_request.purge_completed', stats);
  return stats;
}
