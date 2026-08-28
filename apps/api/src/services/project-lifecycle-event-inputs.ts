import type {
  AdmitProjectEventInput,
  ProjectEventJsonValue,
  ProjectEventMetadata,
  ProjectEventSeverity,
  ProjectEventSubject,
  TaskStatus,
  TaskTerminalStatus,
} from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';

export const PROJECT_LIFECYCLE_EVENT_SOURCE = 'sam.lifecycle';

// Use B4's ProjectData admission defaults as producer-side caps so lifecycle
// emitters never forward raw callback/task payloads to ProjectData.
const PRODUCER_LIMITS = DEFAULT_PROJECT_EVENT_LIMITS;
const FILTER_STRING_MAX_BYTES = PRODUCER_LIMITS.maxFilterStringBytes;
const TEXT_MAX_BYTES = PRODUCER_LIMITS.maxReasonBytes;
const METADATA_MAX_DEPTH = PRODUCER_LIMITS.maxMetadataDepth;
const METADATA_MAX_KEYS = PRODUCER_LIMITS.maxMetadataKeys;
const METADATA_ARRAY_MAX_ITEMS = PRODUCER_LIMITS.maxMetadataArrayItems;
const DISPLAY_LABEL_MAX_COUNT = PRODUCER_LIMITS.maxDisplayLabels;
const TRUNCATION_SUFFIX = '...[truncated]';

type LifecycleSubjectType =
  | 'task'
  | 'session'
  | 'deployment_environment'
  | 'deployment_publish_job'
  | 'deployment_release';

type LifecycleTaskStatus = Extract<TaskStatus, 'in_progress' | TaskTerminalStatus>;
type DeploymentReleaseLifecycleStatus = 'created' | 'applying' | 'applied' | 'failed';
type DeploymentEnvironmentLifecycleKind =
  | 'created'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'deleted'
  | 'observed';
type SessionLifecycleKind = 'started' | 'sleeping' | 'woke' | 'archived' | 'failed';

type LifecycleDisplayInput = {
  title?: string | null;
  summary?: string | null;
  url?: string | null;
  labels?: Array<string | null | undefined> | null;
};

type LifecycleMetadataInput = Record<string, ProjectEventJsonValue | undefined>;

type BuildLifecycleEventInput = {
  projectId: string;
  eventType: string;
  subject: ProjectEventSubject;
  severity?: ProjectEventSeverity;
  deliveryKey: string;
  metadata?: LifecycleMetadataInput;
  display?: LifecycleDisplayInput;
  occurredAt?: string | number | null;
  receivedAt?: string | number | null;
};

export type TaskLifecycleEventInput = {
  projectId: string;
  taskId: string;
  status: LifecycleTaskStatus;
  fromStatus?: string | null;
  parentTaskId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  nodeId?: string | null;
  agentSessionId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  reason?: string | null;
  source: string;
  occurredAt?: string | number | null;
  title?: string | null;
};

export type SessionLifecycleEventInput = {
  projectId: string;
  sessionId: string;
  lifecycle: SessionLifecycleKind;
  status: string;
  taskId?: string | null;
  workspaceId?: string | null;
  messageCount?: number | null;
  reason?: string | null;
  source: string;
  occurredAt?: string | number | null;
};

export type DeploymentReleaseLifecycleEventInput = {
  projectId: string;
  releaseId: string;
  environmentId: string;
  status: DeploymentReleaseLifecycleStatus;
  fromStatus?: string | null;
  version?: number | null;
  nodeId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  source: string;
  occurredAt?: string | number | null;
};

export type DeploymentEnvironmentLifecycleEventInput = {
  projectId: string;
  environmentId: string;
  lifecycle: DeploymentEnvironmentLifecycleKind;
  status?: string | null;
  fromStatus?: string | null;
  observedStatus?: string | null;
  observedAppliedSeq?: number | null;
  releaseId?: string | null;
  releaseVersion?: number | null;
  nodeId?: string | null;
  userId?: string | null;
  source: string;
  occurredAt?: string | number | null;
};

