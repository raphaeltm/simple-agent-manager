/**
 * Build a logged recovery-authority refusal from TaskRunner state. Separate from
 * `recovery-authority.ts` so `attempt-storage.ts` can use it without an import cycle
 * through `task-execution-authority.ts`.
 */
import {
  type SessionRecoveryAuthorityCheck,
  sessionRecoveryAuthorityRevoked,
  type SessionRecoveryAuthorityRevokedError,
} from '../../services/session-recovery-authority-revocation';
import type { StartTaskInput, TaskRunnerState } from './types';

export function revokeRecoveryAuthority(
  database: D1Database,
  input: StartTaskInput | TaskRunnerState,
  check: SessionRecoveryAuthorityCheck,
  site: string,
  persistedRecoveryAttemptId: string | null = null
): Promise<SessionRecoveryAuthorityRevokedError> {
  return sessionRecoveryAuthorityRevoked(database, {
    check,
    site,
    taskId: input.taskId,
    projectId: input.projectId,
    chatSessionId: input.config.resumeSnapshotChatSessionId ?? input.config.chatSessionId ?? null,
    recoveryAttemptId: input.config.recoveryAttemptId ?? null,
    sourceTaskId: input.config.recoverySourceTaskId ?? null,
    projectEventWake: input.config.projectEventWakeGuard ?? null,
    persistedRecoveryAttemptId,
  });
}
