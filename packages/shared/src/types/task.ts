import type { CredentialProvider } from './user';
import type { VMLocation, VMSize, WorkspaceProfile } from './workspace';

// =============================================================================
// Task Types
// =============================================================================

export const TASK_STATUSES = [
  'draft',
  'ready',
  'queued',
  'delegated',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Runtime type guard for TaskStatus values from untrusted sources (e.g. database rows). */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

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
  'attachment_transfer',
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
  attachment_transfer: 'Uploading attachments to workspace...',
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
  /** What created this task: 'user' (manual), 'cron' (scheduled trigger), 'webhook', 'mcp'. */
  triggeredBy: string;
  /** ID of the trigger that created this task, if any. */
  triggerId: string | null;
  /** ID of the specific trigger execution, if any. */
  triggerExecutionId: string | null;
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

/** Trigger info embedded in task detail response when task was trigger-spawned. */
export interface TaskTriggerInfo {
  id: string;
  name: string;
  cronExpression: string | null;
  cronTimezone: string;
  cronHumanReadable?: string;
}

/** Trigger execution info embedded in task detail response. */
export interface TaskTriggerExecutionInfo {
  id: string;
  sequenceNumber: number;
  scheduledAt: string;
}

export interface TaskDetailResponse extends Task {
  dependencies: TaskDependency[];
  blocked: boolean;
  /** Trigger that created this task (populated when triggerId is set). */
  trigger?: TaskTriggerInfo;
  /** Specific trigger execution (populated when triggerExecutionId is set). */
  triggerExecution?: TaskTriggerExecutionInfo;
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

// =============================================================================
// Task Attachments (R2 presigned uploads)
// =============================================================================

/** Metadata for a file attachment uploaded to R2 before task submission. */
export interface TaskAttachment {
  /** Unique upload ID (ULID) generated by the request-upload endpoint. */
  uploadId: string;
  /** Original filename (safe characters only). */
  filename: string;
  /** File size in bytes (validated against R2 HEAD on submit). */
  size: number;
  /** MIME content type. */
  contentType: string;
}

/** Request to generate a presigned R2 upload URL for a task attachment. */
export interface RequestAttachmentUploadRequest {
  filename: string;
  size: number;
  contentType: string;
}

/** Response containing the presigned upload URL and metadata. */
export interface RequestAttachmentUploadResponse {
  uploadId: string;
  uploadUrl: string;
  expiresIn: number;
}

/** Default attachment size/count limits — all overridable via env vars. */
export const ATTACHMENT_DEFAULTS = {
  /** Maximum file size per attachment in bytes (default: 50MB). Env: ATTACHMENT_UPLOAD_MAX_BYTES */
  UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
  /** Maximum total batch size in bytes (default: 200MB). Env: ATTACHMENT_UPLOAD_BATCH_MAX_BYTES */
  UPLOAD_BATCH_MAX_BYTES: 200 * 1024 * 1024,
  /** Maximum number of files per task (default: 20). Env: ATTACHMENT_MAX_FILES */
  MAX_FILES: 20,
  /** Presigned URL expiry in seconds (default: 900 = 15min). Env: ATTACHMENT_PRESIGN_EXPIRY_SECONDS */
  PRESIGN_EXPIRY_SECONDS: 900,
} as const;

/** Regex for safe filenames — matches the VM agent pattern. */
export const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9._\- ]+$/;

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
  /** ID of an agent profile to use for this task. Profile settings override project defaults
   * but are overridden by explicit task-level fields. */
  agentProfileId?: string;
  /** File attachments uploaded to R2 via presigned URLs (validated on submit). */
  attachments?: TaskAttachment[];
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
