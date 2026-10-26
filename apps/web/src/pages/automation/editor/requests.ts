/**
 * Editor state → API requests, and the checks each step runs before moving on. Pure, so every
 * field the form collects is provably sent (`.claude/rules/06`, UI-to-backend data path).
 */
import {
  areGitHubTriggerActionsValid,
  type CreateProjectScheduleRequest,
  type CreateProjectStandingWatchRequest,
  type CreateTriggerRequest,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING,
  DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS,
  DEFAULT_PROJECT_EVENT_SCHEDULE_PROMPT_MAX_BYTES,
  DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
  type EmailTriggerConfigInput,
  GITHUB_AUTHOR_ASSOCIATIONS,
  GITHUB_REVIEW_STATES,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
  PROJECT_EVENT_SEVERITIES,
  type ProjectEventFilterV1,
  type ProjectEventSeverity,
  type ProjectScheduledAction,
  type ProjectStandingWatch,
  type TriggerResponse,
  type UpdateProjectStandingWatchRequest,
  type UpdateTriggerRequest,
  type WebhookTriggerConfigInput,
} from '@simple-agent-manager/shared';

import {
  hasValidationErrors,
  serializeResourceRequirements,
  validateResourceState,
} from '../../../components/resource-requirements';
import {
  buildGitHubConfigForForm,
  buildGitHubFilters,
  looksLikeEmail,
  splitEmailList,
  splitList,
} from '../../../components/triggers/trigger-form-support';
import { isVersionConflict } from '../errors';
import { resolveOnceTime } from '../schedule-time';
import { cronError, toCron } from './cron';
import { type EditorState, WATCH_PRESETS } from './state';

export type StepId = 'start' | 'when' | 'what' | 'review';
export type Errors = Partial<Record<string, string>>;

const SOURCE_TYPES = {
  schedule: 'cron',
  github: 'github',
  webhook: 'webhook',
  email: 'email',
} as const;

const trimmed = (value: string) => value.trim();
const optional = (value: string) => value.trim() || undefined;

function webhookConfig(state: EditorState): WebhookTriggerConfigInput {
  return {
    sourceLabel: optional(state.webhook.sourceLabel),
    includedHeaders: splitList(state.webhook.includedHeaders),
    filterMode: state.webhook.filterMode,
    filters: state.webhook.filters,
  };
}

function emailConfig(state: EditorState): EmailTriggerConfigInput {
  const allowedSenders = splitEmailList(state.email.allowedSenders);
  return allowedSenders ? { allowedSenders } : {};
}

function githubQueueConfig(state: EditorState) {
  return {
    subjectAffinity: state.github.subjectAffinity,
    queueMaxPending: Number(state.github.queueMaxPending),
    queueTtlSeconds: Math.round(Number(state.github.queueTtlHours) * 3600),
  };
}

function githubInput(state: EditorState) {
  return {
    eventType: state.github.eventType,
    actions: state.github.actions,
    labels: state.github.labels,
    ignoreActors: state.github.ignoreActors,
    commandPrefix: state.github.commandPrefix,
    bodyContains: state.github.bodyContains,
    branches: state.github.branches,
    ignoreDrafts: state.github.ignoreDrafts,
    actors: state.github.actors,
    addedLabel: state.github.addedLabel,
    authorAssociation: state.github.authorAssociation,
    ignoreBots: state.github.ignoreBots,
    commentContains: state.github.commentContains,
    isPullRequest: state.github.isPullRequest,
    reviewStates: state.github.reviewStates,
  };
}

export function triggerCreateRequest(state: EditorState): CreateTriggerRequest {
  if (
    state.start !== 'schedule' &&
    state.start !== 'github' &&
    state.start !== 'webhook' &&
    state.start !== 'email'
  )
    throw new Error('Only schedules, GitHub events, webhooks and email are created as triggers');
  const sourceType = SOURCE_TYPES[state.start];
  return {
    name: trimmed(state.name),
    description: optional(state.description),
    sourceType,
    ...(sourceType === 'cron'
      ? { cronExpression: toCron(state.schedule), cronTimezone: state.schedule.zone }
      : {}),
    ...(sourceType === 'github'
      ? {
          githubConfig: {
            eventType: state.github.eventType,
            filters: buildGitHubFilters(githubInput(state)),
            ...githubQueueConfig(state),
          },
        }
      : {}),
    ...(sourceType === 'webhook' ? { webhookConfig: webhookConfig(state) } : {}),
    ...(sourceType === 'email' ? { emailConfig: emailConfig(state) } : {}),
    promptTemplate: state.action.prompt,
    agentProfileId: optional(state.action.agentProfileId),
    skillId: optional(state.action.skillId),
    skipIfRunning: state.trigger.skipIfRunning,
    maxConcurrent: state.trigger.maxConcurrent,
    taskMode: state.trigger.taskMode,
    resourceRequirementsJson: serializeResourceRequirements(state.trigger.resources),
  };
}

