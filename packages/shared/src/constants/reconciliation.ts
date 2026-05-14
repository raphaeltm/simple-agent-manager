/**
 * Task reconciliation constants — configurable via env vars with defaults.
 *
 * When a task-mode agent goes silent (no messages, tool calls, status updates,
 * or mailbox progress), SAM sends a visible check-in prompt. If the agent
 * does not respond within the deadline, the task is failed and cleaned up.
 */

/** How long a task-mode session must be idle before SAM sends a check-in (ms). */
export const DEFAULT_TASK_RECONCILIATION_IDLE_MS = 5 * 60 * 1000; // 5 minutes

/** How long the agent has to respond after the SAM check-in before the task is failed (ms). */
export const DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS = 60 * 1000; // 1 minute
