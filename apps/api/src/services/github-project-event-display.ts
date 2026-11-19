import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import type { GitHubWebhookEvent } from './github-trigger-filter';

export function buildGitHubProjectEventDisplay(
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
    case 'commit':
      return `Commit ${subject.id.slice(0, 12)}`;
    case 'check_run':
      return `Check run ${subject.id}`;
    case 'check_suite':
      return `Check suite ${subject.id}`;
    case 'workflow_run':
      return `Workflow run ${subject.id}`;
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
  const key = displayPayloadKey(event.event);
  const item = recordValue(payload[key]);
  return (
    stringValue(item?.html_url) ??
    (event.event === 'check_run' ? stringValue(item?.details_url) : null) ??
    stringValue(recordValue(payload.repository)?.html_url)
  );
}

function displayPayloadKey(event: string): string {
  switch (event) {
    case 'issue_comment':
    case 'pull_request_review_comment':
      return 'comment';
    case 'issues':
      return 'issue';
    case 'pull_request':
      return 'pull_request';
    case 'pull_request_review':
      return 'review';
    case 'check_run':
      return 'check_run';
    case 'workflow_run':
      return 'workflow_run';
    default:
      return 'repository';
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
