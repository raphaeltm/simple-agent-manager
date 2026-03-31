import * as v from 'valibot';

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
  taskMode: v.optional(v.nullable(v.string())),
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
  taskMode: v.optional(v.nullable(v.string())),
});

export const SetProjectDefaultProfileSchema = v.object({
  profileNameOrId: v.optional(v.nullable(v.string())),
});
