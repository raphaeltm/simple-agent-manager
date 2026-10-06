import { log } from '../../lib/logger';
import type { ProjectDataSessionIdentityGuard } from '../../services/project-data';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export function projectDataGuardForReservedSubmission(
  state: TaskRunnerState,
  workspaceId?: string
): ProjectDataSessionIdentityGuard | null {
  const guard = state.config.startGuard;
  if (guard?.kind !== 'reserved_submission') return null;
  const sessionGuard: ProjectDataSessionIdentityGuard = {
    taskId: guard.taskId,
    createdByUserId: guard.userId,
  };
  if (workspaceId !== undefined) {
    sessionGuard.workspaceId = workspaceId;
  }
  return sessionGuard;
}

export async function canMutateProjectDataFailureSession(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  sessionId: string
): Promise<boolean> {
  const guard = state.config.startGuard;
  if (guard?.kind !== 'reserved_submission') return true;
  if (guard.chatSessionId !== sessionId) return false;

  try {
    const projectDataService = await import('../../services/project-data');
    const session = await projectDataService.getSession(rc.env, state.projectId, sessionId);
    const status = typeof session?.status === 'string' ? session.status : null;
    const taskId = typeof session?.taskId === 'string' ? session.taskId : null;
    const createdByUserId =
      typeof session?.createdByUserId === 'string' ? session.createdByUserId : null;
    const authorized =
      taskId === guard.taskId &&
      createdByUserId === guard.userId &&
      status !== 'stopped' &&
      status !== 'failed';
    if (!authorized) {
      log.info('task_runner_do.session_failure_mutation_skipped', {
        taskId: state.taskId,
        sessionId,
        status,
        reason: 'reserved_project_data_authority_revoked',
      });
    }
    return authorized;
  } catch (err) {
    log.warn('task_runner_do.session_failure_guard_read_failed', {
      taskId: state.taskId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
