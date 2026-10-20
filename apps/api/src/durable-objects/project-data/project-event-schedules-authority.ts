import type { ProjectScheduledAction } from '@simple-agent-manager/shared';

import { WAKEABLE_TASK_STATUSES } from '../../services/task-status';
import { ProjectEventValidationError } from './project-events-contracts';
import {
  grantEndedReason,
  resolveSessionAccess,
  SENDER_ACCESS_ENDED_ERRORS,
} from './session-access-store';
import type { Env } from './types';

/** Stored creator identity is authority to recheck, never a saved bearer token. */
export async function requireScheduleMember(
  env: Env,
  projectId: string,
  userId: string,
  readOnly = false
): Promise<void> {
  const member = await env.DATABASE.prepare(
    `SELECT m.user_id FROM project_members m
    JOIN users u ON u.id = m.user_id
    JOIN projects p ON p.id = m.project_id
    WHERE m.project_id = ? AND m.user_id = ? AND m.status = 'active'
      AND u.status = 'active' AND (? = 1 OR m.role IN ('owner', 'admin', 'maintainer')) LIMIT 1`
  )
    .bind(projectId, userId, readOnly ? 1 : 0)
    .first();
  if (!member)
    throw new ProjectEventValidationError('Schedule creator no longer has project access');
}

export function requireScheduleTarget(sql: SqlStorage, sessionId: string): string {
  const target = sql
    .exec(`SELECT task_id, status FROM chat_sessions WHERE id = ? LIMIT 1`, sessionId)
    .toArray()[0];
  if (
    !target ||
    typeof target.task_id !== 'string' ||
    (target.status !== 'active' && target.status !== 'sleeping')
  ) {
    throw new ProjectEventValidationError(
      'Scheduled target session is no longer active or recoverable'
    );
  }
  return target.task_id;
}

/**
 * Which shared-access grant, if any, may stand in for owning the target chat (idea
 * 01M59MYE4GY91BWTE8TZF1ZB5D). A grant is given to a person for a few minutes, so only that
 * person acting directly may use it, and a schedule they made fires only under the grant it was
 * made with.
 */
export type ScheduleSharedAccess =
  /** An agent, SAM itself, or a standing watch: only the chat's owner may schedule into it. */
  | { kind: 'owner_only' }
  /** A person creating a schedule now, through the API: their active grant counts. */
  | { kind: 'person' }
  /** An existing schedule a teammate made: it still needs the grant it was made with. */
  | { kind: 'grant'; grantId: string };

export const OWNER_ONLY_SCHEDULE: ScheduleSharedAccess = { kind: 'owner_only' };

/**
 * Who is creating a schedule. Only a person may use a grant: an agent acts on its own user's
 * chats, never on a grant given to that user, and SAM schedules only into the chat it serves.
 */
export type ScheduleCreator = 'person' | 'agent' | 'system';

export function scheduleCreatorSharedAccess(creator: ScheduleCreator): ScheduleSharedAccess {
  return creator === 'person' ? { kind: 'person' } : OWNER_ONLY_SCHEDULE;
}

/** The authority for an existing schedule, from the grant it recorded when it was made. */
export function scheduleSharedAccess(grantId: string | null): ScheduleSharedAccess {
  return grantId ? { kind: 'grant', grantId } : OWNER_ONLY_SCHEDULE;
}

/** Who a scheduled message into a chat comes from, as `requireScheduleAction` resolved it. */
export interface ScheduleSessionWriter {
  role: 'owner' | 'grantee';
  ownerUserId: string;
  /** The grant a teammate's schedule uses; null for the owner. */
  grantId: string | null;
}

export interface ScheduleActionAuthority {
  targetTaskId: string;
  writer: ScheduleSessionWriter;
}

const NOT_A_SESSION_WRITER =
  'Only the chat owner, or someone it is shared with, can schedule messages into it';

/**
 * Only the chat's owner, or a teammate while the grant `sharedAccess` allows is active, may
 * schedule a message into it. `taskOwnerUserId` is the target task's owner, as the caller read
 * it from D1: a chat from before owners were recorded belongs to its task's owner
 * (.claude/rules/71), and no grant can exist on it.
 */