/**
 * A trigger edit. Fields agents may set through MCP and this form shows unchanged (skill,
 * description, the schedule text) are sent only when the user changed them, so saving an
 * unrelated edit never wipes them.
 */
export function triggerUpdateRequest(
  state: EditorState,
  original: TriggerResponse
): UpdateTriggerRequest {
  const request: UpdateTriggerRequest = {
    name: trimmed(state.name),
    promptTemplate: state.action.prompt,
    agentProfileId: state.action.agentProfileId || null,
    skipIfRunning: state.trigger.skipIfRunning,
    maxConcurrent: state.trigger.maxConcurrent,
    taskMode: state.trigger.taskMode,
    resourceRequirementsJson: serializeResourceRequirements(state.trigger.resources),
  };
  const description = state.description.trim() || null;
  if (description !== (original.description ?? null)) request.description = description;
  const skillId = state.action.skillId || null;
  if (skillId !== (original.skillId ?? null)) request.skillId = skillId;
  if (!state.trigger.legacyVmSize && original.vmSizeOverride) request.vmSizeOverride = null;
  if (original.sourceType === 'cron') {
    if (state.scheduleTouched) request.cronExpression = toCron(state.schedule);
    if (state.schedule.zone !== original.cronTimezone) request.cronTimezone = state.schedule.zone;
  }
  if (original.sourceType === 'github') {
    const githubConfig = buildGitHubConfigForForm(githubInput(state), original.githubConfig);
    const queue = githubQueueConfig(state);
    const queueChanged =
      queue.subjectAffinity !== (original.githubConfig?.subjectAffinity ?? false) ||
      queue.queueMaxPending !==
        (original.githubConfig?.queueMaxPending ?? DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING) ||
      queue.queueTtlSeconds !==
        (original.githubConfig?.queueTtlSeconds ?? DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS);
    if (githubConfig || queueChanged)
      request.githubConfig = {
        ...(githubConfig ??
          original.githubConfig ?? { eventType: state.github.eventType, filters: {} }),
        ...queue,
      };
  }
  if (original.sourceType === 'webhook') request.webhookConfig = webhookConfig(state);
  if (original.sourceType === 'email') request.emailConfig = emailConfig(state);
  return request;
}

export function scheduledAction(state: EditorState): ProjectScheduledAction {
  return state.action.kind === 'message'
    ? { kind: 'message_session', sessionId: state.action.sessionId, prompt: state.action.prompt }
    : {
        kind: 'start_session',
        prompt: state.action.prompt,
        agentProfileId: state.action.agentProfileId || null,
        skillId: state.action.skillId || null,
      };
}

export function scheduleCreateRequest(
  state: EditorState,
  idempotencyKey: string,
  now = Date.now()
): CreateProjectScheduleRequest {
  const time = resolveOnceTime(state.once, now);
  if ('error' in time) throw new Error(time.error);
  return {
    action: scheduledAction(state),
    dueAt: time.dueAt,
    expiresAt: time.expiresAt,
    displayTimezone: state.once.zone,
    reason: state.name.trim() || null,
    idempotencyKey,
  };
}

const values = (text: string) =>
  text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const oneOrMany = (items: string[]) => (items.length === 1 ? items[0] : items);

