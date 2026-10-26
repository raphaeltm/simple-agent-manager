/**
 * Plain-language descriptions for the Automation page: what starts an automation, what an
 * agent is waiting for, and what a run did. Raw values (cron, filters, ids) stay available
 * under each item's "Advanced" section; these helpers are the default reading.
 */
import {
  AGENT_MESSAGE_CHANNEL_PREFIX,
  type GitHubTriggerEventType,
  type GitHubTriggerFilters,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_LIFECYCLE_EVENT_SOURCE,
  PROJECT_LIFECYCLE_EVENT_TYPES,
  type ProjectEventFilterV1,
  type ProjectEventSubscriptionRecord,
  type TriggerExecution,
  type WebhookDeliveryOutcome,
} from '@simple-agent-manager/shared';

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const orList = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;

export const shortId = (id: string, length = 7) => (id.length > length ? id.slice(0, length) : id);

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const GITHUB_SUBJECTS: Record<GitHubTriggerEventType, string> = {
  issues: 'an issue',
  issue_comment: 'a comment',
  pull_request: 'a pull request',
  push: 'a push',
};

const ACTION_WORDS: Record<string, string> = {
  synchronize: 'updated with new commits',
  ready_for_review: 'marked ready for review',
  converted_to_draft: 'turned into a draft',
  review_requested: 'sent for review',
};
const actionWord = (action: string) => ACTION_WORDS[action] ?? action.replaceAll('_', ' ');

/** "When someone comments /sam on an issue or PR", "When a pull request is opened on main". */
export function githubTriggerWhen(
  eventType: GitHubTriggerEventType,
  filters: GitHubTriggerFilters = {}
): string {
  const branches = filters.branches?.length ? ` on ${orList(filters.branches)}` : '';
  const labels = filters.labels?.length ? ` labeled ${filters.labels.join(' + ')}` : '';
  if (eventType === 'push') return `When code is pushed${branches.replace(' on ', ' to ')}`;
  if (eventType === 'issue_comment') {
    return filters.commandPrefix
      ? `When someone comments ${filters.commandPrefix} on an issue or PR`
      : 'When someone comments on an issue or PR';
  }
  // "labeled" with required labels reads as the label being added, not as a second condition.
  if (filters.actions?.length === 1 && filters.actions[0] === 'labeled' && filters.labels?.length)
    return `When ${GITHUB_SUBJECTS[eventType]} is labeled ${filters.labels.join(' + ')}${branches}`;
  const actions = filters.actions?.length ? orList(filters.actions.map(actionWord)) : 'changed';
  return `When ${GITHUB_SUBJECTS[eventType]}${labels} is ${actions}${branches}`;
}

export function webhookTriggerWhen(sourceLabel: string | null | undefined): string {
  return sourceLabel ? `When ${sourceLabel} calls its webhook` : 'When its webhook is called';
}

/** Before save there is no address yet; after save, name it so the automation reads concretely. */
export function emailTriggerWhen(address: string | null | undefined): string {
  return address
    ? `When an email arrives at ${address}`
    : 'When someone emails this automation’s address';
}

export const INCIDENT_TRIGGER_WHEN = 'When new private incidents arrive';

// ---------------------------------------------------------------------------
// Event filters (standing watches and agent subscriptions)
// ---------------------------------------------------------------------------

/** A noun ("a new issue") and a clause ("an issue is opened") for the same filter. */
export type EventPhrase = { noun: string; clause: string };

