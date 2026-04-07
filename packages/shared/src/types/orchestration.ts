/**
 * Shared types for orchestration MCP tools (agent-to-agent communication).
 */

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

// ─── send_message_to_subtask ────────────────────────────────────────────────

/** Request to send a message to a child task's running agent session. */
export interface SendMessageToSubtaskRequest {
  taskId: string;
  message: string;
}

/** Response from sending a message to a child task. */
export interface SendMessageToSubtaskResponse {
  delivered: boolean;
  reason?: string;
}

// ─── stop_subtask ───────────────────────────────────────────────────────────

/** Request to stop a child task's agent session. */
export interface StopSubtaskRequest {
  taskId: string;
  reason?: string;
}

/** Response from stopping a child task. */
export interface StopSubtaskResponse {
  stopped: boolean;
  taskId: string;
}
