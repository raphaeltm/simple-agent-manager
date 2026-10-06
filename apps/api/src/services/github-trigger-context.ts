import type { GitHubWebhookEvent } from './github-trigger-filter';

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

  return {
    github: {
      event: event.event,
      action: event.action ?? '',
      actor: event.sender?.login ?? '',
      repository: event.repository?.full_name ?? '',
      number: String(event.issue?.number ?? event.pull_request?.number ?? ''),
      title: event.issue?.title ?? event.pull_request?.title ?? '',
      body: event.issue?.body ?? event.pull_request?.body ?? '',
      comment: event.comment?.body ?? '',
      labels: labels.join(', '),
      branch,
      sha: event.head_commit?.id ?? '',
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
