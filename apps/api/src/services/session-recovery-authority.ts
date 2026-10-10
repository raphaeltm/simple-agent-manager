import type { Env } from '../env';
import {
  sessionRecoveryAuthorityRevoked,
  type SessionRecoveryAuthorityRevokedError,
} from './session-recovery-authority-revocation';

const TERMINAL_TASK_STATUSES_SQL = "'completed', 'failed', 'cancelled'";
const LIVE_TASK_STATUSES_SQL = "'queued', 'delegated', 'in_progress', 'awaiting_followup'";

export interface ProjectEventWakeRecoveryGuard {
  batchId: string;
  subscriptionId: string;
}

export interface SessionRecoverySourceTaskGuard {
  taskId: string;
  projectId: string;
  chatSessionId: string;
  projectEventWake?: ProjectEventWakeRecoveryGuard | null;
  /** Pre-materialization event guard; after admission projectEventWake supplies this requirement. */
  requireSourceProjectMember?: boolean;
  requiredProjectMemberId?: string | null;
}

/** Event subscriptions retain source task identity, never a caller-supplied user identity. */
export function sourceProjectMemberAuthoritySql(): string {
  return `AND EXISTS (
    SELECT 1 FROM project_members event_member JOIN users event_user ON event_user.id = event_member.user_id
    WHERE event_member.project_id = source.project_id AND event_member.user_id = source.user_id
      AND event_member.status = 'active' AND event_user.status = 'active'
      AND event_member.role IN ('owner','admin','maintainer')
  )`;
}

export {
  type SessionRecoveryAuthorityCheck,
  SessionRecoveryAuthorityRevokedError,
} from './session-recovery-authority-revocation';

/**
 * Validate the parent authority used by durable prompt delivery immediately at
 * a runtime wake boundary. A live linked recovery task may temporarily own the
 * chat while the original parent remains the source of authority.
 */
export async function isSessionRecoverySourceTaskGuardValid(
  database: D1Database,
  guard: SessionRecoverySourceTaskGuard
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT source.id
         FROM tasks source
        WHERE source.id = ?
          AND source.project_id = ?
          AND (
            source.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
            OR (
              source.status = 'cancelled'
              AND source.superseded_by_task_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM tasks marked_successor
                 WHERE marked_successor.id = source.superseded_by_task_id
                   AND marked_successor.project_id = source.project_id
                   AND marked_successor.chat_session_id = ?
                   AND marked_successor.triggered_by = 'session-recovery'
                   AND marked_successor.status IN (${LIVE_TASK_STATUSES_SQL})
              )
            )
          )
          AND (
            source.chat_session_id = ?
            OR EXISTS (
              SELECT 1
                FROM tasks owner
               WHERE owner.recovery_source_task_id = source.id
                 AND owner.project_id = source.project_id
                 AND owner.chat_session_id = ?
                 AND owner.triggered_by = 'session-recovery'
                 AND owner.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
            )
          )
          ${
            guard.requireSourceProjectMember || guard.projectEventWake
              ? sourceProjectMemberAuthoritySql()
              : ''
          }
          ${
            guard.requiredProjectMemberId
              ? `AND EXISTS (
            SELECT 1 FROM project_members m JOIN users u ON u.id = m.user_id
            WHERE m.project_id = source.project_id AND m.user_id = ?
              AND m.status = 'active' AND u.status = 'active'
              AND m.role IN ('owner','admin','maintainer')
          )`
              : ''
          }
        LIMIT 1`
    )
    .bind(
      guard.taskId,
      guard.projectId,
      guard.chatSessionId,
      guard.chatSessionId,
      guard.chatSessionId,
      ...(guard.requiredProjectMemberId ? [guard.requiredProjectMemberId] : [])
    )
    .first<{ id: string }>();
  return Boolean(row);
}

/**
 * Validate a replacement TaskRunner against the exact snapshot claim and live
 * parent that authorized it. This check is repeated at start and before every
 * alarm-driven step so a stale runner cannot create resources after a retry or
 * parent terminal transition revoked its authority.
 */
export async function isSessionRecoveryTaskAuthorized(
  database: D1Database,
  input: {
    recoveryTaskId: string;
    recoveryAttemptId?: string | null;
    sourceTaskId: string;
    projectId: string;
    chatSessionId: string;
    requiredProjectMemberId?: string | null;
    projectEventWake?: ProjectEventWakeRecoveryGuard | null;
  }
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT recovery.id
         FROM tasks recovery
         JOIN tasks source
           ON source.id = ?
          AND (source.id = recovery.id OR source.id = recovery.recovery_source_task_id)
          AND source.project_id = recovery.project_id
         JOIN session_snapshots snapshot
           ON snapshot.chat_session_id = recovery.chat_session_id
          AND snapshot.project_id = recovery.project_id
          AND snapshot.recovery_task_id = recovery.id
        WHERE recovery.id = ?
          AND recovery.project_id = ?
          AND recovery.chat_session_id = ?
          AND (source.id = recovery.id OR recovery.triggered_by = 'session-recovery')
          AND recovery.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
          AND (? IS NULL OR snapshot.recovery_attempt_id = ?)
          AND (
            (recovery.status = 'in_progress' AND snapshot.recovery_status = 'restored')
            OR (
              snapshot.recovery_status IN ('waking', 'restored')
              AND (
                source.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
                OR (
                  source.status = 'cancelled'
                  AND source.superseded_by_task_id = recovery.id
                )
              )
            )
          )
          ${input.projectEventWake ? sourceProjectMemberAuthoritySql() : ''}
          ${
            input.requiredProjectMemberId
              ? `AND EXISTS (
            SELECT 1 FROM project_members m JOIN users u ON u.id = m.user_id
            WHERE m.project_id = recovery.project_id AND m.user_id = ?
              AND m.status = 'active' AND u.status = 'active'
              AND m.role IN ('owner','admin','maintainer')
          )`
              : ''
          }
        LIMIT 1`
    )
    .bind(
      input.sourceTaskId,
      input.recoveryTaskId,
      input.projectId,
      input.chatSessionId,
      input.recoveryAttemptId ?? null,
      input.recoveryAttemptId ?? null,
      ...(input.requiredProjectMemberId ? [input.requiredProjectMemberId] : [])
    )
    .first<{ id: string }>();
  return Boolean(row);
}

