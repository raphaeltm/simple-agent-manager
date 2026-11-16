import { and, eq, lte, or, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { listOperatorUserIds, notifyOperatorsOnce } from '../scheduled/operator-notifications';
import type { CapacityPoolRefreshSettings } from './capacity-pool-refresh-settings';
import { defaultPoolId } from './default-capacity-pool-helpers';
import type { Db, ScopeIdentity } from './default-capacity-pool-types';
import { persistError } from './observability';

/** Queue before any provider I/O. A missed notification or process crash leaves a due row. */
export async function queueCapacityPoolRefresh(
  db: Db,
  scope: ScopeIdentity,
  _settings: CapacityPoolRefreshSettings
): Promise<void> {
  await queuedRefreshQuery(db, scope, Date.now());
}

/** One transactional discovery-page write, rather than one D1 round trip per scope. */
export async function queueCapacityPoolRefreshes(
  db: Db,
  scopes: ScopeIdentity[],
  _settings: CapacityPoolRefreshSettings
): Promise<void> {
  const now = Date.now();
  const [first, ...rest] = scopes.map((scope) => queuedRefreshQuery(db, scope, now));
  if (first) await db.batch([first, ...rest]);
}

function queuedRefreshQuery(db: Db, scope: ScopeIdentity, now: number) {
  return db
    .insert(schema.capacityPoolRefreshes)
    .values({
      poolId: defaultPoolId(scope),
      ...scope,
      state: 'pending',
      generation: 0,
      attempts: 0,
      // attempts=0 means discovered, not started. Queue residence spends no recovery budget.
      startedAt: 0,
      deadlineAt: 0,
      nextAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: schema.capacityPoolRefreshes.poolId,
      set: {
        state: 'pending',
        startedAt: 0,
        deadlineAt: 0,
        nextAttemptAt: now,
        attempts: 0,
        lastError: null,
      },
      // Discovery leaves pending attempts and their backoff/deadline untouched. A failed
      // episode is visible through its cooldown; a later daily discovery may retry it.
      where: or(
        eq(schema.capacityPoolRefreshes.state, 'complete'),
        and(
          eq(schema.capacityPoolRefreshes.state, 'failed'),
          lte(schema.capacityPoolRefreshes.nextAttemptAt, now)
        )
      ),
    });
}

export async function beginCapacityPoolRefresh(
  db: Db,
  scope: ScopeIdentity,
  settings: CapacityPoolRefreshSettings,
  continuation = false,
  claim?: { generation: number; nextAttemptAt: number }
) {
  if (!claim) await queueCapacityPoolRefresh(db, scope, settings);
  const now = Date.now();
  const [work] = await db
    .update(schema.capacityPoolRefreshes)
    .set({
      generation: sql`${schema.capacityPoolRefreshes.generation} + 1`,
      attempts: sql`CASE WHEN state = 'failed' THEN 1 ELSE attempts + 1 END`,
      startedAt: sql`CASE WHEN state = 'failed' OR attempts = 0 THEN ${now} ELSE started_at END`,
      deadlineAt: sql`CASE WHEN state = 'failed' OR attempts = 0 THEN ${now + settings.deadlineMs} ELSE deadline_at END`,
      nextAttemptAt: now + settings.leaseMs,
      state: 'pending',
    })
    .where(
      and(
        eq(schema.capacityPoolRefreshes.poolId, defaultPoolId(scope)),
        continuation ? eq(schema.capacityPoolRefreshes.state, 'pending') : undefined,
        claim ? eq(schema.capacityPoolRefreshes.generation, claim.generation) : undefined,
        claim
          ? eq(schema.capacityPoolRefreshes.nextAttemptAt, claim.nextAttemptAt)
          : continuation
            ? lte(schema.capacityPoolRefreshes.nextAttemptAt, now)
            : undefined
      )
    )
    .returning();
  return work ?? null;
}

export async function finishCapacityPoolRefresh(
  db: Db,
  work: schema.CapacityPoolRefresh,
  settings: CapacityPoolRefreshSettings,
  complete: boolean,
  error?: string,
  permanent = false,
  env?: Env
): Promise<boolean> {
  const now = Date.now();
  const exhausted = !complete && (permanent || now >= work.deadlineAt);
  const delay = Math.min(
    settings.retryMaxMs,
    settings.retryBaseMs * 2 ** Math.min(work.attempts - 1, 20)
  );
  const nextAttemptAt = exhausted
    ? now + settings.failureCooldownMs
    : complete
      ? now
      : Math.min(work.deadlineAt, now + delay);
  const [transition] = await db
    .update(schema.capacityPoolRefreshes)
    .set({
      state: complete ? 'complete' : exhausted ? 'failed' : 'pending',
      nextAttemptAt,
      ...(complete
        ? { lastSuccessAt: now, lastError: null }
        : {
            lastError: permanent
              ? error
              : exhausted
                ? 'Catalog refresh exceeded its recovery deadline. The last committed catalog is retained. Check the compute account; daily discovery retries after cooldown, or use Infrastructure Refresh.'
                : (error ??
                  'Catalog publication is incomplete; automatic continuation is scheduled.'),
          }),
    })
    .where(
      and(
        eq(schema.capacityPoolRefreshes.poolId, work.poolId),
        eq(schema.capacityPoolRefreshes.generation, work.generation),
        eq(schema.capacityPoolRefreshes.attempts, work.attempts),
        eq(schema.capacityPoolRefreshes.nextAttemptAt, work.nextAttemptAt),
        eq(schema.capacityPoolRefreshes.state, 'pending')
      )
    )
    .returning({ poolId: schema.capacityPoolRefreshes.poolId });
  if (!transition || !exhausted) return false;
  const context = {
    poolId: work.poolId,
    scope: work.scope,
    generation: work.generation,
    attempts: work.attempts,
    deadlineAt: work.deadlineAt,
    nextAttemptAt,
  };
  log.error('capacity_pools.refresh_failed', context);
  if (env) {
    try {
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
          source: 'api',
          level: 'error',
          message:
            'Compute catalog refresh stopped after its bounded recovery episode. The committed catalog is retained.',
          context,
        },
        env
      );
      const delivery = await notifyOperatorsOnce(
        env,
        await listOperatorUserIds(env),
        `capacity-pool-refresh:${work.poolId}:${work.generation}`,
        nextAttemptAt,
        {
          type: 'cron_failure',
          urgency: 'high',
          title: 'Compute catalog refresh stopped',
          body: 'A compute catalog refresh could not finish within its recovery budget. Its committed catalog remains usable. Check the compute account and the error details; daily discovery retries after cooldown.',
          actionUrl: '/admin/errors',
          metadata: context,
        },
        now
      );
      if (delivery.failed > 0)
        log.error('capacity_pools.refresh_alert_delivery_failed', { failed: delivery.failed });
    } catch {
      // Failure recording cannot undo or reopen the ownership-fenced failed transition.
      log.error('capacity_pools.refresh_alert_failed');
    }
  }
  return true;
}
