import type { OpenCodeProvider } from '@simple-agent-manager/shared';
import {
  OPENCODE_PROVIDERS,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

const MAX_MODEL_LENGTH = 200;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_TOOL_LIST_LENGTH = 100;
const MAX_ENV_VARS = 50;
const MAX_ENV_KEY_LENGTH = 128;
const MAX_ENV_VALUE_LENGTH = 4096;
const MAX_PROVIDER_NAME_LENGTH = 100;
const MAX_BASE_URL_LENGTH = 2048;

const AgentPermissionModeSchema = v.picklist(VALID_PERMISSION_MODES);

const OpenCodeProviderSchema = v.picklist(
  Object.keys(OPENCODE_PROVIDERS) as [OpenCodeProvider, ...OpenCodeProvider[]]
);

const BoundedStringSchema = (maxLength: number) => v.pipe(v.string(), v.maxLength(maxLength));

const ToolListSchema = v.pipe(
  v.array(BoundedStringSchema(MAX_TOOL_NAME_LENGTH)),
  v.maxLength(MAX_TOOL_LIST_LENGTH)
);

const AdditionalEnvSchema = v.pipe(
  v.record(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_ENV_KEY_LENGTH),
      v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names must be shell-safe')
    ),
    BoundedStringSchema(MAX_ENV_VALUE_LENGTH)
  ),
  v.check((input) => Object.keys(input).length <= MAX_ENV_VARS, `additionalEnv must contain at most ${MAX_ENV_VARS} variables`)
);

export const SaveAgentSettingsSchema = v.pipe(
  v.object({
    model: v.optional(v.nullable(BoundedStringSchema(MAX_MODEL_LENGTH))),
    permissionMode: v.optional(v.nullable(AgentPermissionModeSchema)),
    allowedTools: v.optional(v.nullable(ToolListSchema)),
    deniedTools: v.optional(v.nullable(ToolListSchema)),
    additionalEnv: v.optional(v.nullable(AdditionalEnvSchema)),
    opencodeProvider: v.optional(v.nullable(OpenCodeProviderSchema)),
    opencodeBaseUrl: v.optional(v.nullable(BoundedStringSchema(MAX_BASE_URL_LENGTH))),
    opencodeProviderName: v.optional(v.nullable(BoundedStringSchema(MAX_PROVIDER_NAME_LENGTH))),
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
