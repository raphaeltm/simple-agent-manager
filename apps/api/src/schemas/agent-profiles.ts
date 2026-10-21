import { AGENT_EFFORT_LEVELS, AGENT_PROFILE_RUNTIMES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { ResourceRequirementsSchema } from './resource-requirements';

const GitHubCliPermissionLevelSchema = v.picklist(['none', 'read', 'write']);
const GitHubCliContentsPermissionLevelSchema = v.picklist(['read', 'write']);
const AgentEffortSchema = v.picklist([...AGENT_EFFORT_LEVELS]);
const AgentProfileRuntimeSchema = v.picklist([...AGENT_PROFILE_RUNTIMES]);

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

/**
 * Profile ids are server-issued and checked against the project's profiles, so these are
 * request-sanity bounds only (.claude/rules/51): far above any real id or profile count.
 */
const PROFILE_PICKER_MAX_ID_LENGTH = 512;
const PROFILE_PICKER_MAX_IDS_PER_REQUEST = 500;
const ProfilePickerIdListSchema = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(PROFILE_PICKER_MAX_ID_LENGTH))),
  v.maxLength(PROFILE_PICKER_MAX_IDS_PER_REQUEST)
);

/** PATCH /api/projects/:projectId/agent-profiles/picker — hide/show in the caller's own picker. */
export const UpdateProfilePickerSchema = v.object({
  hide: v.optional(ProfilePickerIdListSchema),
  unhide: v.optional(ProfilePickerIdListSchema),
});

export const SetProjectDefaultProfileSchema = v.object({
  profileNameOrId: v.optional(v.nullable(v.string())),
});
