/**
 * Shared types for orchestration MCP tools (agent-to-agent communication).
 */

// ─── send_message_to_subtask ────────────────────────────────────────────────

export interface SendMessageToSubtaskRequest {
  taskId: string;
  message: string;
}

export interface SendMessageToSubtaskResponse {
  delivered: boolean;
  reason?: 'agent_busy';
}

// ─── stop_subtask ───────────────────────────────────────────────────────────

export interface StopSubtaskRequest {
  taskId: string;
  reason?: string;
}

export interface StopSubtaskResponse {
  stopped: boolean;
  taskId: string;
}

// ─── retry_subtask ──────────────────────────────────────────────────────────

export interface RetrySubtaskRequest {
  taskId: string;
  newDescription?: string;
}

export interface RetrySubtaskResponse {
  stoppedTaskId: string;
  newTaskId: string;
  newSessionId: string;
  newBranch: string;
}

// ─── add_dependency ─────────────────────────────────────────────────────────

export interface AddDependencyRequest {
  taskId: string;
  dependsOnTaskId: string;
}

export interface AddDependencyResponse {
  added: boolean;
}

// ─── remove_pending_subtask ─────────────────────────────────────────────────

export interface RemovePendingSubtaskRequest {
  taskId: string;
}

export interface RemovePendingSubtaskResponse {
  removed: boolean;
  taskId: string;
}
