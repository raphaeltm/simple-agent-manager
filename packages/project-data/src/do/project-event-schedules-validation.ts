import type {
  CreateProjectScheduleRequest,
  CreateProjectStandingWatchRequest,
  ProjectScheduledAction,
  RescheduleProjectScheduleRequest,
  UpdateProjectStandingWatchRequest,
} from '@simple-agent-manager/shared';
import type { ProjectEventFilterV1, ProjectEventLimits } from '@simple-agent-manager/shared';

import type { ProjectEventScheduleLimits } from './project-event-schedules-config';
import { ProjectEventValidationError } from './project-events-contracts';
import { compileProjectEventFilter } from './project-events-normalization';
import {
  byteLength,
  isPlainObject,
  normalizeNullableText,
  normalizeText,
} from './project-events-values';

function object(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ProjectEventValidationError(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key))
      throw new ProjectEventValidationError(`${name}.${key} is not allowed`);
  }
  return value;
}

export function normalizeScheduleVersion(value: unknown): number {
  return positiveInteger(value, 'expectedVersion');
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectEventValidationError(`${field} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  const result = positiveInteger(value, field);
  if (!Number.isFinite(new Date(result).getTime())) {
    throw new ProjectEventValidationError(`${field} must be a valid UTC timestamp`);
  }
  return result;
}

export function normalizeScheduleTimezone(value: unknown, eventLimits: ProjectEventLimits): string {
  const zone = normalizeText(value, 'displayTimezone', eventLimits.maxFilterStringBytes);
  if (/^[+-]/.test(zone))
    throw new ProjectEventValidationError('displayTimezone must be an IANA timezone');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new ProjectEventValidationError('displayTimezone must be an IANA timezone');
  }
}

export function normalizeScheduledAction(
  value: unknown,
  limits: ProjectEventScheduleLimits,
  eventLimits: ProjectEventLimits
): ProjectScheduledAction {
  if (!isPlainObject(value)) throw new ProjectEventValidationError('action must be an object');
  const fields =
    value.kind === 'message_session'
      ? ['kind', 'sessionId', 'prompt']
      : ['kind', 'prompt', 'agentProfileId', 'skillId'];
  const action = object(value, fields, 'action');
  if (typeof action.prompt !== 'string' || !action.prompt.trim()) {
    throw new ProjectEventValidationError('action.prompt must be a non-empty string');
  }
  if (byteLength(action.prompt) > limits.promptBytes) {
    throw new ProjectEventValidationError(
      `action.prompt must be ${limits.promptBytes} bytes or fewer`
    );
  }
  if (action.kind === 'message_session') {
    return {
      kind: action.kind,
      sessionId: normalizeText(
        action.sessionId,
        'action.sessionId',
        eventLimits.maxFilterStringBytes
      ),
      prompt: action.prompt,
    };
  }
  if (action.kind === 'start_session') {
    if (action.prompt.length > limits.taskPromptMaxLength) {
      throw new ProjectEventValidationError(
        `action.prompt must be ${limits.taskPromptMaxLength} characters or fewer for start_session`
      );
    }
    return {
      kind: action.kind,
      prompt: action.prompt,
      agentProfileId: normalizeNullableText(
        action.agentProfileId,
        'action.agentProfileId',
        eventLimits.maxFilterStringBytes
      ),
      skillId: normalizeNullableText(
        action.skillId,
        'action.skillId',
        eventLimits.maxFilterStringBytes
      ),
    };
  }
  throw new ProjectEventValidationError('action.kind must be message_session or start_session');
}

function scheduleTimes(
  input: Record<string, unknown>,
  limits: ProjectEventScheduleLimits,
  now: number
) {
  timestamp(now, 'now');
  const dueAt = timestamp(input.dueAt, 'dueAt');
  if (dueAt - now > limits.maxHorizonMs || now - dueAt > limits.lateGraceMs) {
    throw new ProjectEventValidationError(
      'dueAt is outside the allowed scheduling horizon or late grace'
    );
  }
  const expiresAt = timestamp(
    input.expiresAt === undefined ? dueAt + limits.lateGraceMs : input.expiresAt,
    'expiresAt'
  );
  if (expiresAt < dueAt || expiresAt - dueAt > limits.lateGraceMs || expiresAt <= now) {
    throw new ProjectEventValidationError(
      'expiresAt must be unexpired, at or after dueAt, and within late grace'
    );
  }
  return { dueAt, expiresAt };
}

export type NormalizedCreateProjectSchedule = CreateProjectScheduleRequest & {
  expiresAt: number;
  reason: string | null;
};

export function normalizeCreateProjectSchedule(
  value: unknown,
  limits: ProjectEventScheduleLimits,
  eventLimits: ProjectEventLimits,
  now = Date.now()
): NormalizedCreateProjectSchedule {
  const input = object(
    value,
    ['action', 'dueAt', 'displayTimezone', 'expiresAt', 'idempotencyKey', 'reason'],
    'schedule'
  );
  return {
    action: normalizeScheduledAction(input.action, limits, eventLimits),
    ...scheduleTimes(input, limits, now),
    displayTimezone: normalizeScheduleTimezone(input.displayTimezone, eventLimits),
    idempotencyKey: normalizeText(
      input.idempotencyKey,
      'idempotencyKey',
      eventLimits.maxFilterStringBytes
    ),
    reason: normalizeNullableText(input.reason, 'reason', eventLimits.maxReasonBytes),
  };
}

export function normalizeRescheduleProjectSchedule(
  value: unknown,
  limits: ProjectEventScheduleLimits,
  eventLimits: ProjectEventLimits,
  now = Date.now()
): RescheduleProjectScheduleRequest & { expiresAt: number } {
  const input = object(
    value,
    ['expectedVersion', 'dueAt', 'expiresAt', 'displayTimezone'],
    'reschedule'
  );
  return {
    expectedVersion: normalizeScheduleVersion(input.expectedVersion),
    ...scheduleTimes(input, limits, now),
    ...(input.displayTimezone === undefined
      ? {}
      : { displayTimezone: normalizeScheduleTimezone(input.displayTimezone, eventLimits) }),
  };
}

function watchControls(input: Record<string, unknown>, limits: ProjectEventScheduleLimits) {
  const cooldownMs = positiveInteger(
    input.cooldownMs === undefined ? limits.watchCooldownMinMs : input.cooldownMs,
    'cooldownMs'
  );
  const maxConcurrent = positiveInteger(
    input.maxConcurrent === undefined ? limits.watchMaxConcurrent : input.maxConcurrent,
    'maxConcurrent'
  );
  const maxExecutions = positiveInteger(
    input.maxExecutions === undefined ? limits.watchMaxExecutions : input.maxExecutions,
    'maxExecutions'
  );
  if (
    cooldownMs < limits.watchCooldownMinMs ||
    maxConcurrent > limits.watchMaxConcurrent ||
    maxExecutions > limits.watchMaxExecutions
  ) {
    throw new ProjectEventValidationError(
      'Watch controls exceed configured execution/concurrency limits or minimum cooldown'
    );
  }
  return { cooldownMs, maxConcurrent, maxExecutions };
}

export type NormalizedCreateProjectStandingWatch = CreateProjectStandingWatchRequest & {
  reason: string | null;
  cooldownMs: number;
  maxConcurrent: number;
  maxExecutions: number;
};

export function normalizeCreateProjectStandingWatch(
  value: unknown,
  limits: ProjectEventScheduleLimits,
  eventLimits: ProjectEventLimits
): NormalizedCreateProjectStandingWatch {
  const input = object(
    value,
    [
      'filter',
      'action',
      'idempotencyKey',
      'reason',
      'cooldownMs',
      'maxConcurrent',
      'maxExecutions',
    ],
    'watch'
  );
  return {
    filter: compileProjectEventFilter(input.filter as ProjectEventFilterV1, eventLimits).filter,
    action: normalizeScheduledAction(input.action, limits, eventLimits),
    idempotencyKey: normalizeText(
      input.idempotencyKey,
      'idempotencyKey',
      eventLimits.maxFilterStringBytes
    ),
    reason: normalizeNullableText(input.reason, 'reason', eventLimits.maxReasonBytes),
    ...watchControls(input, limits),
  };
}

export function normalizeUpdateProjectStandingWatch(
  value: unknown,
  limits: ProjectEventScheduleLimits,
  eventLimits: ProjectEventLimits
): UpdateProjectStandingWatchRequest {
  const input = object(
    value,
    [
      'expectedVersion',
      'filter',
      'action',
      'reason',
      'cooldownMs',
      'maxConcurrent',
      'maxExecutions',
    ],
    'watchUpdate'
  );
  const controls = watchControls(input, limits);
  return {
    expectedVersion: normalizeScheduleVersion(input.expectedVersion),
    ...(input.filter === undefined
      ? {}
      : {
          filter: compileProjectEventFilter(input.filter as ProjectEventFilterV1, eventLimits)
            .filter,
        }),
    ...(input.action === undefined
      ? {}
      : { action: normalizeScheduledAction(input.action, limits, eventLimits) }),
    ...(input.reason === undefined
      ? {}
      : { reason: normalizeNullableText(input.reason, 'reason', eventLimits.maxReasonBytes) }),
    ...(input.cooldownMs === undefined ? {} : { cooldownMs: controls.cooldownMs }),
    ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: controls.maxConcurrent }),
    ...(input.maxExecutions === undefined ? {} : { maxExecutions: controls.maxExecutions }),
  };
}
