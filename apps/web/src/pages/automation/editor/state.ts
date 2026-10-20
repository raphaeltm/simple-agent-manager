/**
 * The create/edit flow's form state, and how it is filled: from defaults, from a template, or
 * from a stored trigger or watch. Pure; `requests.ts` turns it into API calls.
 */
import {
  DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
  GITHUB_TRIGGER_DEFAULT_ACTIONS,
  type GitHubTriggerEventType,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
  type ProjectEventFilterV1,
  type ProjectStandingWatch,
  type TriggerResponse,
  type WebhookTriggerFilter,
} from '@simple-agent-manager/shared';

import {
  deserializeResourceRequirements,
  EMPTY_RESOURCE_STATE,
  type ResourceRequirementsFormState,
} from '../../../components/resource-requirements';
import { parseCronToMode } from '../../../components/triggers/schedule-cron';
import { joinList } from '../../../components/triggers/trigger-form-support';
import type { AutomationStart } from '../../../lib/automation-routes';
import { LIFECYCLE_SOURCE } from '../describe';
import { type OnceTime, onceTimeFrom } from '../schedule-time';
import { viewerZone } from '../time';
import { canonicalCron, type ScheduleChoice, type SchedulePreset, toCron } from './cron';

export interface GitHubState {
  eventType: GitHubTriggerEventType;
  actions: string;
  labels: string;
  ignoreActors: string;
  commandPrefix: string;
  bodyContains: string;
  branches: string;
  ignoreDrafts: boolean;
}

export interface WebhookState {
  sourceLabel: string;
  includedHeaders: string;
  filterMode: 'all' | 'any';
  filters: WebhookTriggerFilter[];
}

/** Real, expressible event filters; anything else is "custom". */
export const WATCH_PRESETS = {
  'issue-opened': { label: 'An issue is opened', source: 'github', eventType: 'issues.opened' },
  'pr-opened': {
    label: 'A pull request is opened',
    source: 'github',
    eventType: 'pull_request.opened',
  },
  'pr-review': {
    label: 'A pull request review is submitted',
    source: 'github',
    eventType: 'pull_request_review.submitted',
  },
  'task-failed': { label: 'A task fails', source: LIFECYCLE_SOURCE, eventType: 'task.failed' },
  'chat-failed': { label: 'A chat fails', source: LIFECYCLE_SOURCE, eventType: 'session.failed' },
  'release-failed': {
    label: 'A release fails',
    source: LIFECYCLE_SOURCE,
    eventType: 'deployment.release.failed',
  },
  'release-applied': {
    label: 'A release goes live',
    source: LIFECYCLE_SOURCE,
    eventType: 'deployment.release.applied',
  },
} as const;

export type WatchPreset = keyof typeof WATCH_PRESETS | 'channel-post' | 'custom';

export interface WatchState {
  preset: WatchPreset;
  /** Channel name for "channel-post". */
  channel: string;
  /** Free text for "custom": comma-separated values, OR within a field, AND across fields. */
  source: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  /** '' for any severity, otherwise comma-separated severities (OR). */
  severity: string;
  cooldownMinutes: number;
  maxConcurrent: number;
  maxExecutions: number;
}

export interface ActionState {
  kind: 'start' | 'message';
  prompt: string;
  agentProfileId: string;
  skillId: string;
  sessionId: string;
}

export interface TriggerOptions {
  skipIfRunning: boolean;
  maxConcurrent: number;
  taskMode: 'task' | 'conversation';
  resources: ResourceRequirementsFormState;
  /** A legacy `vmSizeOverride` still stored on the trigger; cleared explicitly. */
  legacyVmSize: string;
}

/** What starts it. `incident` exists only for editing admin incident triggers. */
export type EditorStart = AutomationStart | 'incident';

export interface EditorState {
  start: EditorStart | null;
  name: string;
  /** False while the name is still the suggested one, so it can follow what the user picks. */
  nameEdited: boolean;
  description: string;
  schedule: ScheduleChoice;
  /** Edits only send the schedule when it was touched (a stored `1-5` stays as typed). */
  scheduleTouched: boolean;
  once: OnceTime;
  github: GitHubState;
  webhook: WebhookState;
  watch: WatchState;
  action: ActionState;
  trigger: TriggerOptions;
}

