import type {
  ProjectSchedule,
  ProjectScheduleList,
  ProjectScheduleMutationResult,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { ProjectEventScheduleEnv } from './project-event-schedules-config';
import { scheduleLimits } from './project-event-schedules-config';
import {
  normalizeCreateProjectSchedule,
  normalizeRescheduleProjectSchedule,
  normalizeScheduleVersion,
} from './project-event-schedules-validation';
import {
  ProjectEventCursorError,
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { normalizeListLimit } from './project-events-normalization';
import {
  byteLength,
  isPlainObject,
  normalizeNullableText,
  normalizeText,
  stableStringify,
} from './project-events-values';
import type { Env } from './types';

type ScheduleEnv = Env & ProjectEventScheduleEnv;
const integer = v.pipe(v.number(), v.safeInteger());
const nullableText = v.nullable(v.string());
const nullableInteger = v.nullable(integer);
export const ScheduledActionSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('message_session'), sessionId: v.string(), prompt: v.string() }),
  v.strictObject({
    kind: v.literal('start_session'),
    prompt: v.string(),
    agentProfileId: nullableText,
    skillId: nullableText,
  }),
]);
export const ProjectScheduleRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  creator_user_id: v.string(),
  creator_chat_session_id: nullableText,
  target_session_id: nullableText,
  reason: nullableText,
  action_json: v.string(),
  fingerprint: v.string(),
  state: v.picklist([
    'pending',
    'processing',
    'admitted',
    'cancelled',
    'expired',
    'failed',
    'ambiguous',
  ]),
  due_at: integer,
  display_timezone: v.string(),
  expires_at: integer,
  version: v.pipe(integer, v.minValue(1)),
  idempotency_key: v.string(),
  created_at: integer,
  updated_at: integer,
  next_attempt_at: nullableInteger,
  attempt_count: v.pipe(integer, v.minValue(0)),
  last_error: nullableText,
  event_id: nullableText,
  delivery_id: nullableText,
  result_task_id: nullableText,
  result_session_id: nullableText,
  claim_token: nullableText,
  claim_until: nullableInteger,
  watch_id: nullableText,
  source_event_id: nullableText,
  reserved_task_id: nullableText,
  reserved_session_id: nullableText,
  reserved_message_id: nullableText,
  reserved_status_id: nullableText,
  execution_finished_at: nullableInteger,
});
export type ProjectScheduleRow = v.InferOutput<typeof ProjectScheduleRowSchema>;

export class ProjectScheduleNotFoundError extends Error {
  constructor() {
    super('Schedule not found');
    this.name = 'ProjectScheduleNotFoundError';
  }
}

export function mapSchedule(row: unknown): ProjectSchedule {
  const r = v.parse(ProjectScheduleRowSchema, row);
  return {
    id: r.id,
    projectId: r.project_id,
    creatorUserId: r.creator_user_id,
    creatorChatSessionId: r.creator_chat_session_id,
    reason: r.reason,
    action: v.parse(ScheduledActionSchema, JSON.parse(r.action_json)),
    state: r.state,
    dueAt: r.due_at,
    displayTimezone: r.display_timezone,
    expiresAt: r.expires_at,
    version: r.version,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    nextAttemptAt: r.next_attempt_at,
    attemptCount: r.attempt_count,
    lastError: r.last_error,
    eventId: r.event_id,
    deliveryId: r.delivery_id,
    resultTaskId: r.result_task_id,
    resultSessionId: r.result_session_id,
    watchId: r.watch_id,
    sourceEventId: r.source_event_id,
  };
}

export function readScheduleRow(
  sql: SqlStorage,
  projectId: string,
  id: string
): ProjectScheduleRow | null {
  const row = sql
    .exec('SELECT * FROM project_schedules WHERE project_id = ? AND id = ?', projectId, id)
    .toArray()[0];
  return row ? v.parse(ProjectScheduleRowSchema, row) : null;
}

export function getSchedule(
  sql: SqlStorage,
  projectId: string,
  id: string
): ProjectSchedule | null {
  const row = readScheduleRow(sql, projectId, id);
  return row ? mapSchedule(row) : null;
}

function requiredSchedule(sql: SqlStorage, projectId: string, id: string): ProjectSchedule {
  const schedule = getSchedule(sql, projectId, id);
  if (!schedule) throw new ProjectScheduleNotFoundError();
  return schedule;
}

function result(
  schedule: ProjectSchedule,
  changed: boolean,
  idempotent = false
): ProjectScheduleMutationResult {
  return {
    schedule,
    changed,
    idempotent,
    actionAlreadyAdmitted:
      schedule.state === 'admitted' ||
      schedule.eventId !== null ||
      schedule.resultTaskId !== null ||
      schedule.deliveryId !== null,
  };
}

