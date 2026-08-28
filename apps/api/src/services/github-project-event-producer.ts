import type {
  AdmitProjectEventInput,
  ProjectEventAdmissionOutcome,
  ProjectEventMetadata,
  ProjectEventSeverity,
} from '@simple-agent-manager/shared';
import { eq, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { log } from '../lib/logger';
import { type GitHubWebhookEvent, parseWebhookPayload } from './github-trigger-filter';
import * as projectDataService from './project-data';

const GITHUB_EVENT_SOURCE = 'github';
const SUPPORTED_GITHUB_PROJECT_EVENT_TYPES = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'push',
  'repository',
]);

type ProjectCandidate = {
  id: string;
  name: string;
};

export type GitHubProjectEventAdmission = {
  projectId: string;
  eventType: string;
  outcome: ProjectEventAdmissionOutcome;
  eventId: string;
  state: string;
};

export type AdmitGitHubWebhookProjectEventsResult = {
  processed: boolean;
  deliveryId: string;
  eventType: string;
  admittedEvents: GitHubProjectEventAdmission[];
  reason?: string;
};

export interface AdmitGitHubWebhookProjectEventsInput {
  deliveryId: string;
  eventType: string;
  payload: Record<string, unknown>;
  receivedAt?: number;
}

/**
 * Admit bounded ProjectData events for verified GitHub webhooks that already
 * flow through SAM. This is intentionally independent from GitHub trigger task
 * routing: admission records the project-scoped fact, while delivery matching
 * and prompt/runtime injection remain owned by the B4 subscription layer.
 */
export async function admitGitHubWebhookProjectEvents(
  env: Env,
  input: AdmitGitHubWebhookProjectEventsInput
): Promise<AdmitGitHubWebhookProjectEventsResult> {
  const deliveryId = input.deliveryId.trim();
  const eventType = input.eventType.trim();
  if (!deliveryId || !eventType) {
    return { processed: false, deliveryId, eventType, admittedEvents: [], reason: 'missing_key' };
  }
  if (!SUPPORTED_GITHUB_PROJECT_EVENT_TYPES.has(eventType)) {
    return {
      processed: false,
      deliveryId,
      eventType,
      admittedEvents: [],
      reason: `unsupported_event_type:${eventType}`,
    };
  }

  const event = parseWebhookPayload(eventType, input.payload);
  const repository = recordValue(input.payload.repository);
  const repositoryFullName = stringValue(repository?.full_name)?.toLowerCase() ?? null;
  const repositoryId = numberValue(repository?.id);
  if (!repositoryFullName && repositoryId === null) {
    return { processed: false, deliveryId, eventType, admittedEvents: [], reason: 'no_repository' };
  }

  const projects = await findProjectsForGitHubRepository(env, {
    repositoryFullName,
    repositoryId,
  });
  if (projects.length === 0) {
    return { processed: false, deliveryId, eventType, admittedEvents: [], reason: 'no_project' };
  }

  const receivedAt = input.receivedAt ?? Date.now();
  const payloadFingerprint = await fingerprintGitHubWebhookPayload(eventType, input.payload);
  const admittedEvents: GitHubProjectEventAdmission[] = [];

  for (const project of projects) {
    const eventInput = buildGitHubProjectEventInput({
      deliveryId,
      event,
      payload: input.payload,
      payloadFingerprint,
      receivedAt,
    });
    const result = await projectDataService.admitProjectEvent(env, project.id, eventInput);
    admittedEvents.push({
      projectId: project.id,
      eventType: eventInput.eventType,
      outcome: result.outcome,
      eventId: result.event.id,
      state: result.event.state,
    });
  }

  return {
    processed: admittedEvents.length > 0,
    deliveryId,
    eventType,
    admittedEvents,
  };
}

async function findProjectsForGitHubRepository(
  env: Env,
  input: { repositoryFullName: string | null; repositoryId: number | null }
): Promise<ProjectCandidate[]> {
  const predicates: SQL[] = [];
  if (input.repositoryFullName) {
    predicates.push(eq(schema.projects.repository, input.repositoryFullName));
  }
  if (input.repositoryId !== null) {
    predicates.push(eq(schema.projects.githubRepoId, input.repositoryId));
  }
  if (predicates.length === 0) return [];

  const db = drizzle(env.DATABASE, { schema });
  const where = predicates.length === 1 ? predicates[0] : or(...predicates);
  return db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
    })
    .from(schema.projects)
    .where(where);
}

