/**
 * The exact configuration of each kind of automation, for the "Advanced" section of its page:
 * what power users and support need, out of the way of everyone else.
 */
import type {
  ProjectSchedule,
  ProjectStandingWatch,
  TriggerResponse,
} from '@simple-agent-manager/shared';
import type { ReactNode } from 'react';

import {
  deserializeResourceRequirements,
  formatLegacyVmSize,
} from '../../components/resource-requirements';
import type { AutomationLookups } from './data';
import { filterRows } from './describe';
import { fullDate } from './time';

type Rows = Array<[string, ReactNode]>;

const mono = (value: string) => <span className="font-mono text-[12.5px]">{value}</span>;
const listOr = (values: string[] | undefined, empty: string) =>
  values?.length ? values.join(', ') : empty;

/** "At least 4 vCPU · 8 GB · its own machine", the legacy size, or the profile default. */
export function describeMachine(trigger: TriggerResponse): string {
  const state = deserializeResourceRequirements(trigger.resourceRequirementsJson ?? null);
  const parts = [
    state.minVcpu ? `${state.minVcpu} vCPU` : null,
    state.minMemoryGb ? `${state.minMemoryGb} GB` : null,
  ].filter(Boolean);
  const exclusive = state.exclusiveNode ? 'its own machine' : null;
  if (parts.length || exclusive)
    return [parts.length ? `At least ${parts.join(' · ')}` : null, exclusive]
      .filter(Boolean)
      .join(' · ');
  return formatLegacyVmSize(trigger.vmSizeOverride) ?? 'The agent profile’s default';
}

function sourceRows(trigger: TriggerResponse): Rows {
  switch (trigger.sourceType) {
    case 'github': {
      const config = trigger.githubConfig;
      if (!config) return [['GitHub event', 'Not configured']];
      const { eventType, filters } = config;
      const rows: Rows = [['GitHub event', mono(eventType)]];
      if (eventType !== 'push') rows.push(['Actions', listOr(filters.actions, 'Any')]);
      if (eventType !== 'push') rows.push(['Required labels', listOr(filters.labels, 'None')]);
      if (eventType === 'issue_comment')
        rows.push([
          'Comment starts with',
          filters.commandPrefix ? mono(filters.commandPrefix) : 'Anything',
        ]);
      if (eventType !== 'push') rows.push(['Text contains', filters.bodyContains || 'Anything']);
      if (eventType === 'push' || eventType === 'pull_request')
        rows.push(['Branches', listOr(filters.branches, 'Any')]);
      if (eventType === 'pull_request')
        rows.push(['Draft pull requests', filters.ignoreDrafts === false ? 'Included' : 'Ignored']);
      rows.push(['Ignored accounts', listOr(filters.ignoreActors, 'None')]);
      return rows;
    }
    case 'webhook': {
      const config = trigger.webhookConfig;
      if (!config) return [['Webhook', 'Not configured']];
      const filters = config.filters.map(
        (filter) =>
          `${filter.path} ${filter.operator}${filter.operator === 'exists' ? '' : ` ${JSON.stringify(filter.value ?? null)}`}`
      );
      return [
        ['Source label', config.sourceLabel || 'None'],
        [
          'Filters',
          filters.length
            ? `${config.filterMode === 'any' ? 'Any of' : 'All of'}: ${filters.join('; ')}`
            : 'None: every call starts a run',
        ],
        ['Headers passed to the prompt', listOr(config.includedHeaders, 'None')],
        ['Token', mono(`••••${config.tokenLastFour}`)],
        ['Token created', fullDate(Date.parse(config.tokenRotatedAt ?? config.tokenCreatedAt))],
      ];
    }
    case 'email': {
      const config = trigger.emailConfig;
      return [
        ['Address', config ? mono(config.address) : 'Not available'],
        ['Allowed senders', listOr(config?.allowedSenders, 'None')],
      ];
    }
    case 'incident':
      return [
        ['Backlog', 'Private platform feedback incidents'],
        ['Runs from', 'The scheduled incident sweep only'],
      ];
    default:
      return [
        ['Schedule (cron)', trigger.cronExpression ? mono(trigger.cronExpression) : 'None'],
        ['Time zone', trigger.cronTimezone],
        ['Skip if the last run is still going', trigger.skipIfRunning ? 'Yes' : 'No'],
      ];
  }
}

