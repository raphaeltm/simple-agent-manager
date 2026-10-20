import type { Env } from '../env';
import { getPlatformOperationLimits } from '../operations/limits';

const statuses = new Set([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]);
/** Called only after validating the authenticated, session-scoped VM response.
 * This is observation history, not a scheduler or promise of automatic completion tracking. */
export async function recordOperationalJob(
  env: Env,
  scope: {
    projectId: string;
    chatSessionId: string;
    userId: string;
    workspaceId: string;
    agentSessionId: string;
  },
  result: { jobId: string; status: string; exitCode: number }
) {
  if (!statuses.has(result.status) || !/^sx-[a-f0-9]{64}$/.test(result.jobId)) return;
  await env.DATABASE.prepare(
    `INSERT INTO operational_job_observations
    (project_id,chat_session_id,owner_user_id,job_id,workspace_id,agent_session_id,status,exit_code,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,chat_session_id,owner_user_id,job_id)
    DO UPDATE SET status=excluded.status,exit_code=excluded.exit_code,observed_at=excluded.observed_at
    WHERE operational_job_observations.status='running'`
  )
    .bind(
      scope.projectId,
      scope.chatSessionId,
      scope.userId,
      result.jobId,
      scope.workspaceId,
      scope.agentSessionId,
      result.status,
      result.status === 'running' ? null : result.exitCode,
      Date.now()
    )
    .run();
  await env.DATABASE.prepare(
    `DELETE FROM operational_job_observations
    WHERE project_id=? AND chat_session_id=? AND owner_user_id=? AND job_id NOT IN
      (SELECT job_id FROM operational_job_observations WHERE project_id=? AND chat_session_id=? AND owner_user_id=?
       ORDER BY observed_at DESC,job_id LIMIT ?)`
  )
    .bind(
      scope.projectId,
      scope.chatSessionId,
      scope.userId,
      scope.projectId,
      scope.chatSessionId,
      scope.userId,
      getPlatformOperationLimits(env).messageListMax
    )
    .run();
}