const DEFAULT_GITHUB: GitHubState = {
  eventType: 'issue_comment',
  actions: GITHUB_TRIGGER_DEFAULT_ACTIONS.issue_comment,
  labels: '',
  ignoreActors: 'dependabot[bot]',
  commandPrefix: '/sam',
  bodyContains: '',
  branches: '',
  ignoreDrafts: true,
};

/** A fresh one-time due time: the next quarter hour at least an hour from now. */
function defaultOnceDue(now: number) {
  const quarter = 15 * 60_000;
  return Math.ceil((now + 60 * 60_000) / quarter) * quarter;
}

export function newEditorState(
  options: { start?: AutomationStart | null; sessionId?: string | null } = {},
  now = Date.now()
): EditorState {
  const zone = viewerZone();
  return {
    start: options.start ?? (options.sessionId ? 'once' : null),
    name: '',
    nameEdited: false,
    description: '',
    schedule: {
      preset: 'weekdays',
      time: '09:00',
      weeklyDays: [1],
      monthDay: 1,
      everyHours: 4,
      minute: 0,
      custom: '0 9 * * 1-5',
      zone,
    },
    scheduleTouched: false,
    once: onceTimeFrom(defaultOnceDue(now), zone),
    github: { ...DEFAULT_GITHUB },
    webhook: { sourceLabel: '', includedHeaders: '', filterMode: 'all', filters: [] },
    watch: {
      preset: 'issue-opened',
      channel: '',
      source: '',
      eventType: '',
      subjectType: '',
      subjectId: '',
      severity: '',
      cooldownMinutes: DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS / 60_000,
      maxConcurrent: 1,
      maxExecutions: DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
    },
    action: {
      kind: options.sessionId ? 'message' : 'start',
      prompt: '',
      agentProfileId: '',
      skillId: '',
      sessionId: options.sessionId ?? '',
    },
    trigger: {
      skipIfRunning: true,
      maxConcurrent: 1,
      taskMode: 'task',
      resources: { ...EMPTY_RESOURCE_STATE },
      legacyVmSize: '',
    },
  };
}

/** Reads a stored cron back into the presets; anything they cannot express opens as custom. */
export function scheduleFromCron(cron: string, zone: string): ScheduleChoice {
  const parsed = parseCronToMode(cron);
  const time = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
  const preset: SchedulePreset =
    parsed.mode === 'hourly'
      ? 'hourly'
      : parsed.mode === 'monthly'
        ? 'monthly'
        : parsed.mode === 'weekly'
          ? 'weekly'
          : parsed.mode === 'daily'
            ? parsed.dailyVariant === 'weekday'
              ? 'weekdays'
              : parsed.dailyVariant === 'weekend'
                ? 'weekends'
                : 'daily'
            : 'custom';
  const choice: ScheduleChoice = {
    preset,
    time,
    weeklyDays: parsed.weeklyDays,
    monthDay: parsed.monthDay,
    everyHours: parsed.everyNHours,
    minute: parsed.minute,
    custom: cron,
    zone,
  };
  // `parseCronToMode` reads only some fields (it ignores the month and minute lists), so a preset
  // is trusted only when it rebuilds the exact same schedule. Anything else opens as typed.
  if (preset !== 'custom' && canonicalCron(toCron(choice)) !== canonicalCron(cron))
    return { ...choice, preset: 'custom' };
  return choice;
}

