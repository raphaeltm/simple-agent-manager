// =============================================================================
// Orchestration Types — Parent ↔ Child Agent Communication
// =============================================================================

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
