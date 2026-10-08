import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Only a first human conversation start bypasses the unrelated build queue. */
export async function isUserConversationStart(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  if (state.config.taskMode !== 'conversation' || state.config.resumeSnapshotChatSessionId)
    return false;
  const task = await rc.env.DATABASE.prepare(
    "SELECT id FROM tasks WHERE id = ? AND project_id = ? AND user_id = ? AND task_mode = 'conversation' AND triggered_by = 'user'"
  )
    .bind(state.taskId, state.projectId, state.userId)
    .first<{ id: string }>();
  return task !== null;
}
