import * as v from 'valibot';

const AgentPermissionModeSchema = v.picklist([
  'default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions',
]);

const OpenCodeProviderSchema = v.picklist([
  'platform', 'scaleway', 'google-vertex', 'openai-compatible', 'anthropic', 'custom',
]);

export const SaveAgentSettingsSchema = v.pipe(
  v.object({
    model: v.optional(v.nullable(v.string())),
    permissionMode: v.optional(v.nullable(AgentPermissionModeSchema)),
    allowedTools: v.optional(v.nullable(v.array(v.string()))),
    deniedTools: v.optional(v.nullable(v.array(v.string()))),
    additionalEnv: v.optional(v.nullable(v.record(v.string(), v.string()))),
    opencodeProvider: v.optional(v.nullable(OpenCodeProviderSchema)),
    opencodeBaseUrl: v.optional(v.nullable(v.pipe(v.string(), v.url()))),
    opencodeProviderName: v.optional(v.nullable(v.string())),
  }),
  v.check(
    (input) => {
      const provider = input.opencodeProvider;
      if (provider === 'custom' || provider === 'openai-compatible') {
        // Base URL is required for custom/openai-compatible providers
        return !!input.opencodeBaseUrl;
      }
      return true;
    },
    'opencodeBaseUrl is required for custom and openai-compatible providers'
  ),
  v.check(
    (input) => {
      if (input.opencodeBaseUrl) {
        try {
          const url = new URL(input.opencodeBaseUrl);
          return url.protocol === 'https:';
        } catch {
          return false;
        }
      }
      return true;
    },
    'opencodeBaseUrl must be a valid HTTPS URL'
  ),
);
