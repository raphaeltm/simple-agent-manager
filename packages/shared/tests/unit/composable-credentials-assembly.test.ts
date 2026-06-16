/**
 * EXPERIMENT (E5) — assembly-slice coverage for opencode custom config.
 *
 * The E2 tests prove the agent assembler produces the right opencode config for
 * ONE hardcoded z.ai case. That is not enough to claim parity: the only piece of
 * shared logic between the TS assembler and the Go function that can silently
 * DRIFT is the model-alias sanitization (slashes/spaces/dots → dashes) and the
 * surrounding `custom` provider shape. A single happy-path string can't catch a
 * sanitization mismatch on, say, "deepseek/v3.1" or "GLM 4.6 (preview)".
 *
 * The openai-compatible branch is now proxy-aware: the provider base URL stays
 * out of workspace config/env, and the injected baseURL points at the SAM proxy.
 * This slice still guards model-alias sanitization because a drift there would
 * break OpenCode custom providers.
 */

import { describe, expect, it } from 'vitest';

import { agentAssembler, type EnvInjection } from '../../src/composable-credentials/assemblers';
import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  CompositionSnapshot,
  Credential,
  ResolvedEnvironment,
} from '../../src/composable-credentials/types';

// ---------------------------------------------------------------------------
// Oracle — kept deliberately separate from the assembler so alias/config drift
// remains visible while the base URL is fixed to the SAM proxy.
// ---------------------------------------------------------------------------