function buildGitHubProjectEventInput(input: {
  deliveryId: string;
  event: GitHubWebhookEvent;
  payload: Record<string, unknown>;
  payloadFingerprint: string;
  receivedAt: number;
}): Omit<AdmitProjectEventInput, 'projectId'> {
  const { deliveryId, event, payload, payloadFingerprint, receivedAt } = input;
  const subject = resolveSubject(event, payload);
  const eventType = projectDataEventType(event);
  const metadata = buildMetadata(event, payload, deliveryId, subject);
  const display = buildDisplay(event, payload, subject, eventType);

  return {
    source: GITHUB_EVENT_SOURCE,
    eventType,
    subject,
    severity: resolveSeverity(event),
    deliveryKey: `delivery:${deliveryId}`,
    payloadFingerprint,
    metadata,
    display,
    occurredAt: resolveOccurredAt(payload, receivedAt),
    receivedAt,
  };
}

function projectDataEventType(event: GitHubWebhookEvent): string {
  return event.action ? `${event.event}.${event.action}` : event.event;
}

function resolveSubject(
  event: GitHubWebhookEvent,
  payload: Record<string, unknown>
): AdmitProjectEventInput['subject'] {
  if (event.event === 'pull_request' && event.pull_request?.number) {
    return { type: 'pull_request', id: String(event.pull_request.number) };
  }
  if (event.event === 'issues' && event.issue?.number) {
    return { type: 'issue', id: String(event.issue.number) };
  }
  if (event.event === 'issue_comment' && event.issue?.number) {
    return {
      type: isPullRequestComment(payload) ? 'pull_request' : 'issue',
      id: String(event.issue.number),
    };
  }

  const repository = recordValue(payload.repository);
  const repositoryId = numberValue(repository?.id);
  const repositoryFullName = stringValue(repository?.full_name);
  return {
    type: 'repository',
    id: repositoryId !== null ? String(repositoryId) : (repositoryFullName ?? 'unknown'),
  };
}

function resolveSeverity(event: GitHubWebhookEvent): ProjectEventSeverity {
  if (
    event.event === 'repository' &&
    (event.action === 'deleted' || event.action === 'transferred')
  ) {
    return 'warning';
  }
  return 'info';
}

