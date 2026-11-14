import { log } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import {
  admitCloudflareBuild,
  releaseCloudflareBuildReservation,
} from './cloudflare-build-admission';
import {
  appendDeploymentPublishJobEvent,
  PUBLISH_JOB_TERMINAL_STATUSES,
} from './deployment-publish-jobs';
import type { DeploymentLifecyclePort, DeploymentSettingsPort } from './ports';

type Job = schema.DeploymentPublishJobRow;
export interface CloudflareBuildPorts {
  settings: DeploymentSettingsPort;
  lifecycle: DeploymentLifecyclePort;
  classMax: number;
  builder: {
    start(job: Job): Promise<'started' | 'capacity'>;
    /** Resolves only once the container is stopped, including no-running cases. */
    stop(job: Pick<Job, 'id'>): Promise<void>;
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
      // Even a capacity exception can race a successful start. Confirm stop
      // before freeing the reservation; failed stop is reconciled by the sweep.
      await ports.builder.stop(job);
      await releaseCloudflareBuildReservation(
        db,
        job.id,
        job.attempt,
        Date.now() + Number(backoffMs)
      );
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
      status: 'failed',
      currentStep: 'builder_start',
      eventType: 'publish.builder.start_failed',
      message: 'Cloudflare builder failed to start',
      errorCode: 'builder_start_failed',
      terminal: true,
    });
    if (changed)
      await ports.lifecycle.recordPublishJobLifecycleEventBestEffort({
        projectId: job.projectId,
        publishJobId: job.id,
        environmentId: job.environmentId,
        status: 'failed',
        terminal: true,
        source: 'cloudflare_builder.start',
        occurredAt: Date.now(),
      });
    try {
      await ports.builder.stop(job);
      await releaseCloudflareBuildReservation(db, job.id, job.attempt);
    } catch {
      log.warn('cloudflare_builder.stop_pending', { publishJobId: job.id });
    }
    return false;
  }
}

/** At most the configured batch of queued starts and at most classMax stop
 * reconciliations per cron tick. Each start has the same final atomic gate. */
export async function drainCloudflareBuilds(database: D1Database, ports: CloudflareBuildPorts) {
  const db = drizzle(database, { schema });
  const j = schema.deploymentPublishJobs;
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
        eq(j.status, 'starting'),
        isNotNull(j.executorInstanceId)
      )
    )
    .limit(ports.classMax);
  for (const job of starting) await startReservedCloudflareBuild(database, ports, job);
  const limit = Number(await ports.settings.resolveSetting('deployments.builderDrainLimit'));
  const queued = await db
    .select({ id: j.id })
    .from(j)
    .where(
      and(
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        eq(j.status, 'context_ready'),
        isNull(j.executorInstanceId),
        or(isNull(j.executorNotBefore), lte(j.executorNotBefore, new Date().toISOString()))
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