/** Caller supplies the transaction and current creator/project authority. */
export function createSchedule(
  sql: SqlStorage,
  env: ScheduleEnv,
  projectId: string,
  creator: { userId: string; chatSessionId: string | null },
  value: unknown,
  now: number
): ProjectScheduleMutationResult {
  const limits = scheduleLimits(env),
    eventLimits = resolveProjectEventLimits(env);
  if (!isPlainObject(value)) throw new ProjectEventValidationError('schedule must be an object');
  const idempotencyKey = normalizeText(
    value.idempotencyKey,
    'idempotencyKey',
    eventLimits.maxFilterStringBytes
  );
  const existingValue = sql
    .exec(
      'SELECT * FROM project_schedules WHERE project_id = ? AND creator_user_id = ? AND idempotency_key = ?',
      projectId,
      creator.userId,
      idempotencyKey
    )
    .toArray()[0];
  const existing = existingValue ? v.parse(ProjectScheduleRowSchema, existingValue) : null;
  // Replays are validated at the original admission time, even after due/expiry.
  const normalized = normalizeCreateProjectSchedule(
    value,
    limits,
    eventLimits,
    existing?.created_at ?? now
  );
  const fingerprint = stableStringify({
    ...normalized,
    expiresAt: value.expiresAt === undefined ? null : normalized.expiresAt,
    creatorChatSessionId: creator.chatSessionId,
  });
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new ProjectEventValidationError(
        'Schedule idempotency conflict: the key belongs to a different create request'
      );
    return result(mapSchedule(existing), false, true);
  }
  // Existing project/recent covering index bounds the retained-history probe.
  // Replays return above this guard; retention never discards idempotency identities.
  const retained = sql
    .exec(
      `SELECT id FROM project_schedules WHERE project_id = ? LIMIT ?`,
      projectId,
      limits.maxRetainedSchedules
    )
    .toArray();
  if (retained.length >= limits.maxRetainedSchedules)
    throw new ProjectEventLimitExceededError('Retained schedule capacity reached');
  const active = sql
    .exec(
      `SELECT id FROM project_schedules INDEXED BY idx_project_schedules_active_capacity
     WHERE project_id = ? AND execution_finished_at IS NULL
       AND state IN ('pending','processing','admitted') LIMIT ?`,
      projectId,
      limits.maxSchedules
    )
    .toArray();
  if (active.length >= limits.maxSchedules)
    throw new ProjectEventLimitExceededError('Active schedule capacity reached');
  const id = crypto.randomUUID();
  sql.exec(
    `INSERT INTO project_schedules
    (id,project_id,creator_user_id,creator_chat_session_id,target_session_id,reason,action_json,fingerprint,
     state,due_at,display_timezone,expires_at,version,idempotency_key,created_at,updated_at,next_attempt_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,1,?,?,?,?)`,
    id,
    projectId,
    creator.userId,
    creator.chatSessionId,
    normalized.action.kind === 'message_session' ? normalized.action.sessionId : null,
    normalized.reason,
    stableStringify(normalized.action),
    fingerprint,
    normalized.dueAt,
    normalized.displayTimezone,
    normalized.expiresAt,
    idempotencyKey,
    now,
    now,
    normalized.dueAt
  );
  return result(requiredSchedule(sql, projectId, id), true);
}

const CursorSchema = v.strictObject({
  version: v.literal(1),
  projectId: v.string(),
  sessionId: nullableText,
  createdAt: integer,
  id: v.string(),
});

