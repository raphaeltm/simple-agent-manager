import * as v from 'valibot';

const AgentPermissionModeSchema = v.picklist([
  'default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions',
]);

export const SaveAgentSettingsSchema = v.object({
  model: v.optional(v.nullable(v.string())),
  permissionMode: v.optional(v.nullable(AgentPermissionModeSchema)),
  allowedTools: v.optional(v.nullable(v.array(v.string()))),
  deniedTools: v.optional(v.nullable(v.array(v.string()))),
  additionalEnv: v.optional(v.nullable(v.record(v.string(), v.string()))),
});
