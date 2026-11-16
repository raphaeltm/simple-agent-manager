import { redactCredentialTokens } from '@simple-agent-manager/worker-core';
import { ulid } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, asc, desc, eq, gt, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export const PUBLISH_JOB_TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
  'unknown',
]);
// coalesce also supports older narrow test fixtures; migrated rows are NOT NULL.
export function visiblePublishJobPredicate() {
  return sql`coalesce(${schema.deploymentPublishJobs.contextShadow}, 0) = 0`;
}
const MAX_MESSAGE_LENGTH = 1000;
const MAX_DETAIL_JSON_LENGTH = 4000;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 100;

const SENSITIVE_PATTERNS: RegExp[] = [
  /X-Amz-Signature=[^&\s"]+/gi,
  /X-Amz-Credential=[^&\s"]+/gi,
  /([?&](?:token|signature|X-Amz-Security-Token)=)[^&\s"]+/gi,
  /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /("?(?:password|registryPassword|callbackToken|accessToken|secret|token)"?\s*:\s*")[^"]+(")/gi,
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function sanitizePublishEventText(value: unknown, maxLength = MAX_MESSAGE_LENGTH): string {
  let text = redactCredentialTokens(
    typeof value === 'string' ? value : String(value ?? ''),
    '[redacted]'
  );
  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, (_match, prefix, suffix) => {
      if (typeof prefix === 'string' && typeof suffix === 'string') {
        return `${prefix}[redacted]${suffix}`;
      }
      if (typeof prefix === 'string') {
        return `${prefix}[redacted]`;
      }
      return '[redacted]';
    });
  }
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength - 15)}...[truncated]`;
  }
  return text;
}

function sanitizeDetail(detail: unknown): string | null {
  if (detail == null) return null;
  let raw: string;
  try {
    raw = JSON.stringify(detail);
  } catch {
    raw = JSON.stringify({ note: 'event detail was not JSON serializable' });
  }
  return sanitizePublishEventText(raw, MAX_DETAIL_JSON_LENGTH);
}

function normalizeLevel(level: unknown): string {
  return ['debug', 'info', 'warn', 'error'].includes(String(level)) ? String(level) : 'info';
}

function normalizeStatus(status: unknown): string | undefined {
  if (typeof status !== 'string') return undefined;
  const value = status.trim();
  return value === '' ? undefined : value;
}

export interface CreateDeploymentPublishJobInput {
  executor?: 'node' | 'cloudflare';
  contextShadow?: boolean;
  projectId: string;
  environmentId: string;
  workspaceId: string;
  nodeId: string;
  taskId?: string | null;
  agentProfileId?: string | null;
  requestedBy: string;
  environmentName: string;
  reference: string;
  workingDir?: string | null;
}

export async function createDeploymentPublishJob(
  db: Db,
  input: CreateDeploymentPublishJobInput
): Promise<schema.DeploymentPublishJobRow> {
  const id = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.deploymentPublishJobs).values({
    id,
    projectId: input.projectId,
    environmentId: input.environmentId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    taskId: input.taskId ?? null,
    agentProfileId: input.agentProfileId ?? null,
    requestedBy: input.requestedBy,
    environmentName: input.environmentName,
    reference: input.reference || 'latest',
    workingDir: input.workingDir ?? null,
    status: 'queued',
    executor: input.executor ?? 'node',
    contextShadow: input.contextShadow ?? false,
    createdAt: now,
    updatedAt: now,
  });
  const [job] = await db
    .select()
    .from(schema.deploymentPublishJobs)
    .where(eq(schema.deploymentPublishJobs.id, id))
    .limit(1);
  if (!job) {
    throw new Error('Failed to create deployment publish job');
  }
  return job;
}

export interface AppendDeploymentPublishJobEventInput {
  publishJobId: string;
  projectId: string;
  environmentId: string;
  nodeId: string;
  workspaceId: string;
  status?: string;
  expectedStatus?: string;
  currentStep?: string | null;
  level?: string;
  eventType: string;
  message: string;
  detail?: unknown;
  terminal?: boolean;
  releaseId?: string | null;
  releaseVersion?: number | null;
  releaseStatus?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  retryable?: boolean;
}

export async function appendDeploymentPublishJobEvent(
  db: Db,
  input: AppendDeploymentPublishJobEventInput
): Promise<boolean> {
  const now = new Date().toISOString();
  const status = normalizeStatus(input.status);
  if (input.terminal && (!status || !PUBLISH_JOB_TERMINAL_STATUSES.has(status))) return false;
  if (input.releaseId == null && (input.releaseVersion != null || input.releaseStatus != null))
    return false;
  const terminal = input.terminal || (status ? PUBLISH_JOB_TERMINAL_STATUSES.has(status) : false);
  const predicate = and(
    eq(schema.deploymentPublishJobs.id, input.publishJobId),
    input.releaseId != null ? visiblePublishJobPredicate() : undefined,
    input.releaseId != null
      ? or(
          isNull(schema.deploymentPublishJobs.releaseId),
          eq(schema.deploymentPublishJobs.releaseId, input.releaseId)
        )
      : undefined,
    input.expectedStatus
      ? eq(schema.deploymentPublishJobs.status, input.expectedStatus)
      : undefined,
    notInArray(schema.deploymentPublishJobs.status, [...PUBLISH_JOB_TERMINAL_STATUSES])
  );
  if (input.eventType === 'publish.job.heartbeat') {
    // Heartbeats prove executor liveness independently of slow build/upload progress.
    // The same terminal fence prevents late heartbeats from reviving a canceled job.
    const changed = await db
      .update(schema.deploymentPublishJobs)
      .set({ lastHeartbeatAt: now, updatedAt: now })
      .where(predicate)
      .returning({ id: schema.deploymentPublishJobs.id });
    return changed.length > 0;
  }
  const update: Partial<schema.NewDeploymentPublishJobRow> = {
    updatedAt: now,
    lastEventAt: now,
    // Progress is also proof of life, but cannot opt legacy agents into stall detection.
    lastHeartbeatAt:
      sql`CASE WHEN ${schema.deploymentPublishJobs.lastHeartbeatAt} IS NULL THEN NULL ELSE ${now} END` as unknown as string,
  };
  if (status) update.status = status;
  if (input.currentStep !== undefined) update.currentStep = input.currentStep;
  if (input.releaseId != null)
    update.releaseId =
      sql`coalesce(${schema.deploymentPublishJobs.releaseId}, ${input.releaseId})` as unknown as string;
  if (input.releaseVersion !== undefined) update.releaseVersion = input.releaseVersion;
  if (input.releaseStatus !== undefined) update.releaseStatus = input.releaseStatus;
  if (input.errorMessage !== undefined && input.errorMessage !== null) {
    update.errorMessage = sanitizePublishEventText(input.errorMessage);
  }
  if (input.errorCode !== undefined) update.errorCode = input.errorCode;
  if (input.retryable !== undefined) update.retryable = input.retryable;
  if (status === 'starting' || status === 'validating') {
    update.startedAt =
      sql`coalesce(${schema.deploymentPublishJobs.startedAt}, ${now})` as unknown as string;
  }
  if (terminal)
    update.completedAt =
      sql`coalesce(${schema.deploymentPublishJobs.completedAt}, ${now})` as unknown as string;

  // Insert history and transition together. Sequencing inside the batch avoids
  // the acceptance/event callback race on the unique (publish_job_id, seq) key.
  const insert = db.insert(schema.deploymentPublishJobEvents).select(
    db
      .select({
        id: sql<string>`${ulid()}`.as('id'),
        publishJobId: sql<string>`${input.publishJobId}`.as('publish_job_id'),
        projectId: sql<string>`${input.projectId}`.as('project_id'),
        environmentId: sql<string>`${input.environmentId}`.as('environment_id'),
        nodeId: sql<string>`${input.nodeId}`.as('node_id'),
        nodeIdentifier: sql<string>`${input.nodeId}`.as('node_identifier'),
        workspaceId: sql<string>`${input.workspaceId}`.as('workspace_id'),
        seq: sql<number>`(SELECT coalesce(max(seq), 0) + 1 FROM deployment_publish_job_events WHERE publish_job_id = ${input.publishJobId})`.as(
          'seq'
        ),
        level: sql<string>`${normalizeLevel(input.level)}`.as('level'),
        eventType: sql<string>`${sanitizePublishEventText(input.eventType, 200)}`.as('event_type'),
        step: sql<
          string | null
        >`${input.currentStep ? sanitizePublishEventText(input.currentStep, 200) : null}`.as(
          'step'
        ),
        message: sql<string>`${sanitizePublishEventText(input.message)}`.as('message'),
        detailJson: sql<string | null>`${sanitizeDetail(input.detail)}`.as('detail_json'),
        createdAt: sql<string>`${now}`.as('created_at'),
      })
      .from(schema.deploymentPublishJobs)
      .where(predicate)
  );
  const transition = db
    .update(schema.deploymentPublishJobs)
    .set(update)
    .where(predicate)
    .returning({ id: schema.deploymentPublishJobs.id });
  const [, changed] = await db.batch([insert, transition]);
  return changed.length > 0;
}

export async function getDeploymentPublishJobForMcp(
  db: Db,
  projectId: string,
  publishJobId: string,
  opts: { workspaceId?: string; sinceSeq?: number; limit?: number } = {}
) {
  const where = opts.workspaceId
    ? and(
        eq(schema.deploymentPublishJobs.id, publishJobId),
        eq(schema.deploymentPublishJobs.projectId, projectId),
        eq(schema.deploymentPublishJobs.workspaceId, opts.workspaceId)
      )
    : and(
        eq(schema.deploymentPublishJobs.id, publishJobId),
        eq(schema.deploymentPublishJobs.projectId, projectId)
      );
  const [job] = await db
    .select()
    .from(schema.deploymentPublishJobs)
    .where(and(where, visiblePublishJobPredicate()))
    .limit(1);
  if (!job) return null;

  const limit = clamp(opts.limit ?? DEFAULT_EVENT_LIMIT, 1, MAX_EVENT_LIMIT);
  const eventWhere =
    opts.sinceSeq !== undefined
      ? and(
          eq(schema.deploymentPublishJobEvents.publishJobId, publishJobId),
          gt(schema.deploymentPublishJobEvents.seq, opts.sinceSeq)
        )
      : eq(schema.deploymentPublishJobEvents.publishJobId, publishJobId);
  const order = opts.sinceSeq !== undefined ? asc : desc;
  const rows = await db
    .select()
    .from(schema.deploymentPublishJobEvents)
    .where(eventWhere)
    .orderBy(order(schema.deploymentPublishJobEvents.seq))
    .limit(limit);
  const events = opts.sinceSeq !== undefined ? rows : rows.reverse();
  const nextSinceSeq =
    events.length > 0 ? Math.max(...events.map((event) => event.seq)) : (opts.sinceSeq ?? 0);

  return {
    publishJobId: job.id,
    status: job.status,
    currentStep: job.currentStep,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    environment: job.environmentName,
    environmentId: job.environmentId,
    reference: job.reference,
    workspaceId: job.workspaceId,
    nodeId: job.nodeId,
    releaseId: job.releaseId,
    version: job.releaseVersion,
    releaseStatus: job.releaseStatus,
    errorMessage: job.errorMessage,
    errorCode: job.errorCode,
    retryable: job.retryable,
    events: events.map((event) => ({
      seq: event.seq,
      level: event.level,
      eventType: event.eventType,
      step: event.step,
      message: event.message,
      detail: event.detailJson ? JSON.parse(event.detailJson) : null,
      createdAt: event.createdAt,
    })),
    nextSinceSeq,
    pollAfterSeconds: PUBLISH_JOB_TERMINAL_STATUSES.has(job.status) ? undefined : 15,
    instructions: PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)
      ? job.status === 'succeeded'
        ? 'Publish finished. Inspect deployment logs and release apply events to verify runtime health.'
        : 'Publish is terminal. Inspect the failed step and recent events before retrying.'
      : 'Call deployments_read method publish_status again with publishJobId and sinceSeq until the status is terminal.',
  };
}

/** The status predicate is the durable winner election against callbacks and sweeps. */
export async function cancelDeploymentPublishJob(
  db: Db,
  projectId: string,
  workspaceId: string | undefined,
  publishJobId: string
) {
  const now = new Date().toISOString();
  const rows = await db
    .update(schema.deploymentPublishJobs)
    .set({
      status: 'canceled',
      completedAt: now,
      updatedAt: now,
      retryable: false,
    })
    .where(
      and(
        eq(schema.deploymentPublishJobs.id, publishJobId),
        visiblePublishJobPredicate(),
        eq(schema.deploymentPublishJobs.projectId, projectId),
        workspaceId ? eq(schema.deploymentPublishJobs.workspaceId, workspaceId) : undefined,
        notInArray(schema.deploymentPublishJobs.status, [...PUBLISH_JOB_TERMINAL_STATUSES])
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Recheck expiry in the UPDATE: a callback can refresh the job after selection. */
export async function failExpiredDeploymentPublishJobs(
  db: Db,
  settings: { stallMs: number; deadlineMs: number; sweepLimit: number },
  nowMs = Date.now()
) {
  const now = new Date(nowMs).toISOString();
  const stallCutoff = new Date(nowMs - settings.stallMs).toISOString();
  const deadlineCutoff = new Date(nowMs - settings.deadlineMs).toISOString();
  // SQL NULL never satisfies the heartbeat comparison: legacy agents are deadline-only.
  const expired = sql`(${schema.deploymentPublishJobs.createdAt} <= ${deadlineCutoff}
    OR ${schema.deploymentPublishJobs.lastHeartbeatAt} <= ${stallCutoff})`;
  // Disjoint status ranges use the existing (status, updated_at) index and
  // exclude terminal history. Unlike a fixed active-status list, this also
  // covers new non-terminal states introduced by later executors.
  const terminalStatuses = [...PUBLISH_JOB_TERMINAL_STATUSES].sort((left, right) =>
    left.localeCompare(right)
  );
  const activeRanges = or(
    ...terminalStatuses.map((status, index) =>
      index === 0
        ? lt(schema.deploymentPublishJobs.status, status)
        : and(
            gt(schema.deploymentPublishJobs.status, terminalStatuses[index - 1] as string),
            lt(schema.deploymentPublishJobs.status, status)
          )
    ),
    gt(schema.deploymentPublishJobs.status, terminalStatuses.at(-1) as string)
  );
  const candidates = await db
    .select({ id: schema.deploymentPublishJobs.id })
    .from(schema.deploymentPublishJobs)
    .where(and(activeRanges, expired))
    .orderBy(asc(schema.deploymentPublishJobs.updatedAt), asc(schema.deploymentPublishJobs.id))
    .limit(settings.sweepLimit);
  const updates = candidates.map((candidate) =>
    db
      .update(schema.deploymentPublishJobs)
      .set({
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        retryable: true,
        errorCode: sql`CASE WHEN ${schema.deploymentPublishJobs.createdAt} <= ${deadlineCutoff} THEN 'deadline_exceeded' ELSE 'stalled' END`,
        errorMessage:
          'Publish job stopped reporting progress or exceeded its overall deadline. Inspect events before retrying.',
      })
      .where(
        and(
          eq(schema.deploymentPublishJobs.id, candidate.id),
          notInArray(schema.deploymentPublishJobs.status, [...PUBLISH_JOB_TERMINAL_STATUSES]),
          expired
        )
      )
      .returning()
  );
  const [first, ...remaining] = updates;
  if (!first) return [];
  // One bounded D1 batch preserves each conditional expiry check while reducing
  // round trips. Lifecycle delivery remains outside this transaction.
  const results = await db.batch([first, ...remaining]);
  return results.flat();
}
