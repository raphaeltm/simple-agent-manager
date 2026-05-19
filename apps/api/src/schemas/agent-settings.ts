import type { AgentProviderMode, OpenCodeProvider } from '@simple-agent-manager/shared';
import {
  OPENCODE_PROVIDERS,
  VALID_AGENT_PROVIDER_MODES,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

export interface AgentSettingsValidationLimits {
  maxModelLength: number;
  maxToolNameLength: number;
  maxToolListLength: number;
  maxEnvVars: number;
  maxEnvKeyLength: number;
  maxEnvValueLength: number;
  maxProviderNameLength: number;
  maxBaseUrlLength: number;
}

export const AGENT_SETTINGS_VALIDATION_DEFAULTS: AgentSettingsValidationLimits = {
  maxModelLength: 200,
  maxToolNameLength: 200,
  maxToolListLength: 100,
  maxEnvVars: 50,
  maxEnvKeyLength: 128,
  maxEnvValueLength: 4096,
  maxProviderNameLength: 100,
  maxBaseUrlLength: 2048,
};

const AgentPermissionModeSchema = v.picklist(VALID_PERMISSION_MODES);

const OpenCodeProviderSchema = v.picklist(
  Object.keys(OPENCODE_PROVIDERS) as [OpenCodeProvider, ...OpenCodeProvider[]]
);

const AgentProviderModeSchema = v.picklist([...VALID_AGENT_PROVIDER_MODES] as [
  AgentProviderMode,
  ...AgentProviderMode[],
]);

const BoundedStringSchema = (maxLength: number) => v.pipe(v.string(), v.maxLength(maxLength));

export function createSaveAgentSettingsSchema(
  limits: AgentSettingsValidationLimits = AGENT_SETTINGS_VALIDATION_DEFAULTS
) {
  const toolListSchema = v.pipe(
    v.array(BoundedStringSchema(limits.maxToolNameLength)),
    v.maxLength(limits.maxToolListLength)
  );

  const additionalEnvSchema = v.pipe(
    v.record(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(limits.maxEnvKeyLength),
        v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names must be shell-safe')
      ),
      BoundedStringSchema(limits.maxEnvValueLength)
    ),
    v.check(
      (input) => Object.keys(input).length <= limits.maxEnvVars,
      `additionalEnv must contain at most ${limits.maxEnvVars} variables`
    )
  );

  return v.pipe(
    v.object({
      model: v.optional(v.nullable(BoundedStringSchema(limits.maxModelLength))),
      permissionMode: v.optional(v.nullable(AgentPermissionModeSchema)),
      allowedTools: v.optional(v.nullable(toolListSchema)),
      deniedTools: v.optional(v.nullable(toolListSchema)),
      additionalEnv: v.optional(v.nullable(additionalEnvSchema)),
      opencodeProvider: v.optional(v.nullable(OpenCodeProviderSchema)),
      opencodeBaseUrl: v.optional(v.nullable(BoundedStringSchema(limits.maxBaseUrlLength))),
      opencodeProviderName: v.optional(v.nullable(BoundedStringSchema(limits.maxProviderNameLength))),
      providerMode: v.optional(v.nullable(AgentProviderModeSchema)),
    }),
    v.check(
      (input) => {
        const provider = input.opencodeProvider;
        return !provider || !OPENCODE_PROVIDERS[provider].requiresBaseUrl || !!input.opencodeBaseUrl;
      },
      'opencodeBaseUrl is required for providers that require a base URL'
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
}

export const SaveAgentSettingsSchema = createSaveAgentSettingsSchema();