export type DeploymentPublishJobLifecycleEventInput = {
  projectId: string;
  publishJobId: string;
  environmentId: string;
  status: string;
  fromStatus?: string | null;
  currentStep?: string | null;
  nodeId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  releaseId?: string | null;
  releaseVersion?: number | null;
  terminal?: boolean | null;
  source: string;
  occurredAt?: string | number | null;
};

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  const payloadMax = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= payloadMax) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${TRUNCATION_SUFFIX}`;
}

function boundedIdentifier(value: string): string {
  return truncateUtf8(value.trim(), FILTER_STRING_MAX_BYTES);
}

function boundedText(value: string): string {
  return truncateUtf8(value.trim(), TEXT_MAX_BYTES);
}

function optionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? boundedText(trimmed) : undefined;
}

function optionalIdentifier(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? boundedIdentifier(trimmed) : undefined;
}

function normalizeTimestamp(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeJsonValue(
  value: ProjectEventJsonValue | undefined,
  depth = 0
): ProjectEventJsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    return boundedText(value);
  }
  if (Array.isArray(value)) {
    if (depth >= METADATA_MAX_DEPTH) return [];
    return value
      .slice(0, METADATA_ARRAY_MAX_ITEMS)
      .map((item) => normalizeJsonValue(item, depth + 1))
      .filter((item): item is ProjectEventJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth >= METADATA_MAX_DEPTH) return {};
    const entries = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, METADATA_MAX_KEYS);
    const normalized: ProjectEventMetadata = {};
    for (const [key, nestedValue] of entries) {
      const normalizedValue = normalizeJsonValue(nestedValue, depth + 1);
      if (normalizedValue !== undefined) {
        normalized[boundedIdentifier(key)] = normalizedValue;
      }
    }
    return normalized;
  }
  return undefined;
}

function normalizeMetadata(input: LifecycleMetadataInput | undefined): ProjectEventMetadata {
  const normalized: ProjectEventMetadata = {};
  const entries = Object.entries(input ?? {}).slice(0, METADATA_MAX_KEYS);
  for (const [key, value] of entries) {
    const normalizedValue = normalizeJsonValue(value);
    if (normalizedValue !== undefined) {
      normalized[boundedIdentifier(key)] = normalizedValue;
    }
  }
  return normalized;
}

function normalizeDisplay(
  display: LifecycleDisplayInput | undefined
): AdmitProjectEventInput['display'] {
  if (!display) return undefined;
  const title = optionalText(display.title);
  const summary = optionalText(display.summary);
  const url = optionalText(display.url);
  const labels = (display.labels ?? [])
    .map((label) => optionalIdentifier(label))
    .filter((label): label is string => Boolean(label))
    .slice(0, DISPLAY_LABEL_MAX_COUNT);
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(url ? { url } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

function stableSort(value: ProjectEventJsonValue): ProjectEventJsonValue {
  if (Array.isArray(value)) {
    return value.map(stableSort);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, stableSort(nestedValue)])
    );
  }
  return value;
}

function stableStringify(value: ProjectEventJsonValue): string {
  return JSON.stringify(stableSort(value));
}

async function fingerprint(value: ProjectEventJsonValue): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(stableStringify(value)));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `sha256:${hex}`;
}

async function buildProjectLifecycleEventInput(
  input: BuildLifecycleEventInput
): Promise<AdmitProjectEventInput> {
  const severity = input.severity ?? 'info';
  const metadata = normalizeMetadata(input.metadata);
  const display = normalizeDisplay(input.display);
  const eventType = boundedIdentifier(input.eventType);
  const subject = {
    type: boundedIdentifier(input.subject.type),
    id: boundedIdentifier(input.subject.id),
  };
  const event: AdmitProjectEventInput = {
    projectId: boundedIdentifier(input.projectId),
    source: PROJECT_LIFECYCLE_EVENT_SOURCE,
    eventType,
    subject,
    severity,
    deliveryKey: boundedIdentifier(input.deliveryKey),
    payloadFingerprint: await fingerprint({
      source: PROJECT_LIFECYCLE_EVENT_SOURCE,
      eventType,
      subject,
      severity,
      metadata,
      display: (display ?? {}) as ProjectEventJsonValue,
    }),
    metadata,
    ...(display ? { display } : {}),
  };
  const occurredAt = normalizeTimestamp(input.occurredAt);
  const receivedAt = normalizeTimestamp(input.receivedAt);
  if (occurredAt !== undefined) event.occurredAt = occurredAt;
  if (receivedAt !== undefined) event.receivedAt = receivedAt;
  return event;
}

function lifecycleSubject(type: LifecycleSubjectType, id: string): ProjectEventSubject {
  return { type, id };
}

function lifecycleKey(...parts: Array<string | number | null | undefined>): string {
  return boundedIdentifier(
    parts
      .filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
      .map((part) => String(part).trim())
      .join(':')
  );
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export function taskLifecycleEventType(status: LifecycleTaskStatus): string {
  return status === 'in_progress' ? 'task.started' : `task.${status}`;
}

function taskSeverity(status: LifecycleTaskStatus): ProjectEventSeverity {
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'warning';
  return 'info';
}

export function isLifecycleTaskStatus(status: string): status is LifecycleTaskStatus {
  return ['in_progress', 'completed', 'failed', 'cancelled'].includes(status);
}

export async function buildTaskLifecycleEventInput(
  input: TaskLifecycleEventInput
): Promise<AdmitProjectEventInput> {
  const eventType = taskLifecycleEventType(input.status);
  const displayStatus = input.status === 'in_progress' ? 'started' : statusLabel(input.status);
  return buildProjectLifecycleEventInput({
    projectId: input.projectId,
    eventType,
    subject: lifecycleSubject('task', input.taskId),
    severity: taskSeverity(input.status),
    deliveryKey: lifecycleKey('task', input.taskId, 'status', input.status),
    occurredAt: input.occurredAt,
    metadata: {
      taskId: input.taskId,
      status: input.status,
      fromStatus: optionalIdentifier(input.fromStatus) ?? null,
      parentTaskId: optionalIdentifier(input.parentTaskId) ?? null,
      workspaceId: optionalIdentifier(input.workspaceId) ?? null,
      sessionId: optionalIdentifier(input.sessionId) ?? null,
      nodeId: optionalIdentifier(input.nodeId) ?? null,
      agentSessionId: optionalIdentifier(input.agentSessionId) ?? null,
      actorType: optionalIdentifier(input.actorType) ?? null,
      actorId: optionalIdentifier(input.actorId) ?? null,
      reason: optionalText(input.reason) ?? null,
      transitionSource: boundedIdentifier(input.source),
    },
    display: {
      title: `Task ${displayStatus}`,
      summary: input.title
        ? `${boundedText(input.title)} ${displayStatus}.`
        : `Task ${input.taskId} ${displayStatus}.`,
      labels: ['task', input.status],
    },
  });
}

export async function buildSessionLifecycleEventInput(
  input: SessionLifecycleEventInput
): Promise<AdmitProjectEventInput> {
  return buildProjectLifecycleEventInput({
    projectId: input.projectId,
    eventType: `session.${input.lifecycle}`,
    subject: lifecycleSubject('session', input.sessionId),
    severity: input.lifecycle === 'failed' ? 'error' : 'info',
    deliveryKey: lifecycleKey('session', input.sessionId, input.lifecycle, input.occurredAt),
    occurredAt: input.occurredAt,
    metadata: {
      sessionId: input.sessionId,
      status: optionalIdentifier(input.status) ?? null,
      taskId: optionalIdentifier(input.taskId) ?? null,
      workspaceId: optionalIdentifier(input.workspaceId) ?? null,
      messageCount: input.messageCount ?? null,
      reason: optionalText(input.reason) ?? null,
      transitionSource: boundedIdentifier(input.source),
    },
    display: {
      title: `Session ${statusLabel(input.lifecycle)}`,
      summary: `Session ${input.sessionId} ${statusLabel(input.lifecycle)}.`,
      labels: ['session', input.lifecycle],
    },
  });
}

export async function buildDeploymentReleaseLifecycleEventInput(
  input: DeploymentReleaseLifecycleEventInput
): Promise<AdmitProjectEventInput> {
  return buildProjectLifecycleEventInput({
    projectId: input.projectId,
    eventType: `deployment.release.${input.status}`,
    subject: lifecycleSubject('deployment_release', input.releaseId),
    severity: input.status === 'failed' ? 'error' : 'info',
    deliveryKey: lifecycleKey('deployment_release', input.releaseId, 'status', input.status),
    occurredAt: input.occurredAt,
    metadata: {
      releaseId: input.releaseId,
      environmentId: input.environmentId,
      status: input.status,
      fromStatus: optionalIdentifier(input.fromStatus) ?? null,
      version: input.version ?? null,
      nodeId: optionalIdentifier(input.nodeId) ?? null,
      workspaceId: optionalIdentifier(input.workspaceId) ?? null,
      taskId: optionalIdentifier(input.taskId) ?? null,
      transitionSource: boundedIdentifier(input.source),
    },
    display: {
      title: `Deployment release ${statusLabel(input.status)}`,
      summary: `Deployment release ${input.releaseId} ${statusLabel(input.status)}.`,
      labels: ['deployment', 'release', input.status],
    },
  });
}

export async function buildDeploymentEnvironmentLifecycleEventInput(
  input: DeploymentEnvironmentLifecycleEventInput
): Promise<AdmitProjectEventInput> {
  const eventType = `deployment.environment.${input.lifecycle}`;
  const deliveryKey =
    input.lifecycle === 'observed'
      ? lifecycleKey(
          'deployment_environment',
          input.environmentId,
          'observed',
          input.observedStatus,
          input.observedAppliedSeq ?? 'none'
        )
      : lifecycleKey(
          'deployment_environment',
          input.environmentId,
          'lifecycle',
          input.lifecycle,
          input.occurredAt
        );

  return buildProjectLifecycleEventInput({
    projectId: input.projectId,
    eventType,
    subject: lifecycleSubject('deployment_environment', input.environmentId),
    severity: input.lifecycle === 'error' ? 'error' : 'info',
    deliveryKey,
    occurredAt: input.occurredAt,
    metadata: {
      environmentId: input.environmentId,
      lifecycle: input.lifecycle,
      status: optionalIdentifier(input.status) ?? null,
      fromStatus: optionalIdentifier(input.fromStatus) ?? null,
      observedStatus: optionalIdentifier(input.observedStatus) ?? null,
      observedAppliedSeq: input.observedAppliedSeq ?? null,
      releaseId: optionalIdentifier(input.releaseId) ?? null,
      releaseVersion: input.releaseVersion ?? null,
      nodeId: optionalIdentifier(input.nodeId) ?? null,
      userId: optionalIdentifier(input.userId) ?? null,
      transitionSource: boundedIdentifier(input.source),
    },
    display: {
      title: `Deployment environment ${statusLabel(input.lifecycle)}`,
      summary: `Deployment environment ${input.environmentId} ${statusLabel(input.lifecycle)}.`,
      labels: ['deployment', 'environment', input.lifecycle],
    },
  });
}

export async function buildDeploymentPublishJobLifecycleEventInput(
  input: DeploymentPublishJobLifecycleEventInput
): Promise<AdmitProjectEventInput> {
  const status = boundedIdentifier(input.status.toLowerCase());
  return buildProjectLifecycleEventInput({
    projectId: input.projectId,
    eventType: `deployment.publish_job.${status}`,
    subject: lifecycleSubject('deployment_publish_job', input.publishJobId),
    severity: ['failed', 'canceled', 'unknown'].includes(status) ? 'error' : 'info',
    deliveryKey: lifecycleKey('deployment_publish_job', input.publishJobId, 'status', status),
    occurredAt: input.occurredAt,
    metadata: {
      publishJobId: input.publishJobId,
      environmentId: input.environmentId,
      status,
      fromStatus: optionalIdentifier(input.fromStatus) ?? null,
      currentStep: optionalText(input.currentStep) ?? null,
      nodeId: optionalIdentifier(input.nodeId) ?? null,
      workspaceId: optionalIdentifier(input.workspaceId) ?? null,
      taskId: optionalIdentifier(input.taskId) ?? null,
      releaseId: optionalIdentifier(input.releaseId) ?? null,
      releaseVersion: input.releaseVersion ?? null,
      terminal: input.terminal === true,
      transitionSource: boundedIdentifier(input.source),
    },
    display: {
      title: `Deployment publish job ${statusLabel(status)}`,
      summary: `Deployment publish job ${input.publishJobId} ${statusLabel(status)}.`,
      labels: ['deployment', 'publish_job', status],
    },
  });
}