export function watchFilter(state: EditorState): ProjectEventFilterV1 {
  const { watch } = state;
  if (watch.preset === 'channel-post')
    return {
      version: 1,
      source: PROJECT_EVENT_CHANNEL_SOURCE,
      eventType: PROJECT_EVENT_CHANNEL_TYPE,
      subjectType: 'agent_channel',
      subjectId: watch.channel.trim().replace(/^#/, ''),
    };
  if (watch.preset !== 'custom') {
    const preset = WATCH_PRESETS[watch.preset];
    return { version: 1, source: preset.source, eventType: preset.eventType };
  }
  const filter: ProjectEventFilterV1 = { version: 1 };
  for (const field of ['source', 'eventType', 'subjectType', 'subjectId'] as const) {
    const items = values(watch[field]);
    if (items.length) filter[field] = oneOrMany(items);
  }
  const severities = values(watch.severity) as ProjectEventSeverity[];
  if (severities.length)
    filter.severity = oneOrMany(severities) as ProjectEventFilterV1['severity'];
  return filter;
}

function watchLimits(state: EditorState) {
  return {
    cooldownMs: Math.round(state.watch.cooldownMinutes * 60_000),
    maxConcurrent: state.watch.maxConcurrent,
    maxExecutions: state.watch.maxExecutions,
  };
}

export function watchCreateRequest(
  state: EditorState,
  idempotencyKey: string
): CreateProjectStandingWatchRequest {
  return {
    filter: watchFilter(state),
    action: scheduledAction(state),
    reason: state.name.trim() || null,
    idempotencyKey,
    ...watchLimits(state),
  };
}

/**
 * A watch edit. Only its creator may change what it does, so a non-creator's request leaves
 * `action` out entirely (the API rejects any change to it from anyone else).
 */
export function watchUpdateRequest(
  state: EditorState,
  original: ProjectStandingWatch,
  isCreator: boolean
): UpdateProjectStandingWatchRequest {
  return {
    expectedVersion: original.version,
    filter: watchFilter(state),
    reason: state.name.trim() || null,
    ...watchLimits(state),
    ...(isCreator ? { action: scheduledAction(state) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export function validateStep(
  state: EditorState,
  step: StepId,
  context: { canChangeAction: boolean; now?: number }
): Errors {
  const errors: Errors = {};
  if (step === 'start' && !state.start) errors.start = 'Pick what starts it.';
  if (step === 'when') {
    if (state.start === 'schedule') {
      if (state.schedule.preset === 'weekly' && !state.schedule.weeklyDays.length)
        errors.schedule = 'Pick at least one day.';
      const cron = toCron(state.schedule);
      const problem = state.schedule.preset === 'custom' ? cronError(cron) : null;
      if (problem) errors.schedule = problem;
    }
    if (state.start === 'once') {
      const time = resolveOnceTime(state.once, context.now);
      if ('error' in time) errors.once = time.error;
    }
    if (state.start === 'github') {
      const filters = buildGitHubFilters(githubInput(state));
      if (!areGitHubTriggerActionsValid(state.github.eventType, filters.actions))
        errors.github = 'Some actions do not exist for this GitHub event.';
      if (
        filters.authorAssociation?.some(
          (value) => !(GITHUB_AUTHOR_ASSOCIATIONS as readonly string[]).includes(value)
        )
      )
        errors.github = 'Choose an author association from the listed GitHub values.';
      if (
        filters.reviewStates?.some(
          (value) => !(GITHUB_REVIEW_STATES as readonly string[]).includes(value)
        )
      )
        errors.github = 'Choose a review state from the listed GitHub values.';
    }
    if (state.start === 'webhook' && state.webhook.filters.some((filter) => !filter.path.trim()))
      errors.webhook = 'Every filter needs a path, like event.action.';
    if (state.start === 'email') {
      const senders = splitEmailList(state.email.allowedSenders);
      if (!senders) errors.email = 'Add at least one allowed sender.';
      else if (senders.some((sender) => !looksLikeEmail(sender)))
        errors.email = 'Each allowed sender must look like an email address.';
    }
    if (state.start === 'event') {
      const { watch } = state;
      if (watch.preset === 'channel-post' && !watch.channel.trim().replace(/^#/, ''))
        errors.watch = 'Enter the channel to listen to.';
      if (watch.preset === 'custom') {
        const filter = watchFilter(state);
        if (Object.keys(filter).length === 1) errors.watch = 'Fill in at least one field.';
        const unknown = values(watch.severity).filter(
          (value) => !PROJECT_EVENT_SEVERITIES.includes(value as ProjectEventSeverity)
        );
        if (unknown.length) errors.watch = `Unknown severity: ${unknown.join(', ')}.`;
      }
      const minCooldown = DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS / 60_000;
      if (!(watch.cooldownMinutes >= minCooldown))
        errors.limits = `Wait at least ${minCooldown} minute between runs.`;
      else if (
        !Number.isInteger(watch.maxConcurrent) ||
        watch.maxConcurrent < 1 ||
        watch.maxConcurrent > DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT
      )
        errors.limits = `Run 1 to ${DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT} at once.`;
      else if (
        !Number.isInteger(watch.maxExecutions) ||
        watch.maxExecutions < 1 ||
        watch.maxExecutions > DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS
      )
        errors.limits = `Allow 1 to ${DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS} runs in total.`;
    }
  }
  if (step === 'what' && context.canChangeAction) {
    const { action } = state;
    if (!action.prompt.trim()) errors.prompt = 'Say what the agent should do.';
    const triggerPrompt =
      state.start === 'schedule' ||
      state.start === 'github' ||
      state.start === 'webhook' ||
      state.start === 'email' ||
      state.start === 'incident';
    if (triggerPrompt && action.prompt.length > DEFAULT_CRON_TEMPLATE_MAX_LENGTH)
      errors.prompt = `Keep it under ${DEFAULT_CRON_TEMPLATE_MAX_LENGTH} characters.`;
    if (
      !triggerPrompt &&
      byteLength(action.prompt) > DEFAULT_PROJECT_EVENT_SCHEDULE_PROMPT_MAX_BYTES
    )
      errors.prompt = 'This prompt is too long.';
    if (action.kind === 'message' && !action.sessionId)
      errors.sessionId = 'Pick the chat to message.';
    if ((state.start === 'webhook' || state.start === 'email') && !action.agentProfileId)
      errors.agentProfileId = `${state.start === 'webhook' ? 'Webhook' : 'Email'} automations need an agent profile.`;
  }
  if (step === 'review') {
    const isTrigger =
      state.start === 'schedule' ||
      state.start === 'github' ||
      state.start === 'webhook' ||
      state.start === 'email' ||
      state.start === 'incident';
    if (isTrigger && !state.name.trim()) errors.name = 'Give it a name.';
    if (state.name.trim().length > DEFAULT_TRIGGER_NAME_MAX_LENGTH)
      errors.name = `Keep the name under ${DEFAULT_TRIGGER_NAME_MAX_LENGTH} characters.`;
    if (state.start === 'github') {
      const queue = githubQueueConfig(state);
      if (!Number.isSafeInteger(queue.queueMaxPending) || queue.queueMaxPending < 1)
        errors.queueMaxPending = 'Pending event limit must be a positive whole number.';
      if (!Number.isSafeInteger(queue.queueTtlSeconds) || queue.queueTtlSeconds < 1)
        errors.queueTtlHours = 'Maximum wait must be at least one second.';
      else {
        const expiry = new Date(Date.now() + queue.queueTtlSeconds * 1000);
        if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().length !== 24)
          errors.queueTtlHours = 'Maximum wait is too large.';
      }
    }
    if (isTrigger) {
      const { maxConcurrent } = state.trigger;
      if (
        !Number.isInteger(maxConcurrent) ||
        maxConcurrent < 1 ||
        maxConcurrent > DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT
      )
        errors.maxConcurrent = `Run 1 to ${DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT} at once.`;
      if (hasValidationErrors(validateResourceState(state.trigger.resources)))
        errors.resources = 'Fix the machine settings.';
    }
  }
  return errors;
}

/** API refusals the editor can explain, keyed to the field that should change. */
export function friendlySaveError(error: unknown): { field?: string; message: string } {
  const message = error instanceof Error ? error.message : 'Could not save it';
  if (isVersionConflict(error))
    return {
      message:
        'Someone changed this automation while you were editing. Open it again to see their change, then make yours.',
    };
  const limit = /Maximum triggers per project \((\d+)\) reached/.exec(message);
  if (limit)
    return {
      message: `This project already has the most recurring and reacting automations it can have (${limit[1]}). Delete one you no longer need, or ask an admin to raise the limit.`,
    };
  if (/already exists in this project/.test(message))
    return {
      field: 'name',
      message: 'Another automation already has this name. Pick a different one.',
    };
  return { message };
}
