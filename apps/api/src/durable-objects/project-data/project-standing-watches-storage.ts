import type {
  ProjectStandingWatch,
  ProjectStandingWatchList,
  ProjectStandingWatchMutationResult,
} from '@simple-agent-manager/shared';
import { PROJECT_EVENT_SEVERITIES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { type ProjectEventScheduleEnv,scheduleLimits } from './project-event-schedules-config';
import { ScheduledActionSchema } from './project-event-schedules-storage';
import {
  normalizeCreateProjectStandingWatch,
  normalizeScheduleVersion,
  normalizeUpdateProjectStandingWatch,
} from './project-event-schedules-validation';
import { cancelProjectEventSubscription,createProjectEventSubscription } from './project-events';
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
  stableStringify,
} from './project-events-values';
import type { Env } from './types';

type WatchEnv = Env & ProjectEventScheduleEnv;
const integer = v.pipe(v.number(), v.safeInteger());
const positive = v.pipe(integer, v.minValue(1));
const nullableText = v.nullable(v.string());
const stringSet = v.union([v.string(), v.array(v.string())]);
const severity = v.picklist(PROJECT_EVENT_SEVERITIES);
const FilterSchema = v.strictObject({
  version: v.literal(1),
  source: v.optional(stringSet),
  eventType: v.optional(stringSet),
  subjectType: v.optional(stringSet),
  subjectId: v.optional(stringSet),
  severity: v.optional(v.union([severity, v.array(severity)])),
});
export const ProjectStandingWatchRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  creator_user_id: v.string(),
  reason: nullableText,
  filter_json: v.string(),
  action_json: v.string(),
  fingerprint: v.string(),
  state: v.picklist(['active', 'paused', 'revoked']),
  version: positive,
  idempotency_key: v.string(),
  cooldown_ms: positive,
  max_concurrent: positive,
  max_executions: positive,
  execution_count: v.pipe(integer, v.minValue(0)),
  next_eligible_at: integer,
  next_attempt_at: v.nullable(integer),
  subscription_id: v.string(),
  created_at: integer,
  updated_at: integer,
  last_error: nullableText,
});
export type ProjectStandingWatchRow = v.InferOutput<typeof ProjectStandingWatchRowSchema>;

export class ProjectStandingWatchNotFoundError extends Error {
  constructor() {
    super('Standing watch not found');
    this.name = 'ProjectStandingWatchNotFoundError';
  }
}

