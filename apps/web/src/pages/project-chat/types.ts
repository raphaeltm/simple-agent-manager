import type { TaskExecutionStep, TaskStatus } from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to poll task status during provisioning (ms). */
export const TASK_STATUS_POLL_MS = 2000;
/** Max sessions to load in the sidebar. Override via VITE_CHAT_SESSION_LIST_LIMIT. */
const DEFAULT_CHAT_SESSION_LIST_LIMIT = 100;
export const CHAT_SESSION_LIST_LIMIT = parseInt(
  import.meta.env.VITE_CHAT_SESSION_LIST_LIMIT || String(DEFAULT_CHAT_SESSION_LIST_LIMIT),
);

/** Prompt template for executing an idea. Override via VITE_EXECUTE_IDEA_PROMPT_TEMPLATE. Use {ideaId} placeholder. */
const DEFAULT_EXECUTE_IDEA_PROMPT_TEMPLATE =
  'Read idea {ideaId} using the get_idea tool for full context, then execute it using the /do skill.';
export const EXECUTE_IDEA_PROMPT_TEMPLATE =
  import.meta.env.VITE_EXECUTE_IDEA_PROMPT_TEMPLATE || DEFAULT_EXECUTE_IDEA_PROMPT_TEMPLATE;

/** Max tasks to load for idea tagging. Override via VITE_CHAT_TASK_LIST_LIMIT. */
const DEFAULT_CHAT_TASK_LIST_LIMIT = 200;
export const CHAT_TASK_LIST_LIMIT = parseInt(
  import.meta.env.VITE_CHAT_TASK_LIST_LIMIT || String(DEFAULT_CHAT_TASK_LIST_LIMIT),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisioningState {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  errorMessage: string | null;
  startedAt: number;
  workspaceId: string | null;
  workspaceUrl: string | null;
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
