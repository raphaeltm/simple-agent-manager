import { errors } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import { PUBLISH_JOB_TERMINAL_STATUSES } from './deployment-publish-jobs';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Repair only an already owned, live reservation. Do not readmit, acquire a
 * second slot, extend a deadline, or revive canceled/advanced execution. */
export async function recoverReservedCloudflareBuild(db: Db, jobId: string, attempt: number) {
  const j = schema.deploymentPublishJobs;
  const now = new Date().toISOString();
  const [job] = await db
    .update(j)
    .set({ status: 'starting', currentStep: 'builder_start', updatedAt: now, lastHeartbeatAt: now })
    .where(
      and(
        eq(j.id, jobId),
        eq(j.attempt, attempt),
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        eq(j.status, 'context_ready'),
        eq(j.executorInstanceId, jobId),
        sql`${j.executorDeadlineAt} > ${now}`
      )
    )
    .returning();
  return job ?? null;
}
export const DEFAULT_DEPLOY_BUILDER_MAX_CONCURRENT = 6;
export const DEFAULT_DEPLOY_BUILDER_PROJECT_MAX_CONCURRENT = 2;
export const DEFAULT_DEPLOY_BUILDER_CAPACITY_BACKOFF_MS = 30_000;
export const DEFAULT_DEPLOY_BUILDER_DRAIN_LIMIT = 6;
export const DEFAULT_DEPLOY_BUILDER_DEADLINE_MS = 20 * 60_000;

/** Reservation ownership outlives a terminal verdict until stop is confirmed.
 * Both caps are checked in the final mutation, never a preceding SELECT. */
export async function admitCloudflareBuild(
  db: Db,
  jobId: string,
  limits: {
    platform: number;
    project: number;
    classMax: number;
    deadlineMs: number;
    buildTimeoutMs?: number;
  },
  nowMs = Date.now()
) {
  const j = schema.deploymentPublishJobs;
  const platform = Math.min(limits.platform, limits.classMax);
  if (
    ![
      platform,
      limits.project,
      limits.deadlineMs,
      limits.buildTimeoutMs ?? DEFAULT_DEPLOY_BUILDER_DEADLINE_MS,
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new Error('Invalid Cloudflare build admission limits');
  const now = new Date(nowMs).toISOString();
  const rows = await db
    .update(j)
    .set({
      executorInstanceId: jobId,
      executorDeadlineAt: sql`coalesce(${j.executorDeadlineAt}, min(strftime('%Y-%m-%dT%H:%M:%fZ', ${j.createdAt}, ${'+' + limits.deadlineMs / 1000 + ' seconds'}), ${new Date(nowMs + (limits.buildTimeoutMs ?? DEFAULT_DEPLOY_BUILDER_DEADLINE_MS)).toISOString()}))`,
      status: 'starting',
      currentStep: 'builder_start',
      updatedAt: now,
      lastHeartbeatAt: now,
    })
    .where(
      and(
        eq(j.id, jobId),
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        eq(j.status, 'context_ready'),
        isNull(j.executorInstanceId),
        isNotNull(j.contextR2Key),
        isNotNull(j.contextSha256),
        or(isNull(j.executorNotBefore), lte(j.executorNotBefore, now)),
        sql`${j.createdAt} > ${new Date(nowMs - limits.deadlineMs).toISOString()}`,
        sql`(SELECT count(*) FROM deployment_publish_jobs AS active WHERE active.executor = 'cloudflare' AND active.executor_instance_id IS NOT NULL) < ${platform}`,
        sql`(SELECT count(*) FROM deployment_publish_jobs AS active WHERE active.executor = 'cloudflare' AND active.executor_instance_id IS NOT NULL AND active.project_id = ${j.projectId}) < ${limits.project}`
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Call only after the DO confirms stop/no running process. Cancellation that
 * raced startup remains terminal; only a still-starting job may be requeued. */
export async function releaseCloudflareBuildReservation(
  db: Db,
  jobId: string,
  attempt: number,
  retryAt?: number,
  expectedEpoch?: string | null
) {
  const j = schema.deploymentPublishJobs;
  return db
    .update(j)
    .set({
      executorInstanceId: null,
      ...(retryAt === undefined
        ? {}
        : {
            status: sql`CASE WHEN ${j.status} = 'starting' THEN 'context_ready' ELSE ${j.status} END`,
            currentStep: sql`CASE WHEN ${j.status} = 'starting' THEN 'capacity_backoff' ELSE ${j.currentStep} END`,
            executorNotBefore: new Date(
              Math.max(retryAt, expectedEpoch ? Date.parse(expectedEpoch) + 1 : 0)
            ).toISOString(),
          }),
    })
    .where(
      and(
        eq(j.id, jobId),
        eq(j.attempt, attempt),
        expectedEpoch !== undefined ? sql`${j.executorNotBefore} IS ${expectedEpoch}` : undefined,
        expectedEpoch !== undefined ? eq(j.executorInstanceId, jobId) : undefined,
        retryAt !== undefined
          ? or(
              eq(j.status, 'starting'),
              sql`${j.status} IN (${sql.join(
                [...PUBLISH_JOB_TERMINAL_STATUSES].map((s) => sql`${s}`),
                sql`,`
              )})`
            )
          : undefined,
        retryAt === undefined
          ? sql`${j.status} IN (${sql.join(
              [...PUBLISH_JOB_TERMINAL_STATUSES].map((s) => sql`${s}`),
              sql`,`
            )})`
          : undefined
      )
    )
    .returning();
}

/** Friendly preflight; the deletion trigger remains the atomic race fence. */
export async function assertNoReservedCloudflareBuilds(
  db: Db,
  scope: { nodeId: string } | { projectId: string } | { environmentId: string }
): Promise<void> {
  const j = schema.deploymentPublishJobs;
  const predicate =
    'nodeId' in scope
      ? eq(j.nodeId, scope.nodeId)
      : 'projectId' in scope
        ? eq(j.projectId, scope.projectId)
        : eq(j.environmentId, scope.environmentId);
  const [reserved] = await db
    .select({ id: j.id })
    .from(j)
    .where(
      and(
        predicate,
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        isNotNull(j.executorInstanceId)
      )
    )
    .limit(1);
  if (reserved) throw errors.conflict(CLOUDFLARE_BUILD_DELETION_CONFLICT);
}

export const CLOUDFLARE_BUILD_DELETION_CONFLICT =
  'A Cloudflare build is still stopping or running. Wait for it to stop before deleting this resource.';

/** D1/Drizzle wrap SQLite trigger errors in causes. Match only our fixed marker. */
export function isCloudflareBuildDeletionConflict(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message.includes('cloudflare_build_reservation_held')) return true;
    current = current.cause;
  }
  return false;
}
