import type {
  AgentEffort,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
} from '@simple-agent-manager/shared';
import {
  GITHUB_AUTHOR_ASSOCIATIONS,
  GITHUB_REVIEW_STATES,
  GITHUB_TEMPLATE_KEYS,
  isGitHubCommentEvent,
  isGitHubPullRequestEvent,
} from '@simple-agent-manager/shared';

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export const EFFORT_LABELS: Record<AgentEffort, string> = {
  auto: 'auto',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

export const GITHUB_EVENT_OPTIONS: Array<{
  value: GitHubTriggerEventType;
  label: string;
}> = [
  { value: 'issue_comment', label: 'Issue comment' },
  { value: 'issues', label: 'Issue' },
  { value: 'pull_request', label: 'Pull request' },
  { value: 'pull_request_review', label: 'Pull request review' },
  { value: 'pull_request_review_comment', label: 'Inline review comment' },
  { value: 'push', label: 'Push' },
];

const COMMON_TEMPLATE_VARIABLES = [
  {
    group: 'trigger',
    vars: ['trigger.id', 'trigger.name', 'trigger.description', 'trigger.fireCount'],
  },
  { group: 'project', vars: ['project.id', 'project.name'] },
  { group: 'execution', vars: ['execution.id', 'execution.sequenceNumber'] },
];

export const CRON_TEMPLATE_VARIABLES = [
  {
    group: 'schedule',
    vars: [
      'schedule.time',
      'schedule.date',
      'schedule.dayOfWeek',
      'schedule.hour',
      'schedule.minute',
      'schedule.timezone',
    ],
  },
  ...COMMON_TEMPLATE_VARIABLES,
];

export const GITHUB_TEMPLATE_VARIABLES = [
  {
    group: 'github',
    vars: GITHUB_TEMPLATE_KEYS.map((key) => `github.${key}`),
  },
  ...COMMON_TEMPLATE_VARIABLES,
];

export const WEBHOOK_TEMPLATE_VARIABLES = [
  {
    group: 'webhook',
    vars: [
      'webhook.receivedAt',
      'webhook.deliveryId',
      'webhook.sourceLabel',
      'webhook.payload',
      'webhook.body',
      'webhook.headers',
    ],
  },
  ...COMMON_TEMPLATE_VARIABLES,
];

export const EMAIL_TEMPLATE_VARIABLES = [
  {
    group: 'email',
    vars: [
      'email.from',
      'email.fromName',
      'email.to',
      'email.subject',
      'email.text',
      'email.receivedAt',
      'email.messageId',
      'email.attachments',
    ],
  },
  ...COMMON_TEMPLATE_VARIABLES,
];

export const INCIDENT_TEMPLATE_VARIABLES = [
  {
    group: 'incident',
    vars: [
      'incident.pendingCount',
      'incident.totalOccurrenceCount',
      'incident.backlogSummary',
      'incident.incidents',
      'incident.tools',
    ],
  },
  ...COMMON_TEMPLATE_VARIABLES,
];

export function splitList(value: string): string[] | undefined {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function joinList(value?: string[]): string {
  return value?.join(', ') ?? '';
}

/**
 * Allowed senders are long (full email addresses), so the field reads one per line rather than
 * comma-separated like {@link splitList}. Commas are accepted too, for a pasted inline list.
 */
export function splitEmailList(value: string): string[] | undefined {
  const items = value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function joinEmailList(value?: string[]): string {
  return value?.join('\n') ?? '';
}

/** A light client-side shape check; the server normalizes and validates the real address. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function buildGitHubFilters(input: {
  eventType: GitHubTriggerEventType;
  actions: string;
  labels: string;
  ignoreActors: string;
  commandPrefix: string;
  bodyContains: string;
  branches: string;
  ignoreDrafts: boolean;
  actors?: string;
  addedLabel?: string;
  authorAssociation?: string;
  ignoreBots?: boolean;
  commentContains?: string;
  isPullRequest?: string;
  reviewStates?: string;
}): GitHubTriggerFilters {
  const filters: GitHubTriggerFilters = {};
  const actions = splitList(input.actions);
  const labels = splitList(input.labels);
  const ignoreActors = splitList(input.ignoreActors);
  const branches = splitList(input.branches);
  if (input.eventType !== 'push' && actions) filters.actions = actions;
  if (input.eventType !== 'push' && labels) filters.labels = labels;
  if (ignoreActors) filters.ignoreActors = ignoreActors;
  if (isGitHubCommentEvent(input.eventType) && input.commandPrefix.trim()) {
    filters.commandPrefix = input.commandPrefix.trim();
  }
  if (input.eventType !== 'push' && input.bodyContains.trim())
    filters.bodyContains = input.bodyContains.trim();
  if ((input.eventType === 'push' || isGitHubPullRequestEvent(input.eventType)) && branches)
    filters.branches = branches;
  if (input.eventType === 'pull_request') filters.ignoreDrafts = input.ignoreDrafts;
  if (input.actors?.trim()) filters.actors = splitList(input.actors);
  if (input.ignoreBots) filters.ignoreBots = true;
  if (input.eventType !== 'push') {
    if (input.authorAssociation?.trim())
      filters.authorAssociation = splitList(input.authorAssociation.toUpperCase());
    if (
      input.eventType === 'issue_comment' &&
      (input.isPullRequest === 'true' || input.isPullRequest === 'false')
    )
      filters.isPullRequest = input.isPullRequest === 'true';
  }
  if (['issues', 'pull_request'].includes(input.eventType) && input.addedLabel?.trim())
    filters.addedLabel = input.addedLabel.trim();
  if (isGitHubCommentEvent(input.eventType) && input.commentContains?.trim())
    filters.commentContains = input.commentContains.trim();
  if (input.eventType === 'pull_request_review' && input.reviewStates?.trim())
    filters.reviewStates = splitList(input.reviewStates.toLowerCase());
  return filters;
}

/** Build a patch without round-tripping untouched stored filter values through CSV. */
export function buildGitHubConfigForForm(
  input: Parameters<typeof buildGitHubFilters>[0],
  original?: { eventType: GitHubTriggerEventType; filters: GitHubTriggerFilters }
) {
  if (!original) return { eventType: input.eventType, filters: buildGitHubFilters(input) };
  const initial = {
    eventType: original.eventType,
    actions: joinList(original.filters.actions),
    labels: joinList(original.filters.labels),
    ignoreActors: joinList(original.filters.ignoreActors),
    commandPrefix: original.filters.commandPrefix ?? '',
    bodyContains: original.filters.bodyContains ?? '',
    branches: joinList(original.filters.branches),
    ignoreDrafts: original.filters.ignoreDrafts ?? true,
    actors: joinList(original.filters.actors),
    addedLabel: original.filters.addedLabel ?? '',
    authorAssociation: joinList(original.filters.authorAssociation),
    ignoreBots: original.filters.ignoreBots ?? false,
    commentContains: original.filters.commentContains ?? '',
    isPullRequest:
      original.filters.isPullRequest === undefined ? '' : String(original.filters.isPullRequest),
    reviewStates: joinList(original.filters.reviewStates),
  };
  if (
    (Object.keys(initial) as Array<keyof typeof initial>).every(
      (key) => (input[key] ?? (typeof initial[key] === 'boolean' ? false : '')) === initial[key]
    )
  )
    return undefined;
  const filters: GitHubTriggerFilters = { ...original.filters };
  const eventChanged = input.eventType !== original.eventType;
  const updateList = (
    key: 'actions' | 'labels' | 'ignoreActors' | 'branches',
    applies: boolean
  ) => {
    if (eventChanged && !applies) {
      delete filters[key];
      return;
    }
    if ((input[key] ?? (typeof initial[key] === 'boolean' ? false : '')) === initial[key]) return;
    const value = applies ? splitList(input[key]) : undefined;
    if (value) filters[key] = value;
    else delete filters[key];
  };
  const updateText = (key: 'commandPrefix' | 'bodyContains', applies: boolean) => {
    if (eventChanged && !applies) {
      delete filters[key];
      return;
    }
    if ((input[key] ?? (typeof initial[key] === 'boolean' ? false : '')) === initial[key]) return;
    const value = applies ? input[key].trim() : '';
    if (value) filters[key] = value;
    else delete filters[key];
  };
  updateList('actions', input.eventType !== 'push');
  updateList('labels', input.eventType !== 'push');
  updateList('ignoreActors', true);
  updateList('branches', isGitHubPullRequestEvent(input.eventType) || input.eventType === 'push');
  updateText('commandPrefix', isGitHubCommentEvent(input.eventType));
  updateText('bodyContains', input.eventType !== 'push');
  if (eventChanged && input.eventType !== 'pull_request') delete filters.ignoreDrafts;
  else if (input.ignoreDrafts !== initial.ignoreDrafts) filters.ignoreDrafts = input.ignoreDrafts;
  const built = buildGitHubFilters(input);
  for (const key of [
    'actors',
    'addedLabel',
    'authorAssociation',
    'ignoreBots',
    'commentContains',
    'isPullRequest',
    'reviewStates',
  ] as const) {
    const unchanged = (input[key] ?? (key === 'ignoreBots' ? false : '')) === initial[key];
    if (unchanged && !eventChanged) continue;
    delete filters[key];
    if (built[key] !== undefined) Object.assign(filters, { [key]: built[key] });
  }
  return { eventType: input.eventType, filters };
}

/** The editor and read-only preview show the same fixed-choice validation. */
export function githubFilterChoiceError(filters: GitHubTriggerFilters): string {
  if (
    filters.authorAssociation?.some(
      (value) => !(GITHUB_AUTHOR_ASSOCIATIONS as readonly string[]).includes(value)
    )
  )
    return 'Choose an author association from the listed GitHub values.';
  if (
    filters.reviewStates?.some(
      (value) => !(GITHUB_REVIEW_STATES as readonly string[]).includes(value)
    )
  )
    return 'Choose a review state from the listed GitHub values.';
  return '';
}
