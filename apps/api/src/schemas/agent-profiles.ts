import * as v from 'valibot';

const GitHubCliPermissionLevelSchema = v.picklist(['none', 'read', 'write']);
const GitHubCliContentsPermissionLevelSchema = v.picklist(['read', 'write']);

const GitHubCliPolicySchema = v.object({
  mode: v.picklist(['inherit', 'custom']),
  repositoryScope: v.picklist(['project']),
  permissions: v.object({
    contents: GitHubCliContentsPermissionLevelSchema,
    pullRequests: GitHubCliPermissionLevelSchema,
    issues: GitHubCliPermissionLevelSchema,
    actions: GitHubCliPermissionLevelSchema,
    packages: GitHubCliPermissionLevelSchema,
  }),
});

export const CreateAgentProfileSchema = v.object({
  name: v.string(),
  description: v.optional(v.nullable(v.string())),
  agentType: v.optional(v.string()),
  model: v.optional(v.nullable(v.string())),
  permissionMode: v.optional(v.nullable(v.string())),
  systemPromptAppend: v.optional(v.nullable(v.string())),
  maxTurns: v.optional(v.nullable(v.number())),
  timeoutMinutes: v.optional(v.nullable(v.number())),
  vmSizeOverride: v.optional(v.nullable(v.string())),
  provider: v.optional(v.nullable(v.string())),
  vmLocation: v.optional(v.nullable(v.string())),
  workspaceProfile: v.optional(v.nullable(v.string())),
  devcontainerConfigName: v.optional(v.nullable(v.string())),
  taskMode: v.optional(v.nullable(v.string())),
  githubCliPolicy: v.optional(v.nullable(GitHubCliPolicySchema)),
});

export const UpdateAgentProfileSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
  agentType: v.optional(v.string()),
  model: v.optional(v.nullable(v.string())),
  permissionMode: v.optional(v.nullable(v.string())),
  systemPromptAppend: v.optional(v.nullable(v.string())),
  maxTurns: v.optional(v.nullable(v.number())),
  timeoutMinutes: v.optional(v.nullable(v.number())),
  vmSizeOverride: v.optional(v.nullable(v.string())),
  provider: v.optional(v.nullable(v.string())),
  vmLocation: v.optional(v.nullable(v.string())),
  workspaceProfile: v.optional(v.nullable(v.string())),
  devcontainerConfigName: v.optional(v.nullable(v.string())),
  taskMode: v.optional(v.nullable(v.string())),
  githubCliPolicy: v.optional(v.nullable(GitHubCliPolicySchema)),
});

export const SetProjectDefaultProfileSchema = v.object({
  profileNameOrId: v.optional(v.nullable(v.string())),
});
