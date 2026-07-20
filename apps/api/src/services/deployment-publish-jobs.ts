import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export const PUBLISH_JOB_TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
  'unknown',
]);
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
  let text = typeof value === 'string' ? value : String(value ?? '');
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
): Promise<void> {
  const now = new Date().toISOString();
  const maxRows = await db
    .select({ maxSeq: sql<number>`coalesce(max(${schema.deploymentPublishJobEvents.seq}), 0)` })
    .from(schema.deploymentPublishJobEvents)
    .where(eq(schema.deploymentPublishJobEvents.publishJobId, input.publishJobId));
  const seq = Number(maxRows[0]?.maxSeq ?? 0) + 1;

  await db.insert(schema.deploymentPublishJobEvents).values({
    id: ulid(),
    publishJobId: input.publishJobId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    nodeId: input.nodeId,
    nodeIdentifier: input.nodeId,
    workspaceId: input.workspaceId,
    seq,
    level: normalizeLevel(input.level),
    eventType: sanitizePublishEventText(input.eventType, 200),
    step: input.currentStep ? sanitizePublishEventText(input.currentStep, 200) : null,
    message: sanitizePublishEventText(input.message),
    detailJson: sanitizeDetail(input.detail),
    createdAt: now,
  });

  const status = normalizeStatus(input.status);
  const terminal = input.terminal || (status ? PUBLISH_JOB_TERMINAL_STATUSES.has(status) : false);
  const update: Partial<schema.NewDeploymentPublishJobRow> = {
    updatedAt: now,
    lastEventAt: now,
  };
  if (status) update.status = status;
  if (input.currentStep !== undefined) update.currentStep = input.currentStep;
  if (input.releaseId !== undefined) update.releaseId = input.releaseId;
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

  await db
    .update(schema.deploymentPublishJobs)
    .set(update)
    .where(eq(schema.deploymentPublishJobs.id, input.publishJobId));
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
  const [job] = await db.select().from(schema.deploymentPublishJobs).where(where).limit(1);
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
      : 'Call get_publish_status again with publishJobId and sinceSeq until the status is terminal.',
  };
}
