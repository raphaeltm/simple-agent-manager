import { and, eq, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { CapacityPoolRefreshSettings } from './capacity-pool-refresh-settings';
import { defaultPoolId } from './default-capacity-pool-helpers';
import type { Db, ScopeIdentity } from './default-capacity-pool-types';

/** Queue before any provider I/O. A missed notification or process crash leaves a due row. */
export async function queueCapacityPoolRefresh(
  db: Db,
  scope: ScopeIdentity,
  settings: CapacityPoolRefreshSettings
): Promise<void> {
  await queuedRefreshQuery(db, scope, settings, Date.now());
}

/** One transactional discovery-page write, rather than one D1 round trip per scope. */
export async function queueCapacityPoolRefreshes(
  db: Db,
  scopes: ScopeIdentity[],
  settings: CapacityPoolRefreshSettings
): Promise<void> {
  const now = Date.now();
  const [first, ...rest] = scopes.map((scope) => queuedRefreshQuery(db, scope, settings, now));
  if (first) await db.batch([first, ...rest]);
}

function queuedRefreshQuery(
  db: Db,
  scope: ScopeIdentity,
  settings: CapacityPoolRefreshSettings,
  now: number
) {
  return db
    .insert(schema.capacityPoolRefreshes)
    .values({
      poolId: defaultPoolId(scope),
      ...scope,
      state: 'pending',
      generation: 0,
      attempts: 0,
      startedAt: now,
      deadlineAt: now + settings.deadlineMs,
      nextAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: schema.capacityPoolRefreshes.poolId,
      set: {
        state: 'pending',
        startedAt: now,
        deadlineAt: now + settings.deadlineMs,
        nextAttemptAt: now,
        attempts: 0,
        lastError: null,
      },
      // Daily discovery never resets an unfinished operation's finite deadline or an actionable
      // exhausted outcome. A manual ensure may explicitly begin a fresh attempt below.
      where: eq(schema.capacityPoolRefreshes.state, 'complete'),
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
      startedAt: sql`CASE WHEN state = 'failed' THEN ${now} ELSE started_at END`,
      deadlineAt: sql`CASE WHEN state = 'failed' THEN ${now + settings.deadlineMs} ELSE deadline_at END`,
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
  permanent = false
): Promise<void> {
  const now = Date.now();
  const exhausted = !complete && (permanent || now >= work.deadlineAt);
  const delay = Math.min(
    settings.retryMaxMs,
    settings.retryBaseMs * 2 ** Math.min(work.attempts - 1, 20)
  );
  await db
    .update(schema.capacityPoolRefreshes)
    .set({
      state: complete ? 'complete' : exhausted ? 'failed' : 'pending',
      nextAttemptAt: complete || exhausted ? now : Math.min(work.deadlineAt, now + delay),
      ...(complete
        ? { lastSuccessAt: now, lastError: null }
        : {
            lastError: permanent
              ? error
              : exhausted
                ? 'Catalog refresh exceeded its recovery deadline. Check the compute account and use Infrastructure Refresh to retry. The last committed catalog is retained.'
                : (error ??
                  'Catalog publication is incomplete; automatic continuation is scheduled.'),
          }),
    })
    .where(
      and(
        eq(schema.capacityPoolRefreshes.poolId, work.poolId),
        eq(schema.capacityPoolRefreshes.generation, work.generation),
        eq(schema.capacityPoolRefreshes.state, 'pending')
      )
    );
}
