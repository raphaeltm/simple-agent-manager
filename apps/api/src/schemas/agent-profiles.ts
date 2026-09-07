import { AGENT_EFFORT_LEVELS, AGENT_PROFILE_RUNTIMES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

const GitHubCliPermissionLevelSchema = v.picklist(['none', 'read', 'write']);
const GitHubCliContentsPermissionLevelSchema = v.picklist(['read', 'write']);
const AgentEffortSchema = v.picklist([...AGENT_EFFORT_LEVELS]);
const AgentProfileRuntimeSchema = v.picklist([...AGENT_PROFILE_RUNTIMES]);

const ResourceRequirementsSchema = v.object({
  minVcpu: v.optional(v.pipe(v.number(), v.minValue(0))),
  minMemoryGb: v.optional(v.pipe(v.number(), v.minValue(0))),
  minDiskGb: v.optional(v.pipe(v.number(), v.minValue(0))),
  exclusiveNode: v.optional(v.boolean()),
  maxCoTenants: v.optional(v.pipe(v.number(), v.minValue(0))),
});

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
  effort: v.optional(v.nullable(AgentEffortSchema)),
  permissionMode: v.optional(v.nullable(v.string())),
  systemPromptAppend: v.optional(v.nullable(v.string())),
  maxTurns: v.optional(v.nullable(v.number())),
  timeoutMinutes: v.optional(v.nullable(v.number())),
  vmSizeOverride: v.optional(v.nullable(v.string())),
  resourceRequirements: v.optional(v.nullable(ResourceRequirementsSchema)),
  resourceRequirementsJson: v.optional(v.nullable(v.string())),
  provider: v.optional(v.nullable(v.string())),
  vmLocation: v.optional(v.nullable(v.string())),
  workspaceProfile: v.optional(v.nullable(v.string())),
  runtime: v.optional(v.nullable(AgentProfileRuntimeSchema)),
  devcontainerConfigName: v.optional(v.nullable(v.string())),
  taskMode: v.optional(v.nullable(v.string())),
  githubCliPolicy: v.optional(v.nullable(GitHubCliPolicySchema)),
});

export const UpdateAgentProfileSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
  agentType: v.optional(v.string()),
  model: v.optional(v.nullable(v.string())),
  effort: v.optional(v.nullable(AgentEffortSchema)),
  permissionMode: v.optional(v.nullable(v.string())),
  systemPromptAppend: v.optional(v.nullable(v.string())),
  maxTurns: v.optional(v.nullable(v.number())),
  timeoutMinutes: v.optional(v.nullable(v.number())),
  vmSizeOverride: v.optional(v.nullable(v.string())),
  resourceRequirements: v.optional(v.nullable(ResourceRequirementsSchema)),
  resourceRequirementsJson: v.optional(v.nullable(v.string())),
  provider: v.optional(v.nullable(v.string())),
  vmLocation: v.optional(v.nullable(v.string())),
  workspaceProfile: v.optional(v.nullable(v.string())),
  runtime: v.optional(v.nullable(AgentProfileRuntimeSchema)),
  devcontainerConfigName: v.optional(v.nullable(v.string())),
  taskMode: v.optional(v.nullable(v.string())),
  githubCliPolicy: v.optional(v.nullable(GitHubCliPolicySchema)),
});

export const SetProjectDefaultProfileSchema = v.object({
  profileNameOrId: v.optional(v.nullable(v.string())),
});
