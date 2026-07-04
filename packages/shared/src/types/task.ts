import type { ResourceRequirements, ResourceRequirementsSource } from './resource';
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

export const TASK_MODES = ['task', 'conversation'] as const;

export type TaskMode = (typeof TASK_MODES)[number];

/** Runtime type guard for TaskMode values from untrusted sources (e.g. database rows). */
export function isTaskMode(value: unknown): value is TaskMode {
  return typeof value === 'string' && (TASK_MODES as readonly string[]).includes(value);
}

/**
 * Tracks where the task runner is during async execution.
 * Persisted to the task record so stuck-task recovery knows WHERE execution stalled.
 */
export const TASK_EXECUTION_STEPS = [
  'node_selection',
  'node_provisioning',
  'node_agent_ready',
  'workspace_creation',
  'workspace_dispatch',
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
  workspace_dispatch: 'Starting workspace on server...',
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

export const COMPLETION_EVIDENCE_VERIFICATION_KINDS = [
  'test',
  'staging',
  'manual',
  'ci',
  'other',
] as const;

export type CompletionEvidenceVerificationKind =
  (typeof COMPLETION_EVIDENCE_VERIFICATION_KINDS)[number];

export interface CompletionTestRun {
  command: string;
  passed: boolean;
  detail?: string;
}

export interface CompletionVerification {
  kind: CompletionEvidenceVerificationKind;
  description: string;
  evidence?: string;
}

export interface CompletionEvidence {
  testsRun?: CompletionTestRun[];
  verifications?: CompletionVerification[];
  prUrl?: string;
  notes?: string;
}

const COMPLETION_EVIDENCE_LIMITS = {
  maxTestsRun: 25,
  maxVerifications: 25,
  maxCommandLength: 500,
  maxDetailLength: 2000,
  maxDescriptionLength: 2000,
  maxEvidenceLength: 2000,
  maxPrUrlLength: 500,
  maxNotesLength: 4000,
} as const;

type CompletionEvidenceValidationResult =
  | { ok: true; value: CompletionEvidence }
  | { ok: false; error: string };

type OptionalStringValidationResult =
  | { ok: true; value?: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maxLength: number
): OptionalStringValidationResult {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `${field} must not be empty` };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, error: `${field} must be ${maxLength} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

function validateEvidenceArray<T>(
  value: unknown,
  field: string,
  maxItems: number,
  parseItem: (item: Record<string, unknown>, index: number) => { ok: true; value: T } | { ok: false; error: string }
): { ok: true; value: T[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field} must be an array` };
  }
  if (value.length > maxItems) {
    return { ok: false, error: `${field} must contain ${maxItems} items or fewer` };
  }

  const parsed: T[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return { ok: false, error: `${field}[${index}] must be an object` };
    }
    const result = parseItem(item, index);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  return { ok: true, value: parsed };
}

function requiredEvidenceString(
  value: unknown,
  field: string,
  maxLength: number
): { ok: true; value: string } | { ok: false; error: string } {
  const result = optionalTrimmedString(value, field, maxLength);
  if (!result.ok) return result;
  if (!result.value) {
    return { ok: false, error: `${field} must not be empty` };
  }
  return { ok: true, value: result.value };
}

function validateCompletionTestRun(
  item: Record<string, unknown>,
  index: number
): { ok: true; value: CompletionTestRun } | { ok: false; error: string } {
  const command = requiredEvidenceString(
    item.command,
    `evidence.testsRun[${index}].command`,
    COMPLETION_EVIDENCE_LIMITS.maxCommandLength
  );
  if (!command.ok) return command;

  if (typeof item.passed !== 'boolean') {
    return { ok: false, error: `evidence.testsRun[${index}].passed must be a boolean` };
  }

  const detail = optionalTrimmedString(
    item.detail,
    `evidence.testsRun[${index}].detail`,
    COMPLETION_EVIDENCE_LIMITS.maxDetailLength
  );
  if (!detail.ok) return detail;

  return {
    ok: true,
    value: {
      command: command.value,
      passed: item.passed,
      ...(detail.value ? { detail: detail.value } : {}),
    },
  };
}

