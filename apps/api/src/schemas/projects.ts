import { VALID_PERMISSION_MODES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

const CredentialProviderSchema = v.picklist(['hetzner', 'scaleway', 'gcp']);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);
const WorkspaceProfileSchema = v.picklist(['full', 'lightweight']);

// Per-agent-type override (model + permission mode). Both fields are optional and nullable.
// Null = clear the override for that field; missing = leave unchanged.
const AgentDefaultEntrySchema = v.object({
  model: v.optional(v.nullable(v.string())),
  permissionMode: v.optional(v.nullable(v.picklist(VALID_PERMISSION_MODES))),
});

// Agent defaults: Record<agentType, { model?, permissionMode? }>.
// We accept any string key here; the PATCH route validates keys against AGENT_CATALOG.
const AgentDefaultsSchema = v.record(v.string(), AgentDefaultEntrySchema);

export const CreateProjectSchema = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  installationId: v.string(),
  repository: v.string(),
  githubRepoId: v.optional(v.number()),
  githubRepoNodeId: v.optional(v.string()),
  defaultBranch: v.string(),
});

export const UpdateProjectSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  defaultBranch: v.optional(v.string()),
  defaultVmSize: v.optional(v.nullable(VMSizeSchema)),
  defaultAgentType: v.optional(v.nullable(v.string())),
  defaultWorkspaceProfile: v.optional(v.nullable(WorkspaceProfileSchema)),
  defaultDevcontainerConfigName: v.optional(v.nullable(v.string())),
  defaultProvider: v.optional(v.nullable(CredentialProviderSchema)),
  defaultLocation: v.optional(v.nullable(v.string())),
  agentDefaults: v.optional(v.nullable(AgentDefaultsSchema)),
  workspaceIdleTimeoutMs: v.optional(v.nullable(v.number())),
  nodeIdleTimeoutMs: v.optional(v.nullable(v.number())),
  taskExecutionTimeoutMs: v.optional(v.nullable(v.number())),
  maxConcurrentTasks: v.optional(v.nullable(v.number())),
  maxDispatchDepth: v.optional(v.nullable(v.number())),
  maxSubTasksPerTask: v.optional(v.nullable(v.number())),
  warmNodeTimeoutMs: v.optional(v.nullable(v.number())),
  maxWorkspacesPerNode: v.optional(v.nullable(v.number())),
  nodeCpuThresholdPercent: v.optional(v.nullable(v.number())),
  nodeMemoryThresholdPercent: v.optional(v.nullable(v.number())),
});

export const UpsertProjectRuntimeEnvVarSchema = v.object({
  key: v.string(),
  value: v.string(),
  isSecret: v.optional(v.boolean()),
});

export const UpsertProjectRuntimeFileSchema = v.object({
  path: v.string(),
  content: v.string(),
  isSecret: v.optional(v.boolean()),
});