export function triggerAdvancedRows(
  trigger: TriggerResponse,
  lookups: AutomationLookups,
  personName: (userId: string) => string
): Rows {
  return [
    ...sourceRows(trigger),
    ['Agent profile', lookups.profileName(trigger.agentProfileId)],
    ['Skill', lookups.skillName(trigger.skillId) ?? 'None'],
    [
      'Chat type',
      trigger.taskMode === 'conversation'
        ? 'Conversation: stays open for replies'
        : 'Task: works, then finishes',
    ],
    ['Most runs at once', String(trigger.maxConcurrent)],
    ['Machine', describeMachine(trigger)],
    ['Runs so far', String(trigger.triggerCount)],
    ...(trigger.description ? ([['Description', trigger.description]] as Rows) : []),
    ['Created', `${fullDate(Date.parse(trigger.createdAt))} by ${personName(trigger.userId)}`],
    ['ID', mono(trigger.id)],
  ];
}

export function scheduleAdvancedRows(
  schedule: ProjectSchedule,
  personName: (userId: string) => string
): Rows {
  const execution = schedule.execution;
  const rows: Rows = [
    ['Due', fullDate(schedule.dueAt, schedule.displayTimezone)],
    ['Gives up after', fullDate(schedule.expiresAt, schedule.displayTimezone)],
    ['Time zone', schedule.displayTimezone],
    ['State', mono(schedule.state)],
    ['Attempts', String(schedule.attemptCount)],
  ];
  if (schedule.nextAttemptAt) rows.push(['Next attempt', fullDate(schedule.nextAttemptAt)]);
  // A cancellation stores its reason where errors go (`project-event-schedules-storage.ts`).
  if (schedule.lastError)
    rows.push([
      schedule.state === 'cancelled' ? 'Why it was cancelled' : 'Last error',
      schedule.lastError,
    ]);
  if (execution) {
    rows.push(['Result checked', fullDate(execution.checkedAt)]);
    if (execution.receiptState) rows.push(['Receipt', mono(execution.receiptState)]);
    if (execution.submissionDeadline)
      rows.push(['Retry possible until', fullDate(execution.submissionDeadline)]);
  }
  if (schedule.watchId) rows.push(['Started by watch', mono(schedule.watchId)]);
  if (schedule.sourceEventId) rows.push(['Event', mono(schedule.sourceEventId)]);
  rows.push(
    ['Created', `${fullDate(schedule.createdAt)} by ${personName(schedule.creatorUserId)}`],
    ['ID', mono(schedule.id)]
  );
  return rows;
}

export function watchAdvancedRows(
  watch: ProjectStandingWatch,
  personName: (userId: string) => string
): Rows {
  const rows: Rows = filterRows(watch.filter).map(([label, value]) => [label, mono(value)]);
  rows.push(
    ['Runs used', `${watch.executionCount} of ${watch.maxExecutions}`],
    ['Most runs at once', String(watch.maxConcurrent)],
    ['Wait between runs', `${Math.round(watch.cooldownMs / 60_000)} min`]
  );
  if (watch.nextEligibleAt > Date.now())
    rows.push(['Next run possible', fullDate(watch.nextEligibleAt)]);
  if (watch.lastError) rows.push(['Last error', watch.lastError]);
  rows.push(
    ['Created', `${fullDate(watch.createdAt)} by ${personName(watch.creatorUserId)}`],
    ['ID', mono(watch.id)]
  );
  return rows;
}