const EVENT_PHRASES: Record<string, EventPhrase> = {
  'issues.opened': { noun: 'a new issue', clause: 'an issue is opened' },
  'issues.labeled': { noun: 'an issue label', clause: 'an issue is labeled' },
  'issues.closed': { noun: 'an issue closing', clause: 'an issue is closed' },
  'issue_comment.created': { noun: 'a new comment', clause: 'someone comments on an issue or PR' },
  'pull_request.opened': { noun: 'a new pull request', clause: 'a pull request is opened' },
  'pull_request.closed': { noun: 'a pull request closing', clause: 'a pull request is closed' },
  'pull_request.synchronize': { noun: 'new commits on a PR', clause: 'a PR gets new commits' },
  'pull_request.review_requested': {
    noun: 'a review request',
    clause: 'someone requests a PR review',
  },
  'pull_request_review.submitted': { noun: 'a PR review', clause: 'a PR review is submitted' },
  'pull_request_review_comment.created': {
    noun: 'a review comment',
    clause: 'someone leaves a review comment',
  },
  push: { noun: 'a push', clause: 'code is pushed' },
  'check_run.completed': { noun: 'CI to finish', clause: 'CI finishes' },
  'check_suite.completed': { noun: 'CI to finish', clause: 'CI finishes' },
  'workflow_run.completed': { noun: 'a workflow run to finish', clause: 'a workflow run finishes' },
  'task.started': { noun: 'a task to start', clause: 'a task starts' },
  'task.completed': { noun: 'a task to finish', clause: 'a task finishes' },
  [PROJECT_LIFECYCLE_EVENT_TYPES.taskFailed]: { noun: 'a failed task', clause: 'a task fails' },
  'task.cancelled': { noun: 'a cancelled task', clause: 'a task is cancelled' },
  [PROJECT_LIFECYCLE_EVENT_TYPES.sessionFailed]: { noun: 'a failed chat', clause: 'a chat fails' },
  'session.archived': { noun: 'a chat to be archived', clause: 'a chat is archived' },
  [PROJECT_LIFECYCLE_EVENT_TYPES.releaseApplied]: {
    noun: 'a release going live',
    clause: 'a release goes live',
  },
  [PROJECT_LIFECYCLE_EVENT_TYPES.releaseFailed]: {
    noun: 'a failed release',
    clause: 'a release fails',
  },
  'webhook.accepted': { noun: 'a webhook call', clause: 'a webhook call is accepted' },
  'webhook.filtered': {
    noun: 'an ignored webhook call',
    clause: 'a webhook call is ignored by its filters',
  },
};

/** GitHub's CI completion events: one "CI finished" to a person. */
const CI_EVENT_TYPES = new Set([
  'check_run.completed',
  'check_suite.completed',
  'workflow_run.completed',
]);

/** Where an event filter is pinned to one thing: "on commit abc1234", "on PR #12". */
function subjectSuffix(filter: ProjectEventFilterV1): string {
  const type = one(filter.subjectType);
  const id = one(filter.subjectId);
  if (!type || !id) return '';
  switch (type) {
    case 'commit':
      return ` on commit ${shortId(id)}`;
    case 'pull_request':
      return ` on PR #${id}`;
    case 'issue':
      return ` on issue #${id}`;
    case 'task':
      return ` for task ${shortId(id, 8)}`;
    case 'session':
      return ` for chat ${shortId(id, 8)}`;
    case 'webhook_trigger':
      return ` to webhook ${shortId(id, 12)}`;
    default:
      return ` on ${type.replaceAll('_', ' ')} ${shortId(id, 12)}`;
  }
}

/** True when the filter only matches posts on agent channels. */
export function channelNames(filter: ProjectEventFilterV1): string[] | null {
  if (one(filter.source) !== PROJECT_EVENT_CHANNEL_SOURCE) return null;
  return list(filter.subjectId);
}

export function describeEventFilter(filter: ProjectEventFilterV1): EventPhrase {
  const channels = channelNames(filter);
  if (channels) {
    const names = channels.length ? orList(channels.map((name) => `#${name}`)) : 'any channel';
    return { noun: `a post on ${names}`, clause: `someone posts on ${names}` };
  }
  const suffix = subjectSuffix(filter);
  const eventTypes = list(filter.eventType);
  const known = eventTypes.length === 1 ? EVENT_PHRASES[eventTypes[0] ?? ''] : undefined;
  if (known) return { noun: `${known.noun}${suffix}`, clause: `${known.clause}${suffix}` };
  // Agents usually wait for CI with every CI event type at once (check runs, check suites and
  // workflow runs): that is still just "CI to finish".
  if (eventTypes.length > 1 && eventTypes.every((type) => CI_EVENT_TYPES.has(type)))
    return { noun: `CI to finish${suffix}`, clause: `CI finishes${suffix}` };
  // Several types that read the same ("a new comment" twice) say it once.
  const phrases = eventTypes.map((type) => EVENT_PHRASES[type]);
  const first = phrases[0];
  if (eventTypes.length > 1 && first && phrases.every((phrase) => phrase?.noun === first.noun))
    return { noun: `${first.noun}${suffix}`, clause: `${first.clause}${suffix}` };
  const source = one(filter.source);
  const family =
    source === 'github'
      ? 'GitHub activity'
      : source === PROJECT_LIFECYCLE_EVENT_SOURCE
        ? 'SAM activity'
        : 'an event';
  // One event type nobody wrote words for yet: name it rather than say "matching activity".
  const single = eventTypes.length === 1 ? eventTypes[0] : undefined;
  if (single) {
    const words = single.replaceAll('.', ' ').replaceAll('_', ' ');
    const where =
      source === 'github'
        ? 'GitHub '
        : source === PROJECT_LIFECYCLE_EVENT_SOURCE
          ? 'SAM '
          : source
            ? `${source} `
            : '';
    const event = `a ${where}“${words}” event`;
    return { noun: `${event}${suffix}`, clause: `${event} arrives${suffix}` };
  }
  if (suffix) return { noun: `${family}${suffix}`, clause: `there is ${family}${suffix}` };
  return {
    noun: `matching ${family === 'an event' ? 'events' : family}`,
    clause: 'a matching event arrives',
  };
}

