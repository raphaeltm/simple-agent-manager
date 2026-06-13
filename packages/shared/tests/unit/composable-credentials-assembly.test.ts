/**
 * EXPERIMENT (E5) — assembly-slice parity vs gateway.go:buildOpencodeConfig.
 *
 * The E2 tests prove the agent assembler produces the right opencode config for
 * ONE hardcoded z.ai case. That is not enough to claim parity: the only piece of
 * shared logic between the TS assembler and the Go function that can silently
 * DRIFT is the model-alias sanitization (slashes/spaces/dots → dashes) and the
 * surrounding `custom` provider shape. A single happy-path string can't catch a
 * sanitization mismatch on, say, "deepseek/v3.1" or "GLM 4.6 (preview)".
 *
 * So this slice ports the Go `custom` branch (gateway.go:1430-1451) as an ORACLE
 * and drives the full vertical slice (snapshot → resolveEnvironment → assembler)
 * against it across a table of adversarial model names. If the TS assembler and
 * the Go oracle ever diverge on alias formatting, this test fails — which is the
 * exact regression that would break OpenCode custom providers in production.
 *
 * Scope note: the assembler's `openai-compatible` branch corresponds ONLY to the
 * Go `"openai-compatible"/"custom"` provider case. The built-in provider branches
 * (platform/scaleway/anthropic/google-vertex/opencode-managed) are provider-
 * SELECTION concerns, not credential-RESOLUTION concerns, and live outside the
 * composable-credentials model — they are intentionally not assembled here.
 */

import { describe, expect, it } from 'vitest';

import { agentAssembler } from '../../src/composable-credentials/assemblers';
import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  CompositionSnapshot,
  Credential,
} from '../../src/composable-credentials/types';

// ---------------------------------------------------------------------------
// Oracle — faithful TS port of gateway.go buildOpencodeConfig 'custom' branch
// (lines 1430-1451). Kept deliberately separate from the assembler so a drift
// in either implementation is visible.
// ---------------------------------------------------------------------------

/** Mirror of gateway.go sanitizeModelAlias (regexp [^a-zA-Z0-9_-] → "-"). */
function goSanitizeModelAlias(model: string): string {
  return model.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** Port of the Go `custom` provider config branch. */
function goBuildCustomOpencodeConfig(model: string, baseURL: string): Record<string, unknown> {
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
    settings: { model, baseUrl },
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

describe('E5 — opencode custom-provider assembly matches gateway.go across model names', () => {
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

  for (const model of MODELS) {
    it(`model "${model}" → assembler config equals Go oracle`, () => {
      const assembled = assembleOpencode(model, BASE_URL);
      const oracle = goBuildCustomOpencodeConfig(model, BASE_URL);
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

  it('baseURL from configuration settings flows through verbatim', () => {
    const assembled = assembleOpencode('glm-4.6', 'https://zai.example/paas/v4') as Record<
      string,
      unknown
    >;
    const provider = assembled.provider as Record<string, unknown>;
    const custom = provider.custom as { options: { baseURL: string } };
    expect(custom.options.baseURL).toBe('https://zai.example/paas/v4');
  });

  it('apiKey is always the {env:OPENCODE_API_KEY} reference, never the raw secret', () => {
    const assembled = assembleOpencode('glm-4.6', BASE_URL) as Record<string, unknown>;
    const provider = assembled.provider as Record<string, unknown>;
    const custom = provider.custom as { options: { apiKey: string } };
    expect(custom.options.apiKey).toBe('{env:OPENCODE_API_KEY}');
    // The real secret rides in the env var, not the config JSON.
    expect(JSON.stringify(assembled)).not.toContain('secret-bytes');
  });
});