export function listSchedules(
  sql: SqlStorage,
  env: ScheduleEnv,
  projectId: string,
  input: { cursor?: string | null; sessionId?: string | null; limit?: number | null } = {}
): ProjectScheduleList {
  const limits = resolveProjectEventLimits(env);
  const limit = normalizeListLimit(input.limit, limits);
  const sessionId = normalizeNullableText(
    input.sessionId,
    'sessionId',
    limits.maxFilterStringBytes
  );
  let cursor: v.InferOutput<typeof CursorSchema> | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    try {
      if (byteLength(input.cursor) > limits.maxReasonBytes) throw new Error('cursor too large');
      cursor = v.parse(CursorSchema, JSON.parse(input.cursor));
      if (cursor.projectId !== projectId || cursor.sessionId !== sessionId)
        throw new Error('cursor scope differs');
    } catch {
      throw new ProjectEventCursorError('Invalid schedule cursor or scope');
    }
  }
  const query = (
    column: 'creator_chat_session_id' | 'target_session_id' | null
  ): ProjectSchedule[] => {
    const conditions = ['project_id = ?'];
    const bindings: Array<string | number> = [projectId];
    if (column && sessionId) {
      conditions.push(column === 'creator_chat_session_id'
        ? 'creator_chat_session_id = ?' : 'target_session_id = ?');
      bindings.push(sessionId);
    }
    if (cursor) {
      conditions.push('(created_at, id) < (?, ?)');
      bindings.push(cursor.createdAt, cursor.id);
    }
    bindings.push(limit + 1);
    const whereClause = conditions.join(' AND ');
    return sql
      .exec(
        `SELECT * FROM project_schedules WHERE ${whereClause}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...bindings
      )
      .toArray()
      .map(mapSchedule);
  };
  const candidates = sessionId
    ? [...query('creator_chat_session_id'), ...query('target_session_id')]
    : query(null);
  const ordered = [...new Map(candidates.map((s) => [s.id, s])).values()].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
  const schedules = ordered.slice(0, limit),
    last = schedules[schedules.length - 1];
  return {
    schedules,
    nextCursor:
      ordered.length > limit && last
        ? JSON.stringify({
            version: 1,
            projectId,
            sessionId,
            createdAt: last.createdAt,
            id: last.id,
          })
        : null,
  };
}

export function rescheduleSchedule(
  sql: SqlStorage,
  env: ScheduleEnv,
  projectId: string,
  id: string,
  value: unknown,
  now: number
): ProjectScheduleMutationResult {
  const existing = requiredSchedule(sql, projectId, id);
  const input = normalizeRescheduleProjectSchedule(
    value,
    scheduleLimits(env),
    resolveProjectEventLimits(env),
    now
  );
  if (existing.version !== input.expectedVersion)
    throw new ProjectEventValidationError('Schedule version conflict');
  if (existing.state !== 'pending')
    throw new ProjectEventValidationError('Only pending schedules may be rescheduled');
  const timezone = input.displayTimezone ?? existing.displayTimezone;
  if (
    existing.dueAt === input.dueAt &&
    existing.expiresAt === input.expiresAt &&
    existing.displayTimezone === timezone
  )
    return result(existing, false, true);
  const changed = sql
    .exec(
      `UPDATE project_schedules SET due_at = ?, expires_at = ?, display_timezone = ?,
     next_attempt_at = ?, version = version + 1, updated_at = ?
     WHERE project_id = ? AND id = ? AND version = ? AND state = 'pending' RETURNING id`,
      input.dueAt,
      input.expiresAt,
      timezone,
      input.dueAt,
      now,
      projectId,
      id,
      input.expectedVersion
    )
    .toArray();
  if (changed.length !== 1)
    throw new ProjectEventValidationError('Schedule version or state conflict');
  return result(requiredSchedule(sql, projectId, id), true);
}

export function cancelSchedule(
  sql: SqlStorage,
  env: ScheduleEnv,
  projectId: string,
  id: string,
  value: unknown,
  now: number
): ProjectScheduleMutationResult {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !['expectedVersion', 'reason'].includes(key))
  )
    throw new ProjectEventValidationError('Cancellation accepts only expectedVersion and reason');
  const version = normalizeScheduleVersion(value.expectedVersion);
  const reason = normalizeNullableText(
    value.reason,
    'reason',
    resolveProjectEventLimits(env).maxReasonBytes
  );
  const existing = requiredSchedule(sql, projectId, id);
  if (
    existing.state === 'admitted' ||
    existing.eventId ||
    existing.deliveryId ||
    existing.resultTaskId
  )
    return result(existing, false);
  if (
    existing.state === 'cancelled' &&
    (version === existing.version || version === existing.version - 1) &&
    existing.lastError === reason
  )
    return result(existing, false, true);
  if (existing.version !== version)
    throw new ProjectEventValidationError('Schedule version conflict');
  if (existing.state !== 'pending' && existing.state !== 'processing')
    throw new ProjectEventValidationError('Schedule cannot be cancelled in its current state');
  const changed = sql
    .exec(
      `UPDATE project_schedules SET state = 'cancelled', version = version + 1, updated_at = ?,
     next_attempt_at = NULL, claim_token = NULL, claim_until = NULL, execution_finished_at = ?, last_error = ?
     WHERE project_id = ? AND id = ? AND version = ? AND state IN ('pending','processing') RETURNING id`,
      now,
      now,
      reason,
      projectId,
      id,
      version
    )
    .toArray();
  if (changed.length !== 1)
    throw new ProjectEventValidationError('Schedule version or state conflict');
  return result(requiredSchedule(sql, projectId, id), true);
}
