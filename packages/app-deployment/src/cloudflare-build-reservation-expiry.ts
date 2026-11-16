import { log, ulid } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import { PUBLISH_JOB_TERMINAL_STATUSES } from './deployment-publish-jobs';

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Job = schema.DeploymentPublishJobRow;

/** Exceptional liveness escape, not proof of physical shutdown. Immutable
 * deadline + grace bounds a lost stop RPC. Revoke live callback authority in
 * the same mutation as ownership; never release a replacement attempt/epoch. */
export async function forceReleaseExpiredCloudflareBuild(
  db: Db,
  job: Job,
  graceMs: number,
  nowMs = Date.now()
): Promise<boolean> {
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0)
    throw new Error('Invalid Cloudflare reservation grace');
  if (!job.executorInstanceId || !job.executorDeadlineAt) return false;
  const j = schema.deploymentPublishJobs;
  const terminal = sql.join(
    [...PUBLISH_JOB_TERMINAL_STATUSES].map((s) => sql`${s}`),
    sql`,`
  );
  const [released] = await db
    .update(j)
    .set({
      executorInstanceId: null,
      status: sql`CASE WHEN ${j.status} IN (${terminal}) THEN ${j.status} ELSE 'unknown' END`,
      completedAt: sql`coalesce(${j.completedAt}, ${new Date(nowMs).toISOString()})`,
      errorCode: sql`CASE WHEN ${j.status} IN (${terminal}) THEN ${j.errorCode} ELSE 'builder_stop_unconfirmed' END`,
      errorMessage: sql`CASE WHEN ${j.status} IN (${terminal}) THEN ${j.errorMessage} ELSE 'Builder deadline and shutdown grace elapsed; physical stop is unconfirmed' END`,
      updatedAt: new Date(nowMs).toISOString(),
    })
    .where(
      and(
        eq(j.id, job.id),
        eq(j.attempt, job.attempt),
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false),
        eq(j.executorInstanceId, job.executorInstanceId),
        sql`${j.executorNotBefore} IS ${job.executorNotBefore}`,
        eq(j.executorDeadlineAt, job.executorDeadlineAt),
        isNotNull(j.executorDeadlineAt),
        lte(j.executorDeadlineAt, new Date(nowMs - graceMs).toISOString())
      )
    )
    .returning();
  if (!released) return false;
  // Never attach provider/RPC error text: it may include credentials. Alert
  // failure cannot roll back the escape or prevent later candidates progressing.
  const detail = {
    publishJobId: job.id,
    projectId: job.projectId,
    attempt: job.attempt,
    executorInstanceId: job.executorInstanceId,
    executorDeadlineAt: job.executorDeadlineAt,
    reservationEpoch: job.executorNotBefore,
    graceMs,
    physicalStopConfirmed: false,
  };
  log.error('cloudflare_builder.reservation_force_released', detail);
  try {
    // Terminal jobs reject normal agent events. This control-plane alert is
    // deliberately journaled separately and never changes their verdict.
    await db.run(sql`INSERT INTO deployment_publish_job_events
      (id, publish_job_id, project_id, environment_id, node_id,
       workspace_id, seq, level, event_type, message, detail_json, created_at)
      SELECT ${ulid()}, ${j.id}, ${j.projectId}, ${j.environmentId}, ${j.nodeId},
        ${j.workspaceId},
        (SELECT coalesce(max(seq), 0) + 1 FROM deployment_publish_job_events WHERE publish_job_id = ${job.id}),
        'alert', 'publish.builder.reservation_force_released',
        'Builder reservation force-released after deadline and shutdown grace; physical stop is unconfirmed',
        ${JSON.stringify(detail)}, ${new Date(nowMs).toISOString()}
      FROM ${j} WHERE ${j.id} = ${job.id} AND ${j.attempt} = ${job.attempt}`);
  } catch {
    log.error('cloudflare_builder.reservation_alert_failed', {
      publishJobId: job.id,
      attempt: job.attempt,
    });
  }
  return true;
}
