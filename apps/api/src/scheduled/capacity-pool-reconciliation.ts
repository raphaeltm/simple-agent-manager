import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { nextCapacityPoolTimestamp } from '../services/capacity-pool-clock';
import { backfillDefaultCapacityPoolsForExistingCredentials } from '../services/default-capacity-pools';

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
  const gate = await claimScheduledReconciliationRun(db, env);
  if (!gate.claimed) {
    return {
      installationEnsured: false,
      usersEnsured: 0,
      projectsEnsured: 0,
      skipped: true,
      skipReason: 'recently-ran',
      nextEligibleAt: gate.nextEligibleAt,
    };
  }

  const result = await backfillDefaultCapacityPoolsForExistingCredentials(db, {
    includeInstallation: true,
    env,
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
  env: Env
): Promise<{ claimed: boolean; nextEligibleAt: string | null }> {
  const intervalMs = resolveScheduledReconciliationIntervalMs(env);
  if (intervalMs <= 0) return { claimed: true, nextEligibleAt: null };

  const nowMs = Date.now();
  const nowIso = nextCapacityPoolTimestamp();
  const thresholdIso = new Date(nowMs - intervalMs).toISOString();
  const [claimed] = await db
    .insert(schema.platformSettings)
    .values({
      key: SCHEDULED_RECONCILIATION_LAST_RUN_KEY,
      value: nowIso,
      updatedAt: nowIso,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: {
        value: nowIso,
        updatedAt: nowIso,
        updatedBy: sql`NULL`,
      },
      where: sql`${schema.platformSettings.value} <= ${thresholdIso}`,
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
    .where(eq(schema.platformSettings.key, SCHEDULED_RECONCILIATION_LAST_RUN_KEY))
    .limit(1);
  const lastRunMs = parseStoredTimestampMs(row?.value) ?? nowMs;
  return {
    claimed: false,
    nextEligibleAt: new Date(lastRunMs + intervalMs).toISOString(),
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