export function mapWatch(value: unknown): ProjectStandingWatch {
  const row = v.parse(ProjectStandingWatchRowSchema, value);
  return {
    id: row.id,
    projectId: row.project_id,
    creatorUserId: row.creator_user_id,
    reason: row.reason,
    filter: v.parse(FilterSchema, JSON.parse(row.filter_json)),
    action: v.parse(ScheduledActionSchema, JSON.parse(row.action_json)),
    state: row.state,
    version: row.version,
    idempotencyKey: row.idempotency_key,
    cooldownMs: row.cooldown_ms,
    maxConcurrent: row.max_concurrent,
    maxExecutions: row.max_executions,
    executionCount: row.execution_count,
    nextEligibleAt: row.next_eligible_at,
    subscriptionId: row.subscription_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

export function readWatchRow(
  sql: SqlStorage,
  projectId: string,
  id: string
): ProjectStandingWatchRow | null {
  const row = sql
    .exec('SELECT * FROM project_standing_watches WHERE project_id = ? AND id = ?', projectId, id)
    .toArray()[0];
  return row ? v.parse(ProjectStandingWatchRowSchema, row) : null;
}

export function getWatch(
  sql: SqlStorage,
  projectId: string,
  id: string
): ProjectStandingWatch | null {
  const row = readWatchRow(sql, projectId, id);
  return row ? mapWatch(row) : null;
}

function requiredWatch(sql: SqlStorage, projectId: string, id: string): ProjectStandingWatch {
  const watch = getWatch(sql, projectId, id);
  if (!watch) throw new ProjectStandingWatchNotFoundError();
  return watch;
}

function mutation(
  watch: ProjectStandingWatch,
  changed: boolean,
  idempotent = false
): ProjectStandingWatchMutationResult {
  return { watch, changed, idempotent };
}

function subscribe(
  sql: SqlStorage,
  env: WatchEnv,
  watch: Pick<ProjectStandingWatch, 'id' | 'projectId' | 'filter' | 'reason' | 'action'>,
  version: number
): string {
  return createProjectEventSubscription(sql, env, watch.projectId, {
    projectId: watch.projectId,
    owner: { type: 'standing_watch', id: watch.id },
    idempotencyKey: `${watch.id}:${version}`,
    filter: watch.filter,
    reason: watch.reason,
    deliveryPreference: {
      requested: 'record_only',
      resolved: 'record_only',
      ...(watch.action.kind === 'message_session'
        ? { target: { sessionId: watch.action.sessionId } }
        : {}),
    },
    expiresAt: null,
  }).subscription.id;
}

/** Strong revocation of future matching and generated actions not yet admitted. */
function cancelPending(
  sql: SqlStorage,
  env: WatchEnv,
  watch: ProjectStandingWatch,
  now: number,
  reason: string | null
): void {
  const subscription = sql
    .exec(
      'SELECT id FROM project_event_subscriptions WHERE project_id = ? AND id = ?',
      watch.projectId,
      watch.subscriptionId
    )
    .toArray()[0];
  if (subscription) {
    cancelProjectEventSubscription(sql, env, watch.projectId, {
      projectId: watch.projectId,
      subscriptionId: watch.subscriptionId,
      cancelledBy: { type: 'standing_watch', id: watch.id },
      reason,
    });
  }
  sql.exec(
    `UPDATE project_schedules SET state = 'cancelled', version = version + 1,
      next_attempt_at = NULL, claim_token = NULL, claim_until = NULL,
      execution_finished_at = ?, updated_at = ?, last_error = ?
     WHERE project_id = ? AND watch_id = ? AND execution_finished_at IS NULL
       AND state IN ('pending','processing') AND event_id IS NULL AND delivery_id IS NULL
       AND result_task_id IS NULL AND result_session_id IS NULL`,
    now,
    now,
    reason,
    watch.projectId,
    watch.id
  );
}

/** Caller owns the transaction and project management authority. */
export function createWatch(
  sql: SqlStorage,
  env: WatchEnv,
  projectId: string,
  userId: string,
  value: unknown,
  now: number
): ProjectStandingWatchMutationResult {
  const limits = scheduleLimits(env),
    eventLimits = resolveProjectEventLimits(env);
  const input = normalizeCreateProjectStandingWatch(value, limits, eventLimits);
  const fingerprint = stableStringify({
    ...input,
    cooldownMs: isPlainObject(value) && value.cooldownMs === undefined ? null : input.cooldownMs,
    maxConcurrent:
      isPlainObject(value) && value.maxConcurrent === undefined ? null : input.maxConcurrent,
    maxExecutions:
      isPlainObject(value) && value.maxExecutions === undefined ? null : input.maxExecutions,
  });
  const old = sql
    .exec(
      'SELECT * FROM project_standing_watches WHERE project_id = ? AND creator_user_id = ? AND idempotency_key = ?',
      projectId,
      userId,
      input.idempotencyKey
    )
    .toArray()[0];
  if (old) {
    const row = v.parse(ProjectStandingWatchRowSchema, old);
    if (row.fingerprint !== fingerprint)
      throw new ProjectEventValidationError('Standing watch idempotency conflict');
    return mutation(mapWatch(row), false, true);
  }
  // Existing project/recent covering index bounds the retained-history probe.
  // Replays return above this guard; retention never discards idempotency identities.
  const retained = sql
    .exec(
      `SELECT id FROM project_standing_watches WHERE project_id = ? LIMIT ?`,
      projectId,
      limits.maxRetainedWatches
    )
    .toArray();
  if (retained.length >= limits.maxRetainedWatches)
    throw new ProjectEventLimitExceededError('Retained standing watch capacity reached');
  const active = sql
    .exec(
      `SELECT id FROM project_standing_watches
     WHERE project_id = ? AND state IN ('active','paused') LIMIT ?`,
      projectId,
      limits.maxWatches
    )
    .toArray();
  if (active.length >= limits.maxWatches)
    throw new ProjectEventLimitExceededError('Standing watch capacity reached');
  const id = crypto.randomUUID();
  const subscriptionId = subscribe(sql, env, { ...input, id, projectId }, 1);
  sql.exec(
    `INSERT INTO project_standing_watches
     (id,project_id,creator_user_id,reason,filter_json,action_json,fingerprint,state,version,
      idempotency_key,cooldown_ms,max_concurrent,max_executions,execution_count,
      next_eligible_at,next_attempt_at,subscription_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'active',1,?,?,?,?,0,?,?,?,?,?)`,
    id,
    projectId,
    userId,
    input.reason,
    stableStringify(input.filter),
    stableStringify(input.action),
    fingerprint,
    input.idempotencyKey,
    input.cooldownMs,
    input.maxConcurrent,
    input.maxExecutions,
    now,
    now,
    subscriptionId,
    now,
    now
  );
  return mutation(requiredWatch(sql, projectId, id), true);
}

const CursorSchema = v.strictObject({
  version: v.literal(1),
  projectId: v.string(),
  sessionId: nullableText,
  createdAt: integer,
  id: v.string(),
});

/** Session context means the message action's target. Scan at most maxWatches rows
 * per page, including revoked history, and expose a continuation even on empty pages. */
export function listWatches(
  sql: SqlStorage,
  env: WatchEnv,
  projectId: string,
  input: { cursor?: string | null; sessionId?: string | null; limit?: number | null } = {}
): ProjectStandingWatchList {
  const eventLimits = resolveProjectEventLimits(env);
  const limit = normalizeListLimit(input.limit, eventLimits);
  const sessionId = normalizeNullableText(
    input.sessionId,
    'sessionId',
    eventLimits.maxFilterStringBytes
  );
  let cursor: v.InferOutput<typeof CursorSchema> | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    try {
      if (byteLength(input.cursor) > eventLimits.maxReasonBytes)
        throw new Error('cursor too large');
      cursor = v.parse(CursorSchema, JSON.parse(input.cursor));
      if (cursor.projectId !== projectId || cursor.sessionId !== sessionId)
        throw new Error('cursor scope differs');
    } catch {
      throw new ProjectEventCursorError('Invalid standing watch cursor or scope');
    }
  }
  const budget = sessionId ? scheduleLimits(env).maxWatches : limit;
  const bindings: Array<string | number> = [projectId];
  if (cursor) bindings.push(cursor.createdAt, cursor.id);
  bindings.push(budget + 1);
  const rows = sql
    .exec(
      `SELECT * FROM project_standing_watches WHERE project_id = ?
     ${cursor ? 'AND (created_at,id) < (?,?)' : ''}
     ORDER BY created_at DESC,id DESC LIMIT ?`,
      ...bindings
    )
    .toArray();
  const watches: ProjectStandingWatch[] = [];
  let inspected = 0,
    last: ProjectStandingWatch | null = null;
  while (inspected < Math.min(budget, rows.length) && watches.length < limit) {
    const watch = mapWatch(rows[inspected]);
    inspected += 1;
    last = watch;
    if (
      !sessionId ||
      (watch.action.kind === 'message_session' && watch.action.sessionId === sessionId)
    )
      watches.push(watch);
  }
  return {
    watches,
    nextCursor:
      last && rows.length > inspected
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

export function updateWatch(
  sql: SqlStorage,
  env: WatchEnv,
  projectId: string,
  id: string,
  value: unknown,
  now: number
): ProjectStandingWatchMutationResult {
  const input = normalizeUpdateProjectStandingWatch(
    value,
    scheduleLimits(env),
    resolveProjectEventLimits(env)
  );
  const watch = requiredWatch(sql, projectId, id);
  if (watch.version !== input.expectedVersion)
    throw new ProjectEventValidationError('Standing watch version conflict');
  if (watch.state === 'revoked')
    throw new ProjectEventValidationError('Revoked standing watches cannot be updated');
  const next = { ...watch, ...input };
  if (next.maxExecutions < watch.executionCount)
    throw new ProjectEventValidationError('maxExecutions cannot be below the executed count');
  const fields = [
    'filter',
    'action',
    'reason',
    'cooldownMs',
    'maxConcurrent',
    'maxExecutions',
  ] as const;
  if (fields.every((field) => stableStringify(watch[field]) === stableStringify(next[field])))
    return mutation(watch, false, true);
  cancelPending(sql, env, watch, now, 'Standing watch configuration changed');
  const version = watch.version + 1;
  const subscriptionId =
    watch.state === 'active' ? subscribe(sql, env, next, version) : watch.subscriptionId;
  const changed = sql
    .exec(
      `UPDATE project_standing_watches SET filter_json = ?, action_json = ?, reason = ?,
     cooldown_ms = ?, max_concurrent = ?, max_executions = ?, version = ?,
     subscription_id = ?, updated_at = ?, last_error = NULL
     WHERE project_id = ? AND id = ? AND version = ? RETURNING id`,
      stableStringify(next.filter),
      stableStringify(next.action),
      next.reason,
      next.cooldownMs,
      next.maxConcurrent,
      next.maxExecutions,
      version,
      subscriptionId,
      now,
      projectId,
      id,
      input.expectedVersion
    )
    .toArray();
  if (changed.length !== 1)
    throw new ProjectEventValidationError('Standing watch version conflict');
  return mutation(requiredWatch(sql, projectId, id), true);
}

function controlInput(value: unknown, env: WatchEnv, pause: boolean) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some(
      (key) => !['expectedVersion', 'reason', ...(pause ? ['paused'] : [])].includes(key)
    )
  )
    throw new ProjectEventValidationError('Invalid standing watch control fields');
  if (pause && typeof value.paused !== 'boolean')
    throw new ProjectEventValidationError('paused must be boolean');
  return {
    expectedVersion: normalizeScheduleVersion(value.expectedVersion),
    paused: value.paused === true,
    reason: normalizeNullableText(
      value.reason,
      'reason',
      resolveProjectEventLimits(env).maxReasonBytes
    ),
  };
}

export function pauseWatch(
  sql: SqlStorage,
  env: WatchEnv,
  projectId: string,
  id: string,
  value: unknown,
  now: number
): ProjectStandingWatchMutationResult {
  const input = controlInput(value, env, true),
    watch = requiredWatch(sql, projectId, id);
  if (watch.version !== input.expectedVersion)
    throw new ProjectEventValidationError('Standing watch version conflict');
  if (watch.state === 'revoked')
    throw new ProjectEventValidationError('Revoked standing watches cannot be resumed or paused');
  const state = input.paused ? 'paused' : 'active';
  if (state === watch.state) return mutation(watch, false, true);
  if (!input.paused && watch.executionCount >= watch.maxExecutions)
    throw new ProjectEventValidationError('Standing watch execution budget exhausted');
  const subscriptionId = input.paused
    ? watch.subscriptionId
    : subscribe(sql, env, watch, watch.version + 1);
  if (input.paused) cancelPending(sql, env, watch, now, input.reason);
  const changed = sql
    .exec(
      `UPDATE project_standing_watches SET state = ?, version = version + 1,
     subscription_id = ?, updated_at = ?, next_attempt_at = ?, last_error = ?
     WHERE project_id = ? AND id = ? AND version = ? RETURNING id`,
      state,
      subscriptionId,
      now,
      input.paused ? null : Math.max(now, watch.nextEligibleAt),
      input.reason,
      projectId,
      id,
      input.expectedVersion
    )
    .toArray();
  if (changed.length !== 1)
    throw new ProjectEventValidationError('Standing watch version conflict');
  return mutation(requiredWatch(sql, projectId, id), true);
}

export function revokeWatch(
  sql: SqlStorage,
  env: WatchEnv,
  projectId: string,
  id: string,
  value: unknown,
  now: number
): ProjectStandingWatchMutationResult {
  const input = controlInput(value, env, false),
    watch = requiredWatch(sql, projectId, id);
  if (
    watch.state === 'revoked' &&
    (input.expectedVersion === watch.version || input.expectedVersion === watch.version - 1)
  )
    return mutation(watch, false, true);
  if (watch.version !== input.expectedVersion)
    throw new ProjectEventValidationError('Standing watch version conflict');
  cancelPending(sql, env, watch, now, input.reason);
  const changed = sql
    .exec(
      `UPDATE project_standing_watches SET state = 'revoked', version = version + 1,
     updated_at = ?, next_attempt_at = NULL, last_error = ?
     WHERE project_id = ? AND id = ? AND version = ? RETURNING id`,
      now,
      input.reason,
      projectId,
      id,
      input.expectedVersion
    )
    .toArray();
  if (changed.length !== 1)
    throw new ProjectEventValidationError('Standing watch version conflict');
  return mutation(requiredWatch(sql, projectId, id), true);
}