function requireScheduleSessionWriter(
  sql: SqlStorage,
  sessionId: string,
  userId: string,
  taskOwnerUserId: string | null,
  sharedAccess: ScheduleSharedAccess,
  now: number
): ScheduleSessionWriter {
  const access = resolveSessionAccess(sql, sessionId, userId, now);
  if (access.role === 'owner') return { role: 'owner', ownerUserId: userId, grantId: null };
  if (!access.ownerUserId) {
    if (access.found && taskOwnerUserId === userId) {
      return { role: 'owner', ownerUserId: userId, grantId: null };
    }
    throw new ProjectEventValidationError(NOT_A_SESSION_WRITER);
  }
  if (sharedAccess.kind === 'owner_only')
    throw new ProjectEventValidationError(NOT_A_SESSION_WRITER);
  if (sharedAccess.kind === 'grant') {
    // Only the grant it was made with: if their access ended and was given again, the new
    // grant does not revive the old schedule.
    const ended = grantEndedReason(sql, sessionId, userId, sharedAccess.grantId, now);
    if (ended) throw new ProjectEventValidationError(SENDER_ACCESS_ENDED_ERRORS[ended]);
    return { role: 'grantee', ownerUserId: access.ownerUserId, grantId: sharedAccess.grantId };
  }
  if (access.role !== 'grantee' || !access.grant) {
    throw new ProjectEventValidationError(NOT_A_SESSION_WRITER);
  }
  return { role: 'grantee', ownerUserId: access.ownerUserId, grantId: access.grant.id };
}

/**
 * Re-check a teammate's grant inside the transaction that acts on it: the async check above can
 * interleave with a revoke or an expiry.
 */
export function assertScheduleWriterStillActive(
  sql: SqlStorage,
  sessionId: string,
  userId: string,
  writer: ScheduleSessionWriter,
  now: number
): void {
  if (writer.role !== 'grantee' || !writer.grantId) return;
  const ended = grantEndedReason(sql, sessionId, userId, writer.grantId, now);
  if (ended) throw new ProjectEventValidationError(SENDER_ACCESS_ENDED_ERRORS[ended]);
}

export async function requireScheduleAction(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  userId: string,
  action: ProjectScheduledAction,
  sharedAccess: ScheduleSharedAccess
): Promise<ScheduleActionAuthority | null> {
  if (action.kind === 'start_session') {
    // The reserved submission adapter resolves current shared profile, skill,
    // credentials and placement at admission. Creator chat liveness is irrelevant.
    await requireScheduleMember(env, projectId, userId);
    return null;
  }
  const targetTaskId = requireScheduleTarget(sql, action.sessionId);
  // A sleeping VM task is a valid target: the scheduled message is what wakes it.
  const task = await env.DATABASE.prepare(
    `SELECT t.id, t.user_id FROM tasks t
    JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
    JOIN users u ON u.id = m.user_id
    WHERE t.id = ? AND t.project_id = ? AND t.chat_session_id = ?
      AND t.status IN (${WAKEABLE_TASK_STATUSES.map(() => '?').join(', ')})
      AND m.status = 'active' AND u.status = 'active'
      AND m.role IN ('owner','admin','maintainer') LIMIT 1`
  )
    .bind(userId, targetTaskId, projectId, action.sessionId, ...WAKEABLE_TASK_STATUSES)
    .first<{ id: string; user_id: string | null }>();
  if (!task)
    throw new ProjectEventValidationError(
      'Scheduled target or creator authority is no longer active'
    );
  // A cancellation or archive may land during either distributed read.
  if (requireScheduleTarget(sql, action.sessionId) !== targetTaskId) {
    throw new ProjectEventValidationError('Scheduled target task changed during admission');
  }
  const writer = requireScheduleSessionWriter(
    sql,
    action.sessionId,
    userId,
    task.user_id,
    sharedAccess,
    Date.now()
  );
  return { targetTaskId, writer };
}
