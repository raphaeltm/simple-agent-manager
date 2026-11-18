import { log } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import {
  admitCloudflareBuild,
  releaseCloudflareBuildReservation,
} from './cloudflare-build-admission';
import { forceReleaseExpiredCloudflareBuild } from './cloudflare-build-reservation-expiry';
import {
  appendDeploymentPublishJobEvent,
  PUBLISH_JOB_TERMINAL_STATUSES,
} from './deployment-publish-jobs';
import type { DeploymentLifecyclePort, DeploymentSettingsPort } from './ports';

type Job = schema.DeploymentPublishJobRow;
export interface CloudflareBuildStopGuard {
  jobId: string;
  attempt: number;
  notBefore: string | null;
  retryAt: number;
}
export interface CloudflareBuildPorts {
  settings: DeploymentSettingsPort;
  lifecycle: DeploymentLifecyclePort;
  classMax: number;
  builder: {
    start(job: Job): Promise<'started' | 'capacity'>;
    /** Resolves only once the container is stopped, including no-running cases. */
    stop(job: Pick<Job, 'id'>, capacity?: CloudflareBuildStopGuard): Promise<void>;
  };
}

export async function dispatchCloudflareBuild(
  database: D1Database,
  ports: CloudflareBuildPorts,
  jobId: string
) {
  const db = drizzle(database, { schema });
  const [platform, project, deadlineMs, buildTimeoutMs] = await Promise.all([
    ports.settings.resolveSetting('deployments.builderMaxConcurrent'),
    ports.settings.resolveSetting('deployments.builderProjectMaxConcurrent'),
    ports.settings.resolveSetting('deployments.publishJobDeadlineMs'),
    ports.settings.resolveSetting('deployments.builderDeadlineMs'),
  ]);
  const job = await admitCloudflareBuild(db, jobId, {
    platform: Number(platform),
    project: Number(project),
    classMax: ports.classMax,
    deadlineMs: Number(deadlineMs),
    buildTimeoutMs: Number(buildTimeoutMs),
  });
  if (!job) return false;
  await appendDeploymentPublishJobEvent(db, {
    publishJobId: job.id,
    projectId: job.projectId,
    environmentId: job.environmentId,
    nodeId: job.nodeId,
    workspaceId: job.workspaceId,
    expectedAttempt: job.attempt,
    expectedStatus: 'starting',
    currentStep: 'builder_start',
    eventType: 'publish.builder.admitted',
    message: 'Cloudflare build capacity reserved',
  });
  return startReservedCloudflareBuild(database, ports, job);
}

/** Shared by durable kickoff alarms and cron recovery of a lost caller. */
export async function startReservedCloudflareBuild(
  database: D1Database,
  ports: CloudflareBuildPorts,
  job: Job
) {
  const db = drizzle(database, { schema });
  const backoffMs = Number(
    await ports.settings.resolveSetting('deployments.builderCapacityBackoffMs')
  );
  try {
    const result = await ports.builder.start(job);
    if (result === 'capacity') {
      // Stop and release share the DO serialization boundary and reservation
      // epoch. A stale capacity response cannot stop a readmitted guest.
      try {
        await ports.builder.stop(job, {
          jobId: job.id,
          attempt: job.attempt,
          notBefore: job.executorNotBefore,
          retryAt: Date.now() + backoffMs,
        });
      } catch {
        log.warn('cloudflare_builder.stop_pending', { publishJobId: job.id });
      }
    }
    return result === 'started';
  } catch {
    const changed = await appendDeploymentPublishJobEvent(db, {
      publishJobId: job.id,
      projectId: job.projectId,
      environmentId: job.environmentId,
      nodeId: job.nodeId,
      workspaceId: job.workspaceId,
      expectedAttempt: job.attempt,
      expectedStatus: 'starting',
      expectedExecutor: 'cloudflare',
      expectedExecutorInstanceId: job.id,
      expectedReservationEpoch: job.executorNotBefore,
      status: 'failed',
      currentStep: 'builder_start',
      eventType: 'publish.builder.start_failed',
      message: 'Cloudflare builder failed to start',
      errorCode: 'builder_start_failed',
      terminal: true,
    });
    if (!changed) return false;
    try {
      await ports.builder.stop(job);
      await releaseCloudflareBuildReservation(db, job.id, job.attempt);
    } catch {
      log.warn('cloudflare_builder.stop_pending', { publishJobId: job.id });
    }
    await ports.lifecycle.recordPublishJobLifecycleEventBestEffort({
      projectId: job.projectId,
      publishJobId: job.id,
      environmentId: job.environmentId,
      status: 'failed',
      terminal: true,
      source: 'cloudflare_builder.start',
      occurredAt: Date.now(),
    });
    return false;
  }
}

