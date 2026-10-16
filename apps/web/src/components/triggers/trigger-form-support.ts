import type {
  AgentEffort,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
} from '@simple-agent-manager/shared';

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export const VM_SIZES = [
  { value: '', label: 'Project default' },
  { value: 'small', label: 'Small (2 vCPU, 4 GB)' },
  { value: 'medium', label: 'Medium (4 vCPU, 8 GB)' },
  { value: 'large', label: 'Large (8 vCPU, 16 GB)' },
];

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
    vars: [
      'github.event',
      'github.action',
      'github.actor',
      'github.repository',
      'github.number',
      'github.title',
      'github.body',
      'github.comment',
      'github.labels',
      'github.branch',
      'github.sha',
    ],
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

export function buildGitHubFilters(input: {
  eventType: GitHubTriggerEventType;
  actions: string;
  labels: string;
  ignoreActors: string;
  commandPrefix: string;
  bodyContains: string;
  branches: string;
  ignoreDrafts: boolean;
}): GitHubTriggerFilters {
  const filters: GitHubTriggerFilters = {};
  const actions = splitList(input.actions);
  const labels = splitList(input.labels);
  const ignoreActors = splitList(input.ignoreActors);
  const branches = splitList(input.branches);
  if (input.eventType !== 'push' && actions) filters.actions = actions;
  if (input.eventType !== 'push' && labels) filters.labels = labels;
  if (ignoreActors) filters.ignoreActors = ignoreActors;
  if (input.eventType === 'issue_comment' && input.commandPrefix.trim()) {
    filters.commandPrefix = input.commandPrefix.trim();
  }
  if (input.eventType !== 'push' && input.bodyContains.trim())
    filters.bodyContains = input.bodyContains.trim();
  if ((input.eventType === 'push' || input.eventType === 'pull_request') && branches)
    filters.branches = branches;
  if (input.eventType === 'pull_request') filters.ignoreDrafts = input.ignoreDrafts;
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
  };
  if (
    (Object.keys(initial) as Array<keyof typeof initial>).every(
      (key) => input[key] === initial[key]
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
    if (input[key] === initial[key]) return;
    const value = applies ? splitList(input[key]) : undefined;
    if (value) filters[key] = value;
    else delete filters[key];
  };
  const updateText = (key: 'commandPrefix' | 'bodyContains', applies: boolean) => {
    if (eventChanged && !applies) {
      delete filters[key];
      return;
    }
    if (input[key] === initial[key]) return;
    const value = applies ? input[key].trim() : '';
    if (value) filters[key] = value;
    else delete filters[key];
  };
  updateList('actions', input.eventType !== 'push');
  updateList('labels', input.eventType !== 'push');
  updateList('ignoreActors', true);
  updateList('branches', input.eventType === 'pull_request' || input.eventType === 'push');
  updateText('commandPrefix', input.eventType === 'issue_comment');
  updateText('bodyContains', input.eventType !== 'push');
  if (eventChanged && input.eventType !== 'pull_request') delete filters.ignoreDrafts;
  else if (input.ignoreDrafts !== initial.ignoreDrafts) filters.ignoreDrafts = input.ignoreDrafts;
  return { eventType: input.eventType, filters };
}
