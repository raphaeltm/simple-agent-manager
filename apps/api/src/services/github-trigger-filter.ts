/**
 * GitHub Trigger Filter Engine
 *
 * Pure deterministic functions for matching GitHub webhook events against
 * trigger filter configurations. No side effects, no DB access — just filtering.
 *
 * All filters are AND-combined: every configured filter must pass for the event to match.
 * Empty/undefined filter fields mean "match all" for that dimension.
 */
import type { GitHubTriggerFilters } from '@simple-agent-manager/shared';

/** Parsed GitHub webhook event payload (the fields we care about for filtering). */
export interface GitHubWebhookEvent {
  event: string; // X-GitHub-Event header value
  action?: string; // payload.action
  sender?: { login: string; type?: string };
  repository?: { full_name: string; default_branch?: string };
  issue?: {
    number: number;
    title: string;
    body?: string;
    labels?: Array<{ name: string }>;
    draft?: boolean;
  };
  pull_request?: {
    number: number;
    title: string;
    body?: string;
    labels?: Array<{ name: string }>;
    draft?: boolean;
    head?: { ref: string };
    base?: { ref: string };
  };
  comment?: { body?: string };
  ref?: string; // for push events: 'refs/heads/main'
  head_commit?: { id: string; message?: string };
}

export interface FilterResult {
  matched: boolean;
  reason?: string;
}

/**
 * Evaluate all configured filters against a webhook event.
 * Returns { matched: true } if the event passes ALL filters,
 * or { matched: false, reason: '...' } with the first failing filter.
 */
export function evaluateFilters(
  event: GitHubWebhookEvent,
  filters: GitHubTriggerFilters
): FilterResult {
  // Action filter
  if (filters.actions && filters.actions.length > 0) {
    if (!event.action || !filters.actions.includes(event.action)) {
      return { matched: false, reason: `action '${event.action ?? ''}' not in [${filters.actions.join(', ')}]` };
    }
  }

  // Label filter — event must have ALL required labels
  if (filters.labels && filters.labels.length > 0) {
    const eventLabels = getEventLabels(event);
    const eventLabelSet = new Set(eventLabels.map((l) => l.toLowerCase()));
    for (const required of filters.labels) {
      if (!eventLabelSet.has(required.toLowerCase())) {
        return { matched: false, reason: `missing required label '${required}'` };
      }
    }
  }

  // Actor ignore filter
  if (filters.ignoreActors && filters.ignoreActors.length > 0) {
    const senderLogin = event.sender?.login;
    if (senderLogin) {
      const ignoredSet = new Set(filters.ignoreActors.map((a: string) => a.toLowerCase()));
      if (ignoredSet.has(senderLogin.toLowerCase())) {
        return { matched: false, reason: `actor '${senderLogin}' is in ignore list` };
      }
    }
  }

  // Command prefix filter (for issue_comment events)
  if (filters.commandPrefix) {
    const commentBody = event.comment?.body?.trim() ?? '';
    if (!commentBody.startsWith(filters.commandPrefix)) {
      return { matched: false, reason: `comment does not start with '${filters.commandPrefix}'` };
    }
  }

  // Body/title/comment contains filter (case-insensitive)
  if (filters.bodyContains) {
    const needle = filters.bodyContains.toLowerCase();
    const searchTexts = [
      event.issue?.title,
      event.issue?.body,
      event.pull_request?.title,
      event.pull_request?.body,
      event.comment?.body,
    ];
    const found = searchTexts.some((text) => text?.toLowerCase().includes(needle));
    if (!found) {
      return { matched: false, reason: `no title/body/comment contains '${filters.bodyContains}'` };
    }
  }

  // Branch filter (for push and PR events)
  if (filters.branches && filters.branches.length > 0) {
    const branch = getEventBranch(event);
    if (!branch) {
      return { matched: false, reason: 'no branch found in event' };
    }
    const branchSet = new Set(filters.branches.map((b: string) => b.toLowerCase()));
    if (!branchSet.has(branch.toLowerCase())) {
      return { matched: false, reason: `branch '${branch}' not in [${filters.branches.join(', ')}]` };
    }
  }

  // Draft filter (for PR events, default: ignore drafts)
  if (event.event === 'pull_request' && (filters.ignoreDrafts ?? true)) {
    if (event.pull_request?.draft) {
      return { matched: false, reason: 'pull request is a draft' };
    }
  }

  return { matched: true };
}

/** Extract label names from an event (issues or PRs). */
function getEventLabels(event: GitHubWebhookEvent): string[] {
  const labels = event.issue?.labels ?? event.pull_request?.labels ?? [];
  return labels.map((l) => l.name);
}

/** Extract the relevant branch name from an event. */
function getEventBranch(event: GitHubWebhookEvent): string | undefined {
  if (event.event === 'push' && event.ref) {
    // Push refs look like 'refs/heads/main'
    return event.ref.replace(/^refs\/heads\//, '');
  }
  if (event.event === 'pull_request') {
    return event.pull_request?.head?.ref;
  }
  return undefined;
}

/**
 * Parse a raw GitHub webhook payload into our normalized event shape.
 * This extracts only the fields we need for filtering.
 */
export function parseWebhookPayload(
  eventType: string,
  payload: Record<string, unknown>
): GitHubWebhookEvent {
  const sender = payload.sender as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;

  return {
    event: eventType,
    action: typeof payload.action === 'string' ? payload.action : undefined,
    sender: sender ? {
      login: String(sender.login ?? ''),
      type: typeof sender.type === 'string' ? sender.type : undefined,
    } : undefined,
    repository: repository ? {
      full_name: String(repository.full_name ?? ''),
      default_branch: typeof repository.default_branch === 'string' ? repository.default_branch : undefined,
    } : undefined,
    issue: issue ? {
      number: typeof issue.number === 'number' ? issue.number : 0,
      title: String(issue.title ?? ''),
      body: typeof issue.body === 'string' ? issue.body : undefined,
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((l: unknown) => ({ name: String((l as Record<string, unknown>)?.name ?? '') }))
        : undefined,
      draft: typeof issue.draft === 'boolean' ? issue.draft : undefined,
    } : undefined,
    pull_request: pullRequest ? {
      number: typeof pullRequest.number === 'number' ? pullRequest.number : 0,
      title: String(pullRequest.title ?? ''),
      body: typeof pullRequest.body === 'string' ? pullRequest.body : undefined,
      labels: Array.isArray(pullRequest.labels)
        ? pullRequest.labels.map((l: unknown) => ({ name: String((l as Record<string, unknown>)?.name ?? '') }))
        : undefined,
      draft: typeof pullRequest.draft === 'boolean' ? pullRequest.draft : undefined,
      head: pullRequest.head ? { ref: String((pullRequest.head as Record<string, unknown>).ref ?? '') } : undefined,
      base: pullRequest.base ? { ref: String((pullRequest.base as Record<string, unknown>).ref ?? '') } : undefined,
    } : undefined,
    comment: comment ? {
      body: typeof comment.body === 'string' ? comment.body : undefined,
    } : undefined,
    ref: typeof payload.ref === 'string' ? payload.ref : undefined,
    head_commit: payload.head_commit ? {
      id: String((payload.head_commit as Record<string, unknown>).id ?? ''),
      message: typeof (payload.head_commit as Record<string, unknown>).message === 'string'
        ? (payload.head_commit as Record<string, unknown>).message as string
        : undefined,
    } : undefined,
  };
}
