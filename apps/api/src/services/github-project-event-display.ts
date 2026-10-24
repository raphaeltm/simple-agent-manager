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
  if (event.event === 'pull_request_review') {
    const reviewUrl = stringValue(recordValue(payload.review)?.html_url);
    if (reviewUrl) return reviewUrl;
  }
  if (event.event === 'pull_request_review_comment') {
    const reviewCommentUrl = stringValue(recordValue(payload.comment)?.html_url);
    if (reviewCommentUrl) return reviewCommentUrl;
  }
  if (event.event === 'check_run') {
    const checkRunUrl =
      stringValue(recordValue(payload.check_run)?.html_url) ??
      stringValue(recordValue(payload.check_run)?.details_url);
    if (checkRunUrl) return checkRunUrl;
  }
  if (event.event === 'workflow_run') {
    const workflowRunUrl = stringValue(recordValue(payload.workflow_run)?.html_url);
    if (workflowRunUrl) return workflowRunUrl;
  }
  return stringValue(recordValue(payload.repository)?.html_url) ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