/** At most the configured batch of queued starts and at most classMax stop
 * reconciliations per cron tick. Each start has the same final atomic gate. */
export async function drainCloudflareBuilds(database: D1Database, ports: CloudflareBuildPorts) {
  const db = drizzle(database, { schema });
  const j = schema.deploymentPublishJobs;
  const graceMs = Number(
    await ports.settings.resolveSetting('deployments.builderReservationGraceMs')
  );
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0)
    throw new Error('Invalid Cloudflare reservation grace');
  // Do this before contacting any DO. An unreachable stop must not wedge
  // capacity or FK-cascaded deletion forever, even if the job sweep was lost.
  const expired = await db
    .select()
    .from(j)
    .where(
      and(
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        isNotNull(j.executorInstanceId),
        lte(j.executorDeadlineAt, new Date(Date.now() - graceMs).toISOString())
      )
    )
    .orderBy(asc(j.executorDeadlineAt), asc(j.id))
    .limit(ports.classMax);
  for (const job of expired) {
    try {
      await forceReleaseExpiredCloudflareBuild(db, job, graceMs);
    } catch {
      log.error('cloudflare_builder.reservation_expiry_failed', { publishJobId: job.id });
    }
  }
  const terminal = await db
    .select()
    .from(j)
    .where(
      and(
        eq(j.executor, 'cloudflare'),
        isNotNull(j.executorInstanceId),
        inArray(j.status, [...PUBLISH_JOB_TERMINAL_STATUSES])
      )
    )
    .limit(ports.classMax);
  for (const job of terminal) {
    try {
      await ports.builder.stop(job);
      await releaseCloudflareBuildReservation(db, job.id, job.attempt);
    } catch {
      log.warn('cloudflare_builder.stop_pending', { publishJobId: job.id });
    }
  }
  // Recover a lost HTTP waiter after reservation but before durable DO kickoff.
  const starting = await db
    .select()
    .from(j)
    .where(
      and(
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        inArray(j.status, ['starting', 'context_ready']),
        isNotNull(j.executorInstanceId)
      )
    )
    .limit(ports.classMax);
  for (const job of starting) await startReservedCloudflareBuild(database, ports, job);
  const [limit, projectMax, deadlineMs] = await Promise.all([
    ports.settings.resolveSetting('deployments.builderDrainLimit'),
    ports.settings.resolveSetting('deployments.builderProjectMaxConcurrent'),
    ports.settings.resolveSetting('deployments.publishJobDeadlineMs'),
  ]).then(
    ([batch, project, deadline]) => [Number(batch), Number(project), Number(deadline)] as const
  );
  if (![limit, projectMax, deadlineMs].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid Cloudflare drain limits');
  const now = new Date().toISOString();
  const queued = await db
    .select({ id: j.id })
    .from(j)
    .where(
      and(
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        eq(j.status, 'context_ready'),
        isNull(j.executorInstanceId),
        isNotNull(j.contextR2Key),
        isNotNull(j.contextSha256),
        sql`${j.createdAt} > ${new Date(Date.now() - deadlineMs).toISOString()}`,
        sql`(SELECT count(*) FROM deployment_publish_jobs AS active WHERE active.executor = 'cloudflare' AND active.executor_instance_id IS NOT NULL AND active.project_id = ${j.projectId}) < ${projectMax}`,
        or(isNull(j.executorNotBefore), lte(j.executorNotBefore, now))
      )
    )
    .orderBy(asc(j.queuedAt), asc(j.id))
    .limit(limit);
  for (const job of queued) await dispatchCloudflareBuild(database, ports, job.id);
  return { considered: queued.length };
}

export function isCloudflareBuildCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Maximum number of running containers|container.*capacity.*exceeded/i.test(error.message)
  );
}
