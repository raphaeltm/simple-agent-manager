/** Trusted operation labels attached without modifying the original error. */
export type TaskSubmitOperation =
  | 'route_project_authorization'
  | 'project_authorization'
  | 'repository_authorization'
  | 'attachment_validation'
  | 'parent_task_lookup'
  | 'ancestor_task_lookup'
  | 'preferred_node_lookup'
  | 'source_idea_validation'
  | 'profile_resolution'
  | 'runtime_resolution'
  | 'instant_submission'
  | 'placement_credentials'
  | 'compute_quota'
  | 'mention_enrichment'
  | 'task_insert'
  | 'task_status_event_insert'
  | 'session_create'
  | 'task_session_link'
  | 'context_summary_persist'
  | 'initial_message_persist'
  | 'source_idea_link'
  | 'session_failure_task_update'
  | 'runner_user_lookup'
  | 'runner_start'
  | 'runner_failure_task_update';

const operations = new WeakMap<Error, TaskSubmitOperation>();

export function markTaskSubmitOperation(error: unknown, operation: TaskSubmitOperation): void {
  if (error instanceof Error && !operations.has(error)) operations.set(error, operation);
}

export function getTaskSubmitOperation(error: unknown): TaskSubmitOperation | undefined {
  return error instanceof Error ? operations.get(error) : undefined;
}