export function editorStateFromTrigger(trigger: TriggerResponse): EditorState {
  const base = newEditorState();
  const start: EditorStart = trigger.sourceType === 'cron' ? 'schedule' : trigger.sourceType;
  const github = trigger.githubConfig;
  return {
    ...base,
    start,
    name: trigger.name,
    nameEdited: true,
    description: trigger.description ?? '',
    schedule: trigger.cronExpression
      ? scheduleFromCron(trigger.cronExpression, trigger.cronTimezone)
      : { ...base.schedule, zone: trigger.cronTimezone },
    github: github
      ? {
          eventType: github.eventType,
          actions: joinList(github.filters.actions),
          labels: joinList(github.filters.labels),
          ignoreActors: joinList(github.filters.ignoreActors),
          commandPrefix: github.filters.commandPrefix ?? '',
          bodyContains: github.filters.bodyContains ?? '',
          branches: joinList(github.filters.branches),
          ignoreDrafts: github.filters.ignoreDrafts ?? true,
        }
      : base.github,
    webhook: trigger.webhookConfig
      ? {
          sourceLabel: trigger.webhookConfig.sourceLabel ?? '',
          includedHeaders: joinList(trigger.webhookConfig.includedHeaders),
          filterMode: trigger.webhookConfig.filterMode,
          filters: trigger.webhookConfig.filters,
        }
      : base.webhook,
    action: {
      kind: 'start',
      prompt: trigger.promptTemplate,
      agentProfileId: trigger.agentProfileId ?? '',
      skillId: trigger.skillId ?? '',
      sessionId: '',
    },
    trigger: {
      skipIfRunning: trigger.skipIfRunning,
      maxConcurrent: trigger.maxConcurrent,
      taskMode: trigger.taskMode === 'conversation' ? 'conversation' : 'task',
      resources: deserializeResourceRequirements(trigger.resourceRequirementsJson ?? null),
      legacyVmSize: trigger.vmSizeOverride ?? '',
    },
  };
}

const text = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join(', ') : (value ?? '');

/** Which preset a stored filter is, so editing shows it the way it was made. */
export function watchPresetOf(filter: ProjectEventFilterV1): {
  preset: WatchPreset;
  channel: string;
} {
  const fields = Object.keys(filter).filter((key) => key !== 'version');
  const single = (value: unknown) => (typeof value === 'string' ? value : undefined);
  if (
    single(filter.source) === PROJECT_EVENT_CHANNEL_SOURCE &&
    single(filter.eventType) === PROJECT_EVENT_CHANNEL_TYPE &&
    single(filter.subjectType) === 'agent_channel' &&
    single(filter.subjectId) &&
    fields.length === 4
  )
    return { preset: 'channel-post', channel: single(filter.subjectId) ?? '' };
  if (fields.length === 2) {
    for (const [id, preset] of Object.entries(WATCH_PRESETS)) {
      if (single(filter.source) === preset.source && single(filter.eventType) === preset.eventType)
        return { preset: id as WatchPreset, channel: '' };
    }
  }
  return { preset: 'custom', channel: '' };
}

export function editorStateFromWatch(watch: ProjectStandingWatch): EditorState {
  const base = newEditorState();
  const { preset, channel } = watchPresetOf(watch.filter);
  const action = watch.action;
  return {
    ...base,
    start: 'event',
    name: watch.reason ?? '',
    nameEdited: true,
    watch: {
      preset,
      channel,
      source: text(watch.filter.source),
      eventType: text(watch.filter.eventType),
      subjectType: text(watch.filter.subjectType),
      subjectId: text(watch.filter.subjectId),
      severity: text(watch.filter.severity),
      cooldownMinutes: Math.round(watch.cooldownMs / 60_000),
      maxConcurrent: watch.maxConcurrent,
      maxExecutions: watch.maxExecutions,
    },
    action:
      action.kind === 'message_session'
        ? {
            kind: 'message',
            prompt: action.prompt,
            agentProfileId: '',
            skillId: '',
            sessionId: action.sessionId,
          }
        : {
            kind: 'start',
            prompt: action.prompt,
            agentProfileId: action.agentProfileId ?? '',
            skillId: action.skillId ?? '',
            sessionId: '',
          },
  };
}

/** Starts that may message an existing chat; triggers can only start new chats. */
export const canMessageChat = (start: EditorStart | null) => start === 'once' || start === 'event';

/** Starts stored as triggers (recurring, GitHub, webhook, incident). */
export const isTriggerStart = (start: EditorStart | null) =>
  start === 'schedule' || start === 'github' || start === 'webhook' || start === 'incident';
