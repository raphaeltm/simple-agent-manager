import { and, asc, eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { legacyPublicationAdoptionSql } from '../services/capacity-pool-legacy-publication';
import {
  type CapacityPoolRefreshSettings,
  capacityPoolRefreshSettings,
} from '../services/capacity-pool-refresh-settings';
import {
  beginCapacityPoolRefresh,
  finishCapacityPoolRefresh,
} from '../services/capacity-pool-refresh-work';
import { defaultPoolId } from '../services/default-capacity-pool-helpers';
import { resolveBackfillScopeBatchSize } from '../services/default-capacity-pool-storage';
import {
  ensureInstallationDefaultPool,
  ensureProjectDefaultPool,
  ensureUserDefaultPool,
} from '../services/default-capacity-pools-ensure';

type Db = ReturnType<typeof drizzle<typeof schema>>;
export interface CapacityPoolContinuationResult {
  resumed: number;
  failed: number;
}

/** Cron discovers due rows, so neither alarms nor a live process are required for liveness. */
export async function continueCapacityPoolPublications(
  db: Db,
  env: Env,
  settings: CapacityPoolRefreshSettings,
  deadlineAt: number
): Promise<CapacityPoolContinuationResult> {
  const now = Date.now();
  const result = { resumed: 0, failed: 0 };
  if (now >= deadlineAt) return result;
  // A rollback can leave completed new-build work beside unfinished old-build publication.
  // Adopt that condition too, while preserving running leases and terminal cooldowns.
  await db.run(legacyPublicationAdoptionSql(now, resolveBackfillScopeBatchSize({ env })));
  while (Date.now() < deadlineAt) {
    const [work] = await db
      .select()
      .from(schema.capacityPoolRefreshes)
      .where(
        and(
          eq(schema.capacityPoolRefreshes.state, 'pending'),
          lte(schema.capacityPoolRefreshes.nextAttemptAt, Date.now())
        )
      )
      .orderBy(
        asc(schema.capacityPoolRefreshes.nextAttemptAt),
        asc(schema.capacityPoolRefreshes.poolId)
      )
      .limit(1);
    if (!work) break;
    const [claimed] = await db
      .update(schema.capacityPoolRefreshes)
      .set({ nextAttemptAt: Date.now() + settings.leaseMs })
      .where(
        and(
          eq(schema.capacityPoolRefreshes.poolId, work.poolId),
          eq(schema.capacityPoolRefreshes.generation, work.generation),
          eq(schema.capacityPoolRefreshes.state, 'pending'),
          eq(schema.capacityPoolRefreshes.nextAttemptAt, work.nextAttemptAt)
        )
      )
      .returning();
    if (!claimed) continue;
    const validScope =
      (work.scope === 'installation' &&
        work.ownerUserId === null &&
        work.ownerProjectId === null) ||
      (work.scope === 'user' && !!work.ownerUserId && work.ownerProjectId === null) ||
      (work.scope === 'project' && work.ownerUserId === null && !!work.ownerProjectId);
    if (
      !validScope ||
      defaultPoolId({
        scope: work.scope as 'installation' | 'user' | 'project',
        ownerUserId: work.ownerUserId,
        ownerProjectId: work.ownerProjectId,
      }) !== work.poolId
    ) {
      result.failed += Number(
        await finishCapacityPoolRefresh(
          db,
          claimed,
          settings,
          false,
          'Catalog refresh scope is invalid. Reconnect its compute account.',
          true,
          env
        )
      );
      continue;
    }
    if (claimed.attempts > 0 && Date.now() >= claimed.deadlineAt) {
      result.failed += Number(
        await finishCapacityPoolRefresh(db, claimed, settings, false, undefined, false, env)
      );
      continue;
    }
    const options = {
      env,
      refreshSettings: settings,
      reconciliationDeadlineAt: deadlineAt,
      refreshContinuation: true,
      refreshClaim: { generation: claimed.generation, nextAttemptAt: claimed.nextAttemptAt },
    };
    try {
      if (work.scope === 'installation') await ensureInstallationDefaultPool(db, options);
      else if (work.scope === 'user' && work.ownerUserId)
        await ensureUserDefaultPool(db, work.ownerUserId, options);
      else if (work.scope === 'project' && work.ownerProjectId)
        await ensureProjectDefaultPool(db, work.ownerProjectId, options);
      else
        await finishCapacityPoolRefresh(
          db,
          claimed,
          settings,
          false,
          'Catalog scope is invalid. Reconnect its compute account.',
          true,
          env
        );
    } catch (error) {
      // Preparation can throw before ensure begins its attempt. Spend that exact claimed
      // attempt through the normal deadline/backoff path. If ensure already began or a
      // newer publisher took ownership, this CAS is a no-op rather than a second attempt.
      const failedAttempt = await beginCapacityPoolRefresh(
        db,
        {
          scope: work.scope as 'installation' | 'user' | 'project',
          ownerUserId: work.ownerUserId,
          ownerProjectId: work.ownerProjectId,
        },
        settings,
        true,
        options.refreshClaim
      );
      if (failedAttempt)
        await finishCapacityPoolRefresh(
          db,
          failedAttempt,
          settings,
          false,
          'Compute catalog refresh preparation failed. SAM will retry automatically within its recovery budget.',
          false,
          env
        );
      result.failed += 1;
      log.warn('capacity_pools.continuation_failed', {
        poolId: work.poolId,
        ...serializeError(error),
      });
      result.resumed += 1;
      continue;
    }
    // The ensure owns the next generation. Count a committed terminal outcome without
    // mistaking a later unrelated publisher's state for this continuation's result.
    const [outcome] = await db
      .select({ state: schema.capacityPoolRefreshes.state })
      .from(schema.capacityPoolRefreshes)
      .where(
        and(
          eq(schema.capacityPoolRefreshes.poolId, claimed.poolId),
          eq(schema.capacityPoolRefreshes.generation, claimed.generation + 1)
        )
      )
      .limit(1);
    if (outcome?.state === 'failed') result.failed += 1;
    result.resumed += 1;
  }
  return result;
}

/** The one-minute cron does continuation only, avoiding the unrelated five-minute sweeps. */
export async function runScheduledCapacityPoolContinuations(
  env: Env
): Promise<CapacityPoolContinuationResult> {
  const settings = await capacityPoolRefreshSettings(env);
  return continueCapacityPoolPublications(
    drizzle(env.DATABASE, { schema }),
    env,
    settings,
    Date.now() + settings.passBudgetMs
  );
}
