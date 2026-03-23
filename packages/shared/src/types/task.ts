import type { VMSize, VMLocation, WorkspaceProfile } from './common';
import type { CredentialProvider } from './credential';

// =============================================================================
// Task
// =============================================================================

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'delegated'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskMode = 'task' | 'conversation';

/**
 * Tracks where the task runner is during async execution.
 * Persisted to the task record so stuck-task recovery knows WHERE execution stalled.
 */
export const TASK_EXECUTION_STEPS = [
  'node_selection',
  'node_provisioning',
  'node_agent_ready',
  'workspace_creation',
  'workspace_ready',
  'agent_session',
  'running',
  'awaiting_followup',
] as const;

export type TaskExecutionStep = (typeof TASK_EXECUTION_STEPS)[number];

export function isTaskExecutionStep(value: unknown): value is TaskExecutionStep {
  return typeof value === 'string' && (TASK_EXECUTION_STEPS as readonly string[]).includes(value);
}

/** Human-readable labels for each execution step (TDF-8). */
export const EXECUTION_STEP_LABELS: Record<TaskExecutionStep, string> = {
  node_selection: 'Finding a server...',
  node_provisioning: 'Setting up a new server...',
  node_agent_ready: 'Waiting for server to start...',
  workspace_creation: 'Creating workspace...',
  workspace_ready: 'Setting up development environment...',
  agent_session: 'Starting AI agent...',
  running: 'Agent is working...',
  awaiting_followup: 'Waiting for follow-up...',
};

/** Ordered index for execution step progress — derived from TASK_EXECUTION_STEPS array position (TDF-8). */
export const EXECUTION_STEP_ORDER = Object.fromEntries(
  TASK_EXECUTION_STEPS.map((step, i) => [step, i])
) as Record<TaskExecutionStep, number>;

export type TaskActorType = 'user' | 'system' | 'workspace_callback';

export type TaskSortOrder = 'createdAtDesc' | 'updatedAtDesc' | 'priorityDesc';

export interface Task {
  id: string;
  projectId: string;
  userId: string;
  parentTaskId: string | null;
  workspaceId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  priority: number;
  taskMode: TaskMode;
  dispatchDepth: number;
  agentProfileHint: string | null;
  blocked?: boolean;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface TaskStatusEvent {
  id: string;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  actorType: TaskActorType;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface TaskDetailResponse extends Task {
  dependencies: TaskDependency[];
  blocked: boolean;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: number;
  parentTaskId?: string;
  agentProfileHint?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  priority?: number;
  parentTaskId?: string | null;
}

export interface UpdateTaskStatusRequest {
  toStatus?: TaskStatus;
  executionStep?: TaskExecutionStep;
  reason?: string;
  outputSummary?: string;
  outputBranch?: string;
  outputPrUrl?: string;
  errorMessage?: string;
  gitPushResult?: GitPushResult;
}

export interface GitPushResult {
  pushed: boolean;
  commitSha: string | null;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  hasUncommittedChanges: boolean;
  error: string | null;
}

export interface SubmitTaskRequest {
  message: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  nodeId?: string;
  /** Agent type to use for the task (e.g., 'claude-code', 'openai-codex') */
  agentType?: string;
  /** Workspace provisioning profile. 'lightweight' skips devcontainer build for faster startup. */
  workspaceProfile?: WorkspaceProfile;
  /** Cloud provider to use for auto-provisioned nodes. Falls back to project default, then any available credential. */
  provider?: CredentialProvider;
  /** ID of a parent task to continue from (conversation forking). When set, the new workspace
   * checks out the parent task's output branch if available. */
  parentTaskId?: string;
  /** Context summary from the parent session. Persisted as the first system message in the new
   * chat session to give the agent context about prior work. Max 64KB. */
  contextSummary?: string;
  /** Task execution mode. 'task' (default): agent pushes, creates PR, calls complete_task.
   * 'conversation': agent responds conversationally, human controls lifecycle. */
  taskMode?: TaskMode;
}

/** Response from the session summarize endpoint. */
export interface SessionSummaryResponse {
  /** The generated context summary text. */
  summary: string;
  /** Total number of messages in the session. */
  messageCount: number;
  /** Number of messages after filtering (user + assistant only). */
  filteredCount: number;
  /** Method used to generate the summary. */
  method: 'ai' | 'heuristic' | 'verbatim';
}

export interface SubmitTaskResponse {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: 'queued';
}

export interface CreateTaskDependencyRequest {
  dependsOnTaskId: string;
}

export interface DelegateTaskRequest {
  workspaceId: string;
}

export interface RunTaskRequest {
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  workspaceProfile?: WorkspaceProfile;
  nodeId?: string;
  branch?: string;
}

export interface RunTaskResponse {
  taskId: string;
  status: TaskStatus;
  workspaceId: string | null;
  nodeId: string | null;
  autoProvisionedNode: boolean;
}

export interface ListTasksResponse {
  tasks: Task[];
  nextCursor?: string | null;
}

export interface ListTaskEventsResponse {
  events: TaskStatusEvent[];
}

// =============================================================================
// Dashboard
// =============================================================================

/** An active task enriched with project + session info for the dashboard grid. */
export interface DashboardTask {
  id: string;
  title: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  projectId: string;
  projectName: string;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  isActive: boolean;
}

export interface DashboardActiveTasksResponse {
  tasks: DashboardTask[];
}