/** A stable task ID cannot distinguish old alarms from the current wake claim. */
export async function isSessionRecoveryAttemptCurrent(
  database: D1Database,
  input: { taskId: string; projectId: string; chatSessionId: string; recoveryAttemptId: string }
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT id FROM session_snapshots
      WHERE chat_session_id = ? AND project_id = ?
        AND recovery_task_id = ? AND recovery_attempt_id = ?
      LIMIT 1`
    )
    .bind(input.chatSessionId, input.projectId, input.taskId, input.recoveryAttemptId)
    .first<{ id: string }>();
  return Boolean(row);
}

export interface SessionRecoveryTaskAuthorityInput {
  recoveryAttemptId?: string | null;
  requiredProjectMemberId?: string | null;
  recoveryTaskId: string;
  sourceTaskId: string;
  projectId: string;
  chatSessionId: string;
  projectEventWake?: ProjectEventWakeRecoveryGuard | null;
}

export interface ProjectEventWakeAuthorityInput extends ProjectEventWakeRecoveryGuard {
  projectId: string;
  chatSessionId: string;
  sourceTaskId: string;
}

type ValidateProjectEventWakeAuthority = (
  input: ProjectEventWakeAuthorityInput
) => Promise<boolean>;

/**
 * Name the authority that refuses a replacement runner, or null when it may act.
 * A successful event RPC cannot preserve a D1 claim revoked while it awaited.
 */
export async function findSessionRecoveryTaskAndEventAuthorityFailure(
  database: D1Database,
  input: SessionRecoveryTaskAuthorityInput,
  validateEvent?: ValidateProjectEventWakeAuthority
): Promise<'recovery_task_authority' | 'project_event_wake_authority' | null> {
  if (!(await isSessionRecoveryTaskAuthorized(database, input))) return 'recovery_task_authority';
  if (!input.projectEventWake) return null;
  if (!validateEvent) return 'project_event_wake_authority';
  const eventAuthorized = await validateEvent({
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    sourceTaskId: input.sourceTaskId,
    batchId: input.projectEventWake.batchId,
    subscriptionId: input.projectEventWake.subscriptionId,
  });
  if (!eventAuthorized) return 'project_event_wake_authority';
  return (await isSessionRecoveryTaskAuthorized(database, input))
    ? null
    : 'recovery_task_authority';
}

/** Name the durable authority that refuses a container wake guard, or null when both hold. */
export async function findSessionRecoverySourceTaskGuardFailureForEnv(
  env: Env,
  guard: SessionRecoverySourceTaskGuard
): Promise<'source_task_guard' | 'project_event_wake_authority' | null> {
  if (!(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard))) {
    return 'source_task_guard';
  }
  if (!guard.projectEventWake) return null;
  const projectData = await import('./project-data');
  // Strict, unlike the TaskRunner's re-check: this guard rides the delivery request that
  // carries the wake prompt, and that inbox row is `delivering`, so a pull cannot consume the
  // batch first (`cancelQueuedWakeInboxBeforePull` only cancels queued or retrying rows).
  const eventAuthorized = await projectData.validateProjectEventWakeRecoveryAuthority(
    env,
    guard.projectId,
    {
      chatSessionId: guard.chatSessionId,
      sourceTaskId: guard.taskId,
      batchId: guard.projectEventWake.batchId,
      subscriptionId: guard.projectEventWake.subscriptionId,
    }
  );
  if (!eventAuthorized) return 'project_event_wake_authority';
  return (await isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard))
    ? null
    : 'source_task_guard';
}

/**
 * Check both durable authorities inside the container before starting or submitting. A refusal
 * is logged with its check and the snapshot claim, then returned for the caller to throw or answer.
 */
export async function findSessionRecoverySourceTaskGuardRefusal(
  env: Env,
  guard: SessionRecoverySourceTaskGuard,
  site: string
): Promise<SessionRecoveryAuthorityRevokedError | null> {
  const check = await findSessionRecoverySourceTaskGuardFailureForEnv(env, guard);
  if (!check) return null;
  return sessionRecoveryAuthorityRevoked(env.DATABASE, {
    check,
    site,
    taskId: guard.taskId,
    projectId: guard.projectId,
    chatSessionId: guard.chatSessionId,
    recoveryAttemptId: null,
    sourceTaskId: guard.taskId,
    projectEventWake: guard.projectEventWake ?? null,
  });
}

export {
  failAndRestoreSessionRecoveryHandoff,
  restoreSessionRecoveryHandoff,
} from './session-recovery-handoff';
