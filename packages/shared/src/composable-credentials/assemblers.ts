/**
 * Composable Credentials — consumer-specific assemblers.
 *
 * The resolver is fully shared across consumers. The assembler is the
 * consumer-specific seam: it maps a ResolvedEnvironment to the concrete
 * output that consumer needs:
 *   - agents → env vars + optional opencode config JSON + files
 *   - compute → provider client config
 *
 * The agent assembler reproduces today's vm-agent injection contract exactly
 * (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / CODEX_AUTH_JSON /
 * OPENCODE_API_KEY + opencode custom-provider config).
 */

import {
  HARNESS_CAPABILITIES,
  type HarnessCapability,
  resolveHarnessDialect,
} from '../harness-capabilities';
import type { ConsumerKind, ResolvedEnvironment } from './types';

/** What an agent consumer needs injected into the workspace. */
export interface EnvInjection {
  env: Record<string, string>;
  /** Files to materialize in the container (e.g. ~/.codex/auth.json). */
  files: { path: string; content: string }[];
  /** Opencode custom-provider config (mirrors OPENCODE_CONFIG_CONTENT). */
  opencodeConfig?: Record<string, unknown>;
}

/** What a compute consumer needs to construct a Provider client. */
export interface ProviderConfig {
  provider: string;
  token: string;
  isPlatform: boolean;
}

export interface Assembler<TOutput> {
  consumerKind: ConsumerKind;
  assemble(resolved: ResolvedEnvironment): TOutput;
}

const PLATFORM_PROXY_SENTINEL = '__platform_proxy__';

/**
 * Agent assembler — produces env-var injection faithful to the current
 * vm-agent contract.
 */
export const agentAssembler: Assembler<EnvInjection> = {
  consumerKind: 'agent',
  assemble(resolved): EnvInjection {
    if (resolved.consumer.kind !== 'agent') {
      throw new Error('agentAssembler received a non-agent consumer');
    }
    const agentType = resolved.consumer.agentType;

    // Platform proxy: inject the sentinel, no real secret.
    if (resolved.source === 'platform-proxy' || resolved.credential === null) {
      return { env: keyEnvVar(agentType, PLATFORM_PROXY_SENTINEL), files: [] };
    }

    const secret = resolved.credential.secret;
    const settings = resolved.configuration?.settings ?? {};

    switch (secret.kind) {
      case 'api-key':
        return { env: keyEnvVar(agentType, secret.apiKey), files: [] };

      case 'oauth-token':
        return { env: oauthEnvVar(agentType, secret.token), files: [] };

      case 'auth-json':
        return { env: { CODEX_AUTH_JSON: secret.authJson }, files: [] };

      case 'openai-compatible': {
        const capability = resolveHarnessDialect(agentType, 'openai-compatible');
        if (!capability?.proxyRouteSegment) {
          throw new Error(
            `agent ${agentType} does not support openai-compatible proxy credentials`
          );
        }
        const model = settings.model ?? 'glm-4.6';
        const modelAlias = sanitizeModelAlias(model);
        const proxyBaseURL = proxyBaseUrl(capability, settings);
        const env: Record<string, string> = {
          [capability.authEnvVar]: PLATFORM_PROXY_SENTINEL,
        };

        if (capability.usesOpencodeConfig) {
          // OpenCode custom providers use an AI SDK package plus options.baseURL
          // and options.apiKey; OpenAI-compatible providers use /v1/chat/completions.
          // https://opencode.ai/docs/providers/
          // https://ai-sdk.dev/providers/openai-compatible-providers
          return {
            env,
            files: [],
            opencodeConfig: {
              model: `custom/${modelAlias}`,
              provider: {
                custom: {
                  npm: '@ai-sdk/openai-compatible',
                  name: 'Custom Provider',
                  options: {
                    baseURL: proxyBaseURL,
                    apiKey: `{env:${capability.authEnvVar}}`,
                  },
                  models: { [modelAlias]: { name: model } },
                },
              },
            },
          };
        }

        if (capability.baseUrlEnvVar) {
          env[capability.baseUrlEnvVar] = proxyBaseURL;
        }

        return { env, files: [] };
      }

      case 'cloud-provider':
        throw new Error('agentAssembler cannot assemble a cloud-provider credential');
    }
  },
};

/** Compute assembler — produces a Provider client config. */
export const computeAssembler: Assembler<ProviderConfig> = {
  consumerKind: 'compute',
  assemble(resolved): ProviderConfig {
    if (resolved.consumer.kind !== 'compute') {
      throw new Error('computeAssembler received a non-compute consumer');
    }
    if (resolved.credential === null) {
      throw new Error('compute consumer requires a credential (no proxy mode)');
    }
    const secret = resolved.credential.secret;
    if (secret.kind !== 'cloud-provider') {
      throw new Error(`compute consumer requires a cloud-provider credential, got ${secret.kind}`);
    }
    return {
      provider: secret.provider,
      token: secret.token,
      isPlatform: resolved.source === 'platform',
    };
  },
};

// --- agent env-var mapping ---------------------------------------------------

/** Map an agent type to its primary API-key env var name. */
function keyEnvVar(agentType: string, value: string): Record<string, string> {
  const name = HARNESS_CAPABILITIES.find(
    (capability) => capability.agentType === agentType
  )?.authEnvVar;
  if (!name) throw new Error(`no api-key env var mapping for agent ${agentType}`);
  return { [name]: value };
}

/** Map an agent type to its OAuth-token env var name. */
function oauthEnvVar(agentType: string, value: string): Record<string, string> {
  const name = OAUTH_ENV[agentType];
  if (!name) throw new Error(`no oauth env var mapping for agent ${agentType}`);
  return { [name]: value };
}

const OAUTH_ENV: Record<string, string> = {
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

function proxyBaseUrl(capability: HarnessCapability, settings: Record<string, unknown>): string {
  const base = stringSetting(settings.samProxyBaseUrl) ?? '/ai/proxy/{wstoken}';
  return `${trimTrailingSlashes(base)}/${trimLeadingSlashes(capability.proxyRouteSegment)}`;
}

function stringSetting(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) {
    start++;
  }
  return value.slice(start);
}

/** Mirror of opencode's model-alias sanitization (slashes/spaces → dashes). */
export function sanitizeModelAlias(model: string): string {
  return model.replace(/[^a-zA-Z0-9_-]/g, '-');
}
