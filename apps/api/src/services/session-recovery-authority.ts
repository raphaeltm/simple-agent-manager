import type { Env } from '../env';

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

export class SessionRecoveryAuthorityRevokedError extends Error {
  readonly permanent = true;

  constructor() {
    super('Session recovery authority was revoked');
    this.name = 'SessionRecoveryAuthorityRevokedError';
  }
}

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

/** A successful event RPC cannot preserve a D1 claim revoked while it awaited. */
export async function isSessionRecoveryTaskAndEventAuthorized(
  database: D1Database,
  input: SessionRecoveryTaskAuthorityInput,
  validateEvent?: ValidateProjectEventWakeAuthority
): Promise<boolean> {
  if (!(await isSessionRecoveryTaskAuthorized(database, input))) return false;
  if (!input.projectEventWake) return true;
  if (!validateEvent) return false;
  const eventAuthorized = await validateEvent({
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    sourceTaskId: input.sourceTaskId,
    batchId: input.projectEventWake.batchId,
    subscriptionId: input.projectEventWake.subscriptionId,
  });
  if (!eventAuthorized) return false;
  return isSessionRecoveryTaskAuthorized(database, input);
}

/** Check both durable authorities inside the container before starting or submitting. */
export async function isSessionRecoverySourceTaskGuardFullyValidForEnv(
  env: Env,
  guard: SessionRecoverySourceTaskGuard
): Promise<boolean> {
  if (!(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard))) return false;
  if (!guard.projectEventWake) return true;
  const projectData = await import('./project-data');
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
  if (!eventAuthorized) return false;
  return isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard);
}

export {
  failAndRestoreSessionRecoveryHandoff,
  restoreSessionRecoveryHandoff,
} from './session-recovery-handoff';