/** Mirror of gateway.go sanitizeModelAlias (regexp [^a-zA-Z0-9_-] → "-"). */
function goSanitizeModelAlias(model: string): string {
  return model.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function expectedProxyOpencodeConfig(model: string, baseURL: string): Record<string, unknown> {
  const modelAlias = goSanitizeModelAlias(model);
  return {
    model: `custom/${modelAlias}`,
    provider: {
      custom: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Custom Provider',
        options: {
          baseURL,
          apiKey: '{env:OPENCODE_API_KEY}',
        },
        models: { [modelAlias]: { name: model } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Vertical-slice driver — build a real snapshot, resolve it, assemble it.
// ---------------------------------------------------------------------------

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function assembleOpencode(model: string, baseUrl: string): Record<string, unknown> | undefined {
  seq = 0;
  const userId = 'user-1';
  const cred: Credential = {
    id: id('cred'),
    ownerId: userId,
    name: 'custom openai-compatible',
    kind: 'openai-compatible',
    secret: { kind: 'openai-compatible', apiKey: 'secret-bytes', baseUrl },
    isActive: true,
  };
  const cfg: CompositionSnapshot['configurations'][number] = {
    id: id('cfg'),
    ownerId: userId,
    name: 'opencode via custom',
    consumer: { kind: 'agent', agentType: 'opencode' },
    credentialId: cred.id,
    settings: { model, baseUrl, samProxyBaseUrl: 'https://api.sam.example/ai/proxy/{wstoken}' },
    isActive: true,
  };
  const snap: CompositionSnapshot = {
    credentials: [cred],
    configurations: [cfg],
    attachments: [
      {
        id: id('att'),
        configurationId: cfg.id,
        consumer: { kind: 'agent', agentType: 'opencode' },
        target: { scope: 'user', userId },
        isActive: true,
      },
    ],
    platform: {},
  };
  const resolved = resolveEnvironment(snap, { kind: 'agent', agentType: 'opencode' }, { userId });
  return agentAssembler.assemble(resolved!).opencodeConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E5 — opencode proxy custom-provider assembly across model names', () => {
  // Adversarial model names — each exercises a different sanitization path.
  const MODELS = [
    'glm-4.6', // dot
    'deepseek/v3.1', // slash + dot
    'GLM 4.6 (preview)', // spaces + parens
    'qwen2.5-coder:32b', // dot + colon
    'meta/llama-4-scout-17b-16e-instruct', // vendor prefix slash
    'simple', // no special chars (identity)
    'модель-1', // unicode → all stripped to dashes
    'a_b-c', // underscores/dashes preserved
  ];

  const BASE_URL = 'https://api.example.com/v1';
  const PROXY_URL = 'https://api.sam.example/ai/proxy/{wstoken}/openai/v1';

  for (const model of MODELS) {
    it(`model "${model}" → assembler config equals proxy oracle`, () => {
      const assembled = assembleOpencode(model, BASE_URL);
      const oracle = expectedProxyOpencodeConfig(model, PROXY_URL);
      expect(assembled).toEqual(oracle);
    });
  }

  it('the config model alias is always the sanitized form (no raw slashes/dots/spaces)', () => {
    for (const model of MODELS) {
      const assembled = assembleOpencode(model, BASE_URL) as { model: string };
      const alias = assembled.model.replace(/^custom\//, '');
      expect(alias).toMatch(/^[a-zA-Z0-9_-]*$/);
      // The human-readable original is preserved under models[alias].name.
      const provider = (assembled as Record<string, unknown>).provider as Record<string, unknown>;
      const custom = provider.custom as { models: Record<string, { name: string }> };
      expect(custom.models[alias].name).toBe(model);
    }
  });

  it('baseURL points at the SAM proxy, not the provider URL', () => {
    const assembled = assembleOpencode('glm-4.6', 'https://zai.example/paas/v4') as Record<
      string,
      unknown
    >;
    const provider = assembled.provider as Record<string, unknown>;
    const custom = provider.custom as { options: { baseURL: string } };
    expect(custom.options.baseURL).toBe(PROXY_URL);
    expect(JSON.stringify(assembled)).not.toContain('https://zai.example/paas/v4');
  });

  it('apiKey is always the proxy sentinel env reference, never the raw secret', () => {
    const assembled = assembleOpencode('glm-4.6', BASE_URL) as Record<string, unknown>;
    const provider = assembled.provider as Record<string, unknown>;
    const custom = provider.custom as { options: { apiKey: string } };
    expect(custom.options.apiKey).toBe('{env:OPENCODE_API_KEY}');
    expect(JSON.stringify(assembled)).not.toContain('secret-bytes');
  });
});

describe('openai-compatible proxy assembly uses harness registry descriptors', () => {
  const providerBaseUrl = 'https://provider.example/v1';
  const proxyBaseUrl = 'https://api.sam.example/ai/proxy/{wstoken}';
  const proxyUrl = `${proxyBaseUrl}/openai/v1`;
  const providerKey = 'provider-secret-key';

  function assemble(agentType: string): EnvInjection {
    const resolved: ResolvedEnvironment = {
      source: 'user-attachment',
      consumer: { kind: 'agent', agentType },
      credential: {
        id: 'cred',
        ownerId: 'user-1',
        name: 'alternative provider',
        kind: 'openai-compatible',
        secret: {
          kind: 'openai-compatible',
          apiKey: providerKey,
          baseUrl: providerBaseUrl,
        },
        isActive: true,
      },
      configuration: {
        id: 'cfg',
        ownerId: 'user-1',
        name: 'alternative provider config',
        consumer: { kind: 'agent', agentType },
        credentialId: 'cred',
        settings: {
          model: 'glm-4.6',
          baseUrl: providerBaseUrl,
          samProxyBaseUrl: proxyBaseUrl,
        },
        isActive: true,
      },
    };
    return agentAssembler.assemble(resolved);
  }

  it('openai-codex gets registry env names, proxy baseURL, and no provider key', () => {
    const injection = assemble('openai-codex');

    expect(injection.env).toEqual({
      OPENAI_API_KEY: '__platform_proxy__',
      OPENAI_BASE_URL: proxyUrl,
    });
    expect(injection.opencodeConfig).toBeUndefined();
    expect(JSON.stringify(injection)).not.toContain(providerKey);
    expect(JSON.stringify(injection)).not.toContain(providerBaseUrl);
  });

  it('opencode gets registry env names, proxy config baseURL, and no provider key', () => {
    const injection = assemble('opencode');

    expect(injection.env).toEqual({ OPENCODE_API_KEY: '__platform_proxy__' });
    expect(injection.opencodeConfig).toMatchObject({
      provider: {
        custom: {
          options: {
            baseURL: proxyUrl,
            apiKey: '{env:OPENCODE_API_KEY}',
          },
        },
      },
    });
    expect(JSON.stringify(injection)).not.toContain(providerKey);
    expect(JSON.stringify(injection)).not.toContain(providerBaseUrl);
  });

  it('rejects agents whose registry entry cannot speak openai-compatible', () => {
    expect(() => assemble('claude-code')).toThrow(
      'agent claude-code does not support openai-compatible proxy credentials'
    );
  });
});
