/**
 * Diagnosable refusals of snapshot-recovery authority.
 *
 * Every `SessionRecoveryAuthorityRevokedError` names the check that refused it, and
 * `sessionRecoveryAuthorityRevoked` logs that check with the snapshot claim as it
 * reads at refusal time. Before this, every throw site produced the same message,
 * so a production failure could not say which predicate fired (idea
 * 01M4JMYRY5909JYND1XRXMM9DC). The message itself stays stable: task status events
 * and wake notices quote it.
 */
import { log } from '../lib/logger';

export type SessionRecoveryAuthorityCheck =
  /** The snapshot claim no longer names this task and wake attempt (`isSessionRecoveryAttemptCurrent`). */
  | 'recovery_attempt_not_current'
  /** This runner's own storage already belongs to a newer wake attempt. */
  | 'runner_attempt_superseded'
  /** A wake that is identified by its snapshot chat session has none. */
  | 'recovery_chat_session_missing'
  /** `isSessionRecoveryTaskAuthorized` refused: claim status, task or source status, or membership. */
  | 'recovery_task_authority'
  /** ProjectData refused the project-event wake (`validateProjectEventWakeRecoveryAuthority`). */
  | 'project_event_wake_authority'
  /** The guarded wake's source task no longer authorizes it (`isSessionRecoverySourceTaskGuardValid`). */
  | 'source_task_guard';

export class SessionRecoveryAuthorityRevokedError extends Error {
  readonly permanent = true;
  readonly check: SessionRecoveryAuthorityCheck;

  constructor(check: SessionRecoveryAuthorityCheck) {
    super('Session recovery authority was revoked');
    this.name = 'SessionRecoveryAuthorityRevokedError';
    this.check = check;
  }
}

export interface SessionRecoveryAuthorityRevocation {
  check: SessionRecoveryAuthorityCheck;
  /** Where the refusal happened, for example `task_runner.assert_recovery_authority`. */
  site: string;
  taskId: string;
  projectId: string;
  chatSessionId: string | null;
  recoveryAttemptId: string | null;
  sourceTaskId?: string | null;
  /** The newer attempt this runner's storage already holds (`runner_attempt_superseded`). */
  persistedRecoveryAttemptId?: string | null;
  projectEventWake?: { batchId: string; subscriptionId: string } | null;
}

interface SnapshotClaimRow {
  recovery_task_id: string | null;
  recovery_attempt_id: string | null;
  recovery_status: string | null;
  capture_generation: string | null;
  sleep_status: string | null;
}

async function readSnapshotClaim(
  database: D1Database,
  projectId: string,
  chatSessionId: string
): Promise<{ row: SnapshotClaimRow | null; error: string | null }> {
  try {
    const row = await database
      .prepare(
        `SELECT recovery_task_id, recovery_attempt_id, recovery_status, capture_generation,
                sleep_status
           FROM session_snapshots
          WHERE chat_session_id = ? AND project_id = ?
          LIMIT 1`
      )
      .bind(chatSessionId, projectId)
      .first<SnapshotClaimRow>();
    return { row: row ?? null, error: null };
  } catch (error) {
    return { row: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Log a refusal with the snapshot claim it read, then return the error for the caller
 * to throw. The read is best-effort: its failure is logged, never thrown in place of
 * the refusal. Every field is an identifier or a lifecycle state; no tokens, prompts
 * or credentials.
 */
export async function sessionRecoveryAuthorityRevoked(
  database: D1Database,
  revocation: SessionRecoveryAuthorityRevocation
): Promise<SessionRecoveryAuthorityRevokedError> {
  const snapshot = revocation.chatSessionId
    ? await readSnapshotClaim(database, revocation.projectId, revocation.chatSessionId)
    : { row: null, error: null };
  log.warn('session_recovery.authority_revoked', {
    check: revocation.check,
    site: revocation.site,
    taskId: revocation.taskId,
    projectId: revocation.projectId,
    chatSessionId: revocation.chatSessionId,
    recoveryAttemptId: revocation.recoveryAttemptId,
    sourceTaskId: revocation.sourceTaskId ?? null,
    persistedRecoveryAttemptId: revocation.persistedRecoveryAttemptId ?? null,
    projectEventBatchId: revocation.projectEventWake?.batchId ?? null,
    projectEventSubscriptionId: revocation.projectEventWake?.subscriptionId ?? null,
    snapshotFound: snapshot.row !== null,
    snapshotRecoveryTaskId: snapshot.row?.recovery_task_id ?? null,
    snapshotRecoveryAttemptId: snapshot.row?.recovery_attempt_id ?? null,
    snapshotRecoveryStatus: snapshot.row?.recovery_status ?? null,
    snapshotCaptureGeneration: snapshot.row?.capture_generation ?? null,
    snapshotSleepStatus: snapshot.row?.sleep_status ?? null,
    snapshotReadError: snapshot.error,
  });
  return new SessionRecoveryAuthorityRevokedError(revocation.check);
}
