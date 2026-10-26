import type { GitHubTriggerEventType } from './types/trigger';

/** GitHub webhook action contract, audited 2026-10-13 against
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads
 * push has no action property. This is protocol data, not a deployment setting. */
export const GITHUB_TRIGGER_ACTIONS: Record<GitHubTriggerEventType, readonly string[]> = {
  issue_comment: ['created', 'deleted', 'edited', 'pinned', 'unpinned'],
  issues: [
    'assigned',
    'closed',
    'deleted',
    'demilestoned',
    'edited',
    'field_added',
    'field_removed',
    'labeled',
    'locked',
    'milestoned',
    'opened',
    'pinned',
    'reopened',
    'transferred',
    'typed',
    'unassigned',
    'unlabeled',
    'unlocked',
    'unpinned',
    'untyped',
  ],
  pull_request: [
    'assigned',
    'auto_merge_disabled',
    'auto_merge_enabled',
    'closed',
    'converted_to_draft',
    'demilestoned',
    'dequeued',
    'edited',
    'enqueued',
    'labeled',
    'locked',
    'milestoned',
    'opened',
    'ready_for_review',
    'reopened',
    'review_request_removed',
    'review_requested',
    'stacked',
    'synchronize',
    'unassigned',
    'unlabeled',
    'unlocked',
  ],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  pull_request_review_comment: ['created', 'edited', 'deleted'],
  push: [],
};

export const GITHUB_TRIGGER_DEFAULT_ACTIONS: Record<GitHubTriggerEventType, string> = {
  issue_comment: 'created',
  issues: 'opened',
  pull_request: 'opened',
  pull_request_review: 'submitted',
  pull_request_review_comment: 'created',
  push: '',
};

export function areGitHubTriggerActionsValid(
  eventType: GitHubTriggerEventType,
  actions?: readonly string[]
): boolean {
  return (
    !actions?.length ||
    actions.every((action) => GITHUB_TRIGGER_ACTIONS[eventType].includes(action))
  );
}

/** These scopes are shared by filtering, serializers and presentation. */
export function isGitHubCommentEvent(event: string): boolean {
  return ['issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(event);
}
export function isGitHubPullRequestEvent(event: string): boolean {
  return ['pull_request', 'pull_request_review', 'pull_request_review_comment'].includes(event);
}
export const GITHUB_AUTHOR_ASSOCIATIONS = [
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR',
  'MANNEQUIN',
  'MEMBER',
  'NONE',
  'OWNER',
] as const;
export const GITHUB_REVIEW_STATES = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
  'pending',
] as const;
export const GITHUB_TEMPLATE_KEYS = [
  'event',
  'action',
  'actor',
  'repository',
  'number',
  'title',
  'body',
  'comment',
  'labels',
  'branch',
  'sha',
  'commentId',
  'commentUrl',
  'isPullRequest',
  'authorAssociation',
  'url',
  'reviewState',
  'path',
  'line',
] as const;