function validateCompletionVerification(
  item: Record<string, unknown>,
  index: number
): { ok: true; value: CompletionVerification } | { ok: false; error: string } {
  if (
    typeof item.kind !== 'string' ||
    !(COMPLETION_EVIDENCE_VERIFICATION_KINDS as readonly string[]).includes(item.kind)
  ) {
    return {
      ok: false,
      error: `evidence.verifications[${index}].kind must be one of: ${COMPLETION_EVIDENCE_VERIFICATION_KINDS.join(', ')}`,
    };
  }

  const description = requiredEvidenceString(
    item.description,
    `evidence.verifications[${index}].description`,
    COMPLETION_EVIDENCE_LIMITS.maxDescriptionLength
  );
  if (!description.ok) return description;

  const evidence = optionalTrimmedString(
    item.evidence,
    `evidence.verifications[${index}].evidence`,
    COMPLETION_EVIDENCE_LIMITS.maxEvidenceLength
  );
  if (!evidence.ok) return evidence;

  return {
    ok: true,
    value: {
      kind: item.kind as CompletionEvidenceVerificationKind,
      description: description.value,
      ...(evidence.value ? { evidence: evidence.value } : {}),
    },
  };
}

export function validateCompletionEvidence(value: unknown): CompletionEvidenceValidationResult {
  if (!isRecord(value)) {
    return { ok: false, error: 'evidence must be an object' };
  }

  const output: CompletionEvidence = {};
  let populatedFields = 0;

  if (value.testsRun !== undefined) {
    const testsRun = validateEvidenceArray(
      value.testsRun,
      'evidence.testsRun',
      COMPLETION_EVIDENCE_LIMITS.maxTestsRun,
      validateCompletionTestRun
    );
    if (!testsRun.ok) return testsRun;
    output.testsRun = testsRun.value;
    populatedFields += 1;
  }

  if (value.verifications !== undefined) {
    const verifications = validateEvidenceArray(
      value.verifications,
      'evidence.verifications',
      COMPLETION_EVIDENCE_LIMITS.maxVerifications,
      validateCompletionVerification
    );
    if (!verifications.ok) return verifications;
    output.verifications = verifications.value;
    populatedFields += 1;
  }

  const prUrl = optionalTrimmedString(
    value.prUrl,
    'evidence.prUrl',
    COMPLETION_EVIDENCE_LIMITS.maxPrUrlLength
  );
  if (!prUrl.ok) return prUrl;
  if (prUrl.value) {
    output.prUrl = prUrl.value;
    populatedFields += 1;
  }

  const notes = optionalTrimmedString(
    value.notes,
    'evidence.notes',
    COMPLETION_EVIDENCE_LIMITS.maxNotesLength
  );
  if (!notes.ok) return notes;
  if (notes.value) {
    output.notes = notes.value;
    populatedFields += 1;
  }

  if (populatedFields === 0) {
    return { ok: false, error: 'evidence must include at least one supported field' };
  }

  return { ok: true, value: output };
}

export function parseCompletionEvidenceJson(raw: string | null): CompletionEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const validation = validateCompletionEvidence(parsed);
    return validation.ok ? validation.value : null;
  } catch {
    return null;
  }
}

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
  /** Resolved skill applied to this task, if any. */
  skillId: string | null;
  /** Raw skill name/id the submitter requested (pre-resolution). */
  skillHint: string | null;
  blocked?: boolean;
  /** What created this task: 'user' (manual), 'cron' (scheduled trigger), 'webhook', 'mcp'. */
  triggeredBy: string;
  /** ID of the trigger that created this task, if any. */
  triggerId: string | null;
  /** ID of the specific trigger execution, if any. */
  triggerExecutionId: string | null;
  /** Resolved VM size for audit. */
  requestedVmSize: string | null;
  /** Where the VM size came from in the precedence chain. */
  requestedVmSizeSource: ResourceRequirementsSource | 'explicit' | null;
  /** VM size actually provisioned. Differs from requestedVmSize only when
   *  size-fallback descended on transient capacity exhaustion. Null otherwise. */
  provisionedVmSize: string | null;
  /** JSON snapshot of the resolved ResourceRequirements. */
  resourceRequirementsJson: string | null;
  /** Which precedence level provided the resource requirements. */
  resourceRequirementsSource: ResourceRequirementsSource | null;
  /** JSON snapshot of the ResolvedResourceReservation. */
  resolvedReservationJson: string | null;
  /** JSON snapshot of the PlacementExplanation. */
  placementExplanationJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  completionEvidence: CompletionEvidence | null;
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
  /** Devcontainer config name (subdirectory under .devcontainer/). null/undefined = auto-discover default.
   * Only relevant when workspaceProfile is 'full' — ignored for 'lightweight' (devcontainer build skipped). */
  devcontainerConfigName?: string | null;
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
  /** Explicit resource requirements for this task. Overrides profile/project/platform defaults. */
  resourceRequirements?: ResourceRequirements;
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