function buildMetadata(
  event: GitHubWebhookEvent,
  payload: Record<string, unknown>,
  deliveryId: string,
  subject: AdmitProjectEventInput['subject']
): ProjectEventMetadata {
  const repository = recordValue(payload.repository);
  const installation = recordValue(payload.installation);
  const pullRequest = recordValue(payload.pull_request);
  const issue = recordValue(payload.issue);
  const comment = recordValue(payload.comment);
  const headCommit = recordValue(payload.head_commit);

  return {
    provider: 'github',
    deliveryId,
    event: event.event,
    action: event.action ?? null,
    subject: {
      type: subject.type,
      id: subject.id,
    },
    repository: {
      id: jsonStringOrNull(repository?.id),
      fullName: stringValue(repository?.full_name)?.toLowerCase() ?? null,
      defaultBranch: stringValue(repository?.default_branch) ?? null,
    },
    actor: {
      login: event.sender?.login ?? null,
      type: event.sender?.type ?? null,
    },
    installation: {
      id: jsonStringOrNull(installation?.id),
    },
    pullRequest: {
      number: jsonStringOrNull(pullRequest?.number ?? event.pull_request?.number),
      state: stringValue(pullRequest?.state) ?? null,
      draft: booleanValue(pullRequest?.draft ?? event.pull_request?.draft),
      merged: booleanValue(pullRequest?.merged),
      headRef:
        stringValue(recordValue(pullRequest?.head)?.ref ?? event.pull_request?.head?.ref) ?? null,
      baseRef:
        stringValue(recordValue(pullRequest?.base)?.ref ?? event.pull_request?.base?.ref) ?? null,
      url: stringValue(pullRequest?.html_url) ?? null,
    },
    issue: {
      number: jsonStringOrNull(issue?.number ?? event.issue?.number),
      state: stringValue(issue?.state) ?? null,
      url: stringValue(issue?.html_url) ?? null,
      isPullRequest: isPullRequestComment(payload),
    },
    comment: {
      id: jsonStringOrNull(comment?.id),
      url: stringValue(comment?.html_url) ?? null,
    },
    push: {
      ref: event.ref ?? null,
      branch: event.ref ? event.ref.replace(/^refs\/heads\//, '') : null,
      headSha: stringValue(headCommit?.id ?? event.head_commit?.id) ?? null,
    },
  };
}

function buildDisplay(
  event: GitHubWebhookEvent,
  payload: Record<string, unknown>,
  subject: AdmitProjectEventInput['subject'],
  eventType: string
): AdmitProjectEventInput['display'] {
  const repository = recordValue(payload.repository);
  const repo = stringValue(repository?.full_name)?.toLowerCase() ?? 'repository';
  const action = event.action ? ` ${event.action.replaceAll('_', ' ')}` : '';
  const url = displayUrlForEvent(event, payload);
  return {
    title: `${displaySubject(subject)}${action}`,
    summary: `${event.sender?.login ?? 'GitHub'} emitted ${eventType} on ${repo}`,
    url: url ?? undefined,
    labels: event.action ? ['github', event.event, event.action] : ['github', event.event],
  };
}

function displaySubject(subject: AdmitProjectEventInput['subject']): string {
  switch (subject.type) {
    case 'pull_request':
      return `Pull request #${subject.id}`;
    case 'issue':
      return `Issue #${subject.id}`;
    case 'repository':
      return `Repository ${subject.id}`;
    default:
      return `${subject.type} ${subject.id}`;
  }
}

function displayUrlForEvent(
  event: GitHubWebhookEvent,
  payload: Record<string, unknown>
): string | null {
  if (event.event === 'issue_comment') {
    const commentUrl = stringValue(recordValue(payload.comment)?.html_url);
    if (commentUrl) return commentUrl;
  }
  if (event.event === 'issues') {
    const issueUrl = stringValue(recordValue(payload.issue)?.html_url);
    if (issueUrl) return issueUrl;
  }
  if (event.event === 'pull_request') {
    const pullRequestUrl = stringValue(recordValue(payload.pull_request)?.html_url);
    if (pullRequestUrl) return pullRequestUrl;
  }
  return stringValue(recordValue(payload.repository)?.html_url) ?? null;
}

function resolveOccurredAt(payload: Record<string, unknown>, fallback: number): number {
  const pullRequest = recordValue(payload.pull_request);
  const issue = recordValue(payload.issue);
  const comment = recordValue(payload.comment);
  const repository = recordValue(payload.repository);
  const headCommit = recordValue(payload.head_commit);
  return (
    timestampValue(comment?.updated_at) ??
    timestampValue(comment?.created_at) ??
    timestampValue(pullRequest?.updated_at) ??
    timestampValue(pullRequest?.created_at) ??
    timestampValue(issue?.updated_at) ??
    timestampValue(issue?.created_at) ??
    timestampValue(headCommit?.timestamp) ??
    timestampValue(repository?.updated_at) ??
    fallback
  );
}

async function fingerprintGitHubWebhookPayload(
  eventType: string,
  payload: Record<string, unknown>
): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson({ eventType, payload }));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function isPullRequestComment(payload: Record<string, unknown>): boolean {
  return recordValue(recordValue(payload.issue)?.pull_request) !== null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function jsonStringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function handleGitHubProjectEventAdmission(
  env: Env,
  input: AdmitGitHubWebhookProjectEventsInput
): Promise<void> {
  try {
    const result = await admitGitHubWebhookProjectEvents(env, input);
    if (result.admittedEvents.length > 0) {
      log.info('github.webhook.project_events_admitted', {
        deliveryId: result.deliveryId,
        eventType: result.eventType,
        admittedEvents: result.admittedEvents.length,
        outcomes: result.admittedEvents.map((event) => event.outcome),
      });
    }
  } catch (err) {
    log.error('github.webhook.project_event_admission_error', {
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
