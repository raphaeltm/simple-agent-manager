import * as v from 'valibot';

const VMSizeSchema = v.picklist(['small', 'medium', 'large']);
const VMLocationSchema = v.string();
const WorkspaceProfileSchema = v.picklist(['full', 'lightweight']);
const CredentialProviderSchema = v.picklist(['hetzner', 'scaleway', 'gcp']);
const TaskModeSchema = v.picklist(['task', 'conversation']);
const TaskStatusSchema = v.picklist([
  'draft', 'ready', 'queued', 'delegated', 'in_progress', 'completed', 'failed', 'cancelled',
]);
const TaskExecutionStepSchema = v.picklist([
  'node_selection', 'node_provisioning', 'node_agent_ready', 'workspace_creation',
  'workspace_ready', 'attachment_transfer', 'agent_session', 'running', 'awaiting_followup',
]);

const GitPushResultSchema = v.object({
  pushed: v.boolean(),
  commitSha: v.nullable(v.string()),
  branchName: v.nullable(v.string()),
  prUrl: v.nullable(v.string()),
  prNumber: v.nullable(v.number()),
  hasUncommittedChanges: v.boolean(),
  error: v.nullable(v.string()),
});

const TaskAttachmentSchema = v.object({
  uploadId: v.string(),
  filename: v.string(),
  size: v.number(),
  contentType: v.string(),
});

/** Devcontainer config name — alphanumeric, hyphens, underscores, max 128 chars. */
const DevcontainerConfigNameSchema = v.pipe(
  v.string(),
  v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Config name must be alphanumeric with hyphens/underscores'),
  v.maxLength(128, 'Config name must be at most 128 characters'),
);

export const SubmitTaskSchema = v.object({
  message: v.string(),
  vmSize: v.optional(VMSizeSchema),
  vmLocation: v.optional(VMLocationSchema),
  nodeId: v.optional(v.string()),
  agentType: v.optional(v.string()),
  workspaceProfile: v.optional(WorkspaceProfileSchema),
  devcontainerConfigName: v.optional(v.nullable(DevcontainerConfigNameSchema)),
  provider: v.optional(CredentialProviderSchema),
  parentTaskId: v.optional(v.string()),
  contextSummary: v.optional(v.string()),
  taskMode: v.optional(TaskModeSchema),
  agentProfileId: v.optional(v.string()),
  attachments: v.optional(v.array(TaskAttachmentSchema)),
});

export const CreateTaskSchema = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  priority: v.optional(v.number()),
  parentTaskId: v.optional(v.string()),
  agentProfileHint: v.optional(v.string()),
});

export const UpdateTaskSchema = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  priority: v.optional(v.number()),
  parentTaskId: v.optional(v.nullable(v.string())),
});

export const UpdateTaskStatusSchema = v.object({
  toStatus: v.optional(TaskStatusSchema),
  executionStep: v.optional(TaskExecutionStepSchema),
  reason: v.optional(v.string()),
  outputSummary: v.optional(v.string()),
  outputBranch: v.optional(v.string()),
  outputPrUrl: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  gitPushResult: v.optional(GitPushResultSchema),
});

export const CreateTaskDependencySchema = v.object({
  dependsOnTaskId: v.string(),
});

export const DelegateTaskSchema = v.object({
  workspaceId: v.string(),
});

export const RunTaskSchema = v.object({
  vmSize: v.optional(VMSizeSchema),
  vmLocation: v.optional(VMLocationSchema),
  workspaceProfile: v.optional(WorkspaceProfileSchema),
  devcontainerConfigName: v.optional(v.nullable(DevcontainerConfigNameSchema)),
  nodeId: v.optional(v.string()),
  branch: v.optional(v.string()),
});

export const RequestAttachmentUploadSchema = v.object({
  filename: v.string(),
  size: v.number(),
  contentType: v.string(),
});
