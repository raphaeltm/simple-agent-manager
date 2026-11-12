import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import {
  type CapacityPoolRefreshSettings,
  capacityPoolRefreshSettings,
} from '../services/capacity-pool-refresh-settings';
import { finishCapacityPoolRefresh } from '../services/capacity-pool-refresh-work';
import { defaultPoolId } from '../services/default-capacity-pool-helpers';
import { resolveBackfillScopeBatchSize } from '../services/default-capacity-pool-storage';
import {
  ensureInstallationDefaultPool,
  ensureProjectDefaultPool,
  ensureUserDefaultPool,
} from '../services/default-capacity-pools-ensure';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Cron discovers due rows, so neither alarms nor a live process are required for liveness. */
export async function continueCapacityPoolPublications(
  db: Db,
  env: Env,
  settings: CapacityPoolRefreshSettings,
  deadlineAt: number
): Promise<number> {
  const now = Date.now();
  if (now >= deadlineAt) return 0;
  // Adopt legacy unfinished pools at upgrade. They cannot prove a pre-upgrade atomic catalog,
  // so keep bootstrap gated while resuming them promptly rather than waiting a day.
  await db.run(sql`INSERT INTO capacity_pool_refreshes
    (pool_id, scope, owner_user_id, owner_project_id, state, generation, attempts, started_at, deadline_at, next_attempt_at)
    SELECT id, scope, owner_user_id, owner_project_id, 'pending', 0, 0, ${now}, ${now + settings.deadlineMs}, ${now}
    FROM capacity_pools
    WHERE is_default = 1 AND migration_state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM capacity_pool_refreshes WHERE pool_id = capacity_pools.id)
    ORDER BY id LIMIT ${resolveBackfillScopeBatchSize({ env })}
    ON CONFLICT(pool_id) DO NOTHING`);
  let resumed = 0;
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
      await finishCapacityPoolRefresh(
        db,
        claimed,
        settings,
        false,
        'Catalog refresh scope is invalid. Reconnect its compute account.',
        true
      );
      continue;
    }
    if (Date.now() >= claimed.deadlineAt) {
      await finishCapacityPoolRefresh(db, claimed, settings, false);
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
          'Catalog scope is invalid. Reconnect its compute account.'
        );
    } catch (error) {
      log.warn('capacity_pools.continuation_failed', {
        poolId: work.poolId,
        ...serializeError(error),
      });
    }
    resumed += 1;
  }
  return resumed;
}

/** The one-minute cron does continuation only, avoiding the unrelated five-minute sweeps. */
export async function runScheduledCapacityPoolContinuations(env: Env): Promise<number> {
  const settings = await capacityPoolRefreshSettings(env);
  return continueCapacityPoolPublications(
    drizzle(env.DATABASE, { schema }),
    env,
    settings,
    Date.now() + settings.passBudgetMs
  );
}
