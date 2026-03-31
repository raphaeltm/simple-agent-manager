import * as v from 'valibot';

const CredentialProviderSchema = v.picklist(['hetzner', 'scaleway', 'gcp']);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);
const CredentialKindSchema = v.picklist(['api-key', 'oauth-token']);

export const CreateWorkspaceSchema = v.object({
  name: v.string(),
  projectId: v.string(),
  nodeId: v.optional(v.string()),
  repository: v.optional(v.string()),
  branch: v.optional(v.string()),
  vmSize: v.optional(VMSizeSchema),
  vmLocation: v.optional(v.string()),
  installationId: v.optional(v.string()),
  provider: v.optional(CredentialProviderSchema),
});

export const UpdateWorkspaceSchema = v.object({
  displayName: v.string(),
});

export const CreateAgentSessionSchema = v.object({
  label: v.optional(v.string()),
  agentType: v.optional(v.string()),
  worktreePath: v.optional(v.string()),
});

export const UpdateAgentSessionSchema = v.object({
  label: v.string(),
});

// Workspace runtime schemas
export const AgentTypeBodySchema = v.object({
  agentType: v.string(),
});

export const CredentialInjectionSchema = v.object({
  credential: v.string(),
  credentialKind: CredentialKindSchema,
  agentType: v.optional(v.string()),
});

export const BootLogEntrySchema = v.object({
  step: v.string(),
  status: v.picklist(['started', 'completed', 'failed']),
  message: v.string(),
  detail: v.optional(v.string()),
  timestamp: v.string(),
});

export const AgentCredentialSyncSchema = v.object({
  credential: v.string(),
  credentialKind: v.optional(CredentialKindSchema),
});

// Workspace lifecycle schemas
export const WorkspaceStatusUpdateSchema = v.object({
  status: v.optional(v.string()),
});

export const WorkspaceErrorSchema = v.object({
  errorMessage: v.optional(v.string()),
});
