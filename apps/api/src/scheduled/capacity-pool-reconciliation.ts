import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { nextCapacityPoolTimestamp } from '../services/capacity-pool-clock';
import { capacityPoolRefreshSettings } from '../services/capacity-pool-refresh-settings';
import { backfillDefaultCapacityPoolsForExistingCredentials } from '../services/default-capacity-pools';
import { continueCapacityPoolPublications } from './capacity-pool-continuation';

export interface ScheduledCapacityPoolReconciliationResult {
  installationEnsured: boolean;
  usersEnsured: number;
  projectsEnsured: number;
  skipped: boolean;
  skipReason: 'recently-ran' | null;
  nextEligibleAt: string | null;
}

const SCHEDULED_RECONCILIATION_LAST_RUN_KEY = 'capacityPools.scheduledReconciliation.lastRun.v1';
const DEFAULT_SCHEDULED_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function runScheduledCapacityPoolReconciliation(
  env: Env
): Promise<ScheduledCapacityPoolReconciliationResult> {
  const db = drizzle(env.DATABASE, { schema });
  const settings = await capacityPoolRefreshSettings(env);
  const deadlineAt = Date.now() + settings.passBudgetMs;
  const resumed = await continueCapacityPoolPublications(db, env, settings, deadlineAt);
  const gate =
    Date.now() >= deadlineAt
      ? {
          claimed: false,
          nextEligibleAt: new Date(Date.now() + settings.retryBaseMs).toISOString(),
        }
      : await claimScheduledReconciliationRun(db, env, settings.leaseMs);
  if (!gate.claimed) {
    return {
      installationEnsured: false,
      usersEnsured: 0,
      projectsEnsured: 0,
      skipped: resumed === 0,
      skipReason: resumed === 0 ? 'recently-ran' : null,
      nextEligibleAt: gate.nextEligibleAt,
    };
  }

  const result = await backfillDefaultCapacityPoolsForExistingCredentials(db, {
    includeInstallation: true,
    env,
    refreshSettings: settings,
    refreshContinuation: true,
    reconciliationDeadlineAt: deadlineAt,
  });
  await db
    .insert(schema.platformSettings)
    .values({
      key: SCHEDULED_RECONCILIATION_LAST_RUN_KEY,
      value: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: { value: new Date().toISOString(), updatedAt: new Date().toISOString() },
    });

  return {
    installationEnsured: result.installation !== null,
    usersEnsured: result.usersEnsured,
    projectsEnsured: result.projectsEnsured,
    skipped: false,
    skipReason: null,
    nextEligibleAt: gate.nextEligibleAt,
  };
}

async function claimScheduledReconciliationRun(
  db: Db,
  env: Env,
  leaseMs: number
): Promise<{ claimed: boolean; nextEligibleAt: string | null }> {
  const intervalMs = resolveScheduledReconciliationIntervalMs(env);
  if (intervalMs <= 0) return { claimed: true, nextEligibleAt: null };

  const nowMs = Date.now();
  const nowIso = nextCapacityPoolTimestamp();
  const [lastSuccess] = await db
    .select({ value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, SCHEDULED_RECONCILIATION_LAST_RUN_KEY))
    .limit(1);
  const lastSuccessMs = parseStoredTimestampMs(lastSuccess?.value);
  if (lastSuccessMs !== null && lastSuccessMs + intervalMs > nowMs)
    return {
      claimed: false,
      nextEligibleAt: new Date(lastSuccessMs + intervalMs).toISOString(),
    };
  const leaseKey = 'capacityPools.scheduledReconciliation.claim.v1';
  const [claimed] = await db
    .insert(schema.platformSettings)
    .values({
      key: leaseKey,
      value: nowIso,
      updatedAt: nowIso,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: { value: nowIso, updatedAt: nowIso, updatedBy: sql`NULL` },
      where: sql`${schema.platformSettings.value} <= ${new Date(nowMs - leaseMs).toISOString()}`,
    })
    .returning({ value: schema.platformSettings.value });

  if (claimed) {
    return {
      claimed: true,
      nextEligibleAt: new Date(nowMs + intervalMs).toISOString(),
    };
  }

  const [row] = await db
    .select({ value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, leaseKey))
    .limit(1);
  const lastRunMs = parseStoredTimestampMs(row?.value) ?? nowMs;
  return {
    claimed: false,
    nextEligibleAt: new Date(lastRunMs + leaseMs).toISOString(),
  };
}

function resolveScheduledReconciliationIntervalMs(env: Env): number {
  const parsed = Number(env.CAPACITY_POOL_SCHEDULED_RECONCILIATION_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SCHEDULED_RECONCILIATION_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

function parseStoredTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