/** Every set filter field as `field: a, b`, for the Advanced section. */
export function filterRows(filter: ProjectEventFilterV1): Array<[string, string]> {
  const labels: Record<string, string> = {
    source: 'Source',
    eventType: 'Event type',
    subjectType: 'Subject type',
    subjectId: 'Subject',
    severity: 'Severity',
  };
  return Object.entries(filter)
    .filter(([field]) => field !== 'version')
    .map(([field, value]) => [
      labels[field] ?? field,
      Array.isArray(value) ? value.join(', ') : String(value),
    ]);
}

// ---------------------------------------------------------------------------
// Agent subscriptions ("Behind the scenes")
// ---------------------------------------------------------------------------

/**
 * SAM's own relays that carry agent-to-agent messages: they follow an `agent-dm.` pair channel
 * (`agent-message-subscriptions.ts`). Hidden unless asked for, and never stoppable from here.
 */
export function isSamRelay(subscription: ProjectEventSubscriptionRecord): boolean {
  const { filter } = subscription;
  return (
    list(filter.subjectType).includes('agent_channel') &&
    list(filter.subjectId).some((id) => id.startsWith(AGENT_MESSAGE_CHANNEL_PREFIX))
  );
}

/** Subscriptions owned by a watch or the platform; their owner manages them, not a person. */
export const isManagedSubscription = (subscription: ProjectEventSubscriptionRecord) =>
  subscription.owner.type !== 'human' && subscription.owner.type !== 'agent';

// ---------------------------------------------------------------------------
// Run outcomes
// ---------------------------------------------------------------------------

export type Outcome = 'ok' | 'failed' | 'skipped' | 'ignored' | 'running' | 'unknown';

const SKIP_REASONS: Record<string, string> = {
  still_running: 'the previous run was still going',
  concurrent_limit: 'too many runs were already going',
  rate_limited: 'it ran too often',
  paused: 'it was paused',
};

export function executionOutcome(execution: Pick<TriggerExecution, 'status'>): Outcome {
  switch (execution.status) {
    case 'completed':
    case 'routed':
      return 'ok';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'dropped':
      return 'skipped';
    default:
      return 'running';
  }
}

/** One line for a trigger run: "Finished", "Failed: GitHub token expired", "Skipped: …". */
export function executionText(
  execution: Pick<TriggerExecution, 'status' | 'errorMessage' | 'skipReason'>
): string {
  switch (execution.status) {
    case 'completed':
      return 'Finished';
    case 'failed':
      return execution.errorMessage ? `Failed: ${execution.errorMessage}` : 'Failed';
    case 'skipped':
      return `Skipped because ${SKIP_REASONS[execution.skipReason ?? ''] ?? 'it could not start'}`;
    case 'waiting':
      return 'Queued until a run finishes';
    case 'routing':
      return 'Sending to the existing run';
    case 'routed':
      return 'Sent to the existing run';
    case 'dropped':
      if (execution.skipReason === 'delivery_uncertain')
        return 'Could not confirm delivery to the existing run';
      return execution.skipReason === 'queue_expired'
        ? 'Dropped: waiting time expired'
        : execution.skipReason === 'queue_full'
          ? 'Dropped: queue was full'
          : 'Dropped: the target chat is unavailable';
    case 'queued':
      return 'Waiting to start';
    default:
      return 'Running now';
  }
}

const DELIVERY_TEXT: Record<WebhookDeliveryOutcome, [Outcome, string]> = {
  processing: ['running', 'Being processed'],
  accepted: ['ok', 'Accepted: started a run'],
  duplicate: ['ignored', 'Ignored: already received'],
  filtered: ['ignored', 'Ignored: did not match the filters'],
  inactive: ['ignored', 'Ignored: the automation was paused or off'],
  rate_limited: ['skipped', 'Refused: too many calls'],
  still_running: ['skipped', 'Skipped: the previous run was still going'],
  concurrent_limit: ['skipped', 'Skipped: too many runs were already going'],
  configuration_error: ['failed', 'Failed: the automation is misconfigured'],
  internal_error: ['failed', 'Failed: SAM had an internal error'],
};

export function deliveryText(outcome: WebhookDeliveryOutcome): [Outcome, string] {
  return DELIVERY_TEXT[outcome] ?? ['unknown', outcome.replaceAll('_', ' ')];
}
