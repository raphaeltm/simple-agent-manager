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
  push: [],
};

export const GITHUB_TRIGGER_DEFAULT_ACTIONS: Record<GitHubTriggerEventType, string> = {
  issue_comment: 'created',
  issues: 'opened',
  pull_request: 'opened',
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
