import { isGitHubCommentEvent } from '@simple-agent-manager/shared';

import {
  getGitHubEventContent,
  type GitHubWebhookEvent,
  isPullRequestSubject,
} from './github-trigger-filter';

interface GitHubContextTrigger {
  id: string;
  name: string;
  description: string | null;
  triggerCount: number;
}

/** Build the stable template context shared by live and manual GitHub events. */
export function buildGitHubContext(
  event: GitHubWebhookEvent,
  trigger: GitHubContextTrigger,
  project: { id: string; name: string },
  executionId: string,
  sequenceNumber: number
): Record<string, unknown> {
  const labels = [...(event.issue?.labels ?? []), ...(event.pull_request?.labels ?? [])].map(
    (label) => label.name
  );
  const branch =
    event.event === 'push' && event.ref
      ? event.ref.replace(/^refs\/heads\//, '')
      : (event.pull_request?.head?.ref ?? '');

  const content = getGitHubEventContent(event);
  const comment = isGitHubCommentEvent(event.event)
    ? (content as { id?: number; html_url?: string } | undefined)
    : undefined;
  return {
    github: {
      event: event.event,
      action: event.action ?? '',
      actor: event.sender?.login ?? '',
      repository: event.repository?.full_name ?? '',
      number: String(event.issue?.number ?? event.pull_request?.number ?? ''),
      title: event.issue?.title ?? event.pull_request?.title ?? '',
      body: event.issue?.body ?? event.pull_request?.body ?? '',
      comment: ['issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(
        event.event
      )
        ? (content?.body ?? '')
        : '',
      commentId: String(comment?.id ?? ''),
      commentUrl: comment?.html_url ?? '',
      isPullRequest: String(isPullRequestSubject(event)),
      authorAssociation: content?.author_association ?? '',
      url:
        event.issue?.pull_request?.html_url ??
        event.issue?.html_url ??
        event.pull_request?.html_url ??
        '',
      reviewState: event.event === 'pull_request_review' ? (event.review?.state ?? '') : '',
      path: event.event === 'pull_request_review_comment' ? (event.comment?.path ?? '') : '',
      line:
        event.event === 'pull_request_review_comment'
          ? String(event.comment?.line ?? event.comment?.original_line ?? '')
          : '',
      labels: labels.join(', '),
      branch,
      sha: event.pull_request?.head?.sha ?? event.after ?? event.head_commit?.id ?? '',
    },
    trigger: {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description ?? '',
      fireCount: String((trigger.triggerCount ?? 0) + 1),
    },
    project: {
      id: project.id,
      name: project.name,
    },
    execution: {
      id: executionId,
      sequenceNumber: String(sequenceNumber),
    },
  };
}
