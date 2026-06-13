/**
 * EXPERIMENT (E2/E5) — EnvironmentAssembler.
 *
 * The resolver (resolver.ts) is fully shared across consumers. The ASSEMBLER is
 * the consumer-specific seam: it maps a ResolvedEnvironment to the concrete
 * output that consumer needs. This split is the honest generalization result —
 *   - agents inject env vars (+ sometimes an opencode config JSON / a file)
 *   - compute constructs a provider client config
 * so the assembler is generic over its OUTPUT type, while the resolver is not.
 *
 * The agent assembler below reproduces today's vm-agent injection contract
 * exactly (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / CODEX_AUTH_JSON /
 * OPENCODE_API_KEY + opencode custom-provider config — see
 * packages/vm-agent/internal/acp/gateway.go:buildOpencodeConfig). That fidelity
 * is what makes the move non-breaking: only the resolution layer changes, the
 * bytes injected into the VM do not.
 */

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
        // Codex reads its auth.json blob from CODEX_AUTH_JSON.
        return { env: { CODEX_AUTH_JSON: secret.authJson }, files: [] };

      case 'openai-compatible': {
        // z.ai (and any custom OpenAI-compatible endpoint) through opencode.
        const model = settings.model ?? 'glm-4.6';
        const modelAlias = sanitizeModelAlias(model);
        return {
          env: { OPENCODE_API_KEY: secret.apiKey },
          files: [],
          opencodeConfig: {
            model: `custom/${modelAlias}`,
            provider: {
              custom: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Custom Provider',
                options: {
                  baseURL: settings.baseUrl ?? secret.baseUrl,
                  apiKey: '{env:OPENCODE_API_KEY}',
                },
                models: { [modelAlias]: { name: model } },
              },
            },
          },
        };
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

// --- agent env-var mapping (mirrors AGENT_CATALOG) ---------------------------

/** Map an agent type to its primary API-key env var name. */
function keyEnvVar(agentType: string, value: string): Record<string, string> {
  const name = API_KEY_ENV[agentType];
  if (!name) throw new Error(`no api-key env var mapping for agent ${agentType}`);
  return { [name]: value };
}

/** Map an agent type to its OAuth-token env var name. */
function oauthEnvVar(agentType: string, value: string): Record<string, string> {
  const name = OAUTH_ENV[agentType];
  if (!name) throw new Error(`no oauth env var mapping for agent ${agentType}`);
  return { [name]: value };
}

const API_KEY_ENV: Record<string, string> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  'openai-codex': 'OPENAI_API_KEY',
  'google-gemini': 'GEMINI_API_KEY',
  'mistral-vibe': 'MISTRAL_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  amp: 'AMP_API_KEY',
};

const OAUTH_ENV: Record<string, string> = {
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** Mirror of opencode's model-alias sanitization (slashes/spaces → dashes). */
function sanitizeModelAlias(model: string): string {
  return model.replace(/[^a-zA-Z0-9_-]/g, '-');
}
