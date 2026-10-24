import type {
  AdmitProjectEventInput,
  ProjectEventAdmissionOutcome,
  ProjectEventMetadata,
  ProjectEventSeverity,
} from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { log } from '../lib/logger';
import { buildGitHubProjectEventDisplay } from './github-project-event-display';
import { findProjectsForGitHubRepository } from './github-project-repositories';
import { type GitHubWebhookEvent, parseWebhookPayload } from './github-trigger-filter';
import * as projectDataService from './project-data';

const GITHUB_EVENT_SOURCE = 'github';
const SUPPORTED_GITHUB_PROJECT_EVENT_TYPES = new Set([
  'check_run',
  'check_suite',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'repository',
  'workflow_run',
]);

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
  const display = buildGitHubProjectEventDisplay(event, payload, subject, eventType);

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
  if (['check_run', 'check_suite', 'workflow_run'].includes(event.event)) {
    const headSha = githubHeadSha(payload);
    if (headSha) return { type: 'commit', id: headSha };
    const checkRunId = jsonStringOrNull(recordValue(payload.check_run)?.id);
    if (checkRunId) return { type: 'check_run', id: checkRunId };
    const checkSuiteId = jsonStringOrNull(recordValue(payload.check_suite)?.id);
    if (checkSuiteId) return { type: 'check_suite', id: checkSuiteId };
    const workflowRunId = jsonStringOrNull(recordValue(payload.workflow_run)?.id);
    if (workflowRunId) return { type: 'workflow_run', id: workflowRunId };
  }
  if (event.event === 'pull_request' && event.pull_request?.number) {
    return { type: 'pull_request', id: String(event.pull_request.number) };
  }
  if (
    (event.event === 'pull_request_review' || event.event === 'pull_request_review_comment') &&
    event.pull_request?.number
  ) {
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
  const checkRun = recordValue(payload.check_run);
  const checkSuite = recordValue(payload.check_suite);
  const workflowRun = recordValue(payload.workflow_run);
  const review = recordValue(payload.review);

  const metadata: ProjectEventMetadata = {
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
  };

  if (pullRequest || event.pull_request) {
    metadata.pullRequest = {
      number: jsonStringOrNull(pullRequest?.number ?? event.pull_request?.number),
      state: stringValue(pullRequest?.state) ?? null,
      draft: booleanValue(pullRequest?.draft ?? event.pull_request?.draft),
      merged: booleanValue(pullRequest?.merged),
      headRef:
        stringValue(recordValue(pullRequest?.head)?.ref ?? event.pull_request?.head?.ref) ?? null,
      baseRef:
        stringValue(recordValue(pullRequest?.base)?.ref ?? event.pull_request?.base?.ref) ?? null,
      url: stringValue(pullRequest?.html_url) ?? null,
      headSha: stringValue(recordValue(pullRequest?.head)?.sha) ?? null,
    };
  }

  if (event.event === 'issues' || event.event === 'issue_comment') {
    metadata.issue = {
      number: jsonStringOrNull(issue?.number ?? event.issue?.number),
      state: stringValue(issue?.state) ?? null,
      url: stringValue(issue?.html_url) ?? null,
      isPullRequest: isPullRequestComment(payload),
    };
  }

  if (event.event === 'issue_comment') {
    metadata.comment = {
      id: jsonStringOrNull(comment?.id),
      url: stringValue(comment?.html_url) ?? null,
    };
  }

  if (event.event === 'push') {
    metadata.push = {
      ref: event.ref ?? null,
      branch: event.ref ? event.ref.replace(/^refs\/heads\//, '') : null,
      headSha: stringValue(headCommit?.id ?? event.head_commit?.id) ?? null,
    };
  }

  if (event.event === 'check_run') {
    metadata.checkRun = {
      id: jsonStringOrNull(checkRun?.id),
      name: stringValue(checkRun?.name) ?? null,
      status: stringValue(checkRun?.status) ?? null,
      conclusion: stringValue(checkRun?.conclusion) ?? null,
      headSha: stringValue(checkRun?.head_sha) ?? null,
      checkSuiteId: jsonStringOrNull(recordValue(checkRun?.check_suite)?.id),
      externalId: jsonStringOrNull(checkRun?.external_id),
      detailsUrl: stringValue(checkRun?.details_url) ?? null,
      htmlUrl: stringValue(checkRun?.html_url) ?? null,
      pullRequests: pullRequestNumbers(checkRun?.pull_requests),
    };
  }

  if (event.event === 'check_suite') {
    metadata.checkSuite = {
      id: jsonStringOrNull(checkSuite?.id),
      status: stringValue(checkSuite?.status) ?? null,
      conclusion: stringValue(checkSuite?.conclusion) ?? null,
      headSha: stringValue(checkSuite?.head_sha) ?? null,
      beforeSha: stringValue(checkSuite?.before) ?? null,
      afterSha: stringValue(checkSuite?.after) ?? null,
      pullRequests: pullRequestNumbers(checkSuite?.pull_requests),
    };
  }

  if (event.event === 'workflow_run') {
    metadata.workflowRun = {
      id: jsonStringOrNull(workflowRun?.id),
      name: stringValue(workflowRun?.name) ?? null,
      runNumber: jsonStringOrNull(workflowRun?.run_number),
      runAttempt: jsonStringOrNull(workflowRun?.run_attempt),
      status: stringValue(workflowRun?.status) ?? null,
      conclusion: stringValue(workflowRun?.conclusion) ?? null,
      event: stringValue(workflowRun?.event) ?? null,
      headBranch: stringValue(workflowRun?.head_branch) ?? null,
      headSha: stringValue(workflowRun?.head_sha) ?? null,
      workflowId: jsonStringOrNull(workflowRun?.workflow_id),
      checkSuiteId: jsonStringOrNull(workflowRun?.check_suite_id),
      htmlUrl: stringValue(workflowRun?.html_url) ?? null,
      pullRequests: pullRequestNumbers(workflowRun?.pull_requests),
    };
  }

  if (event.event === 'pull_request_review') {
    metadata.review = {
      id: jsonStringOrNull(review?.id),
      state: stringValue(review?.state) ?? null,
      commitId: stringValue(review?.commit_id) ?? null,
      submittedAt: stringValue(review?.submitted_at) ?? null,
      url: stringValue(review?.html_url) ?? null,
    };
  }

  if (event.event === 'pull_request_review_comment') {
    metadata.reviewComment = {
      id: jsonStringOrNull(comment?.id),
      path: stringValue(comment?.path) ?? null,
      commitId: stringValue(comment?.commit_id) ?? null,
      originalCommitId: stringValue(comment?.original_commit_id) ?? null,
      line: jsonStringOrNull(comment?.line),
      originalLine: jsonStringOrNull(comment?.original_line),
      url: stringValue(comment?.html_url) ?? null,
    };
  }

  return metadata;
}

function resolveOccurredAt(payload: Record<string, unknown>, fallback: number): number {
  const pullRequest = recordValue(payload.pull_request);
  const issue = recordValue(payload.issue);
  const comment = recordValue(payload.comment);
  const repository = recordValue(payload.repository);
  const headCommit = recordValue(payload.head_commit);
  const checkRun = recordValue(payload.check_run);
  const checkSuite = recordValue(payload.check_suite);
  const workflowRun = recordValue(payload.workflow_run);
  const review = recordValue(payload.review);
  return (
    timestampValue(comment?.updated_at) ??
    timestampValue(comment?.created_at) ??
    timestampValue(review?.submitted_at) ??
    timestampValue(workflowRun?.updated_at) ??
    timestampValue(workflowRun?.run_started_at) ??
    timestampValue(checkRun?.completed_at) ??
    timestampValue(checkRun?.started_at) ??
    timestampValue(checkSuite?.updated_at) ??
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

function githubHeadSha(payload: Record<string, unknown>): string | null {
  const checkRun = recordValue(payload.check_run);
  const checkSuite = recordValue(payload.check_suite);
  const workflowRun = recordValue(payload.workflow_run);
  return (
    stringValue(checkRun?.head_sha) ??
    stringValue(checkSuite?.head_sha) ??
    stringValue(checkSuite?.after) ??
    stringValue(workflowRun?.head_sha) ??
    null
  );
}

function pullRequestNumbers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataArrayItems)
    .map((item) => jsonStringOrNull(recordValue(item)?.number))
    .filter((item): item is string => item !== null);
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
