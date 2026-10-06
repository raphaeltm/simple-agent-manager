/**
 * Item 4 — capability / vertical-slice coverage for alternative inference
 * providers (Rule 35).
 *
 * Unlike the experiment/assembly slices (which hardcode provider URLs and one
 * tier), this drives the FULL pipeline with the real shipped data:
 *
 *   PROVIDER_PRESETS  →  resolveHarnessDialect (registry gate)
 *                     →  resolveEnvironment (tiered precedence)
 *                     →  agentAssembler (workspace injection)
 *
 * It proves, end to end, that an alternative provider configured at any tier
 * routes through the SAM passthrough proxy: the workspace only ever sees the
 * `__platform_proxy__` sentinel and a SAM proxy URL derived from the harness
 * registry — never the provider's real API key or base URL. It also proves the
 * registry gate rejects harness/dialect combinations that cannot speak the
 * preset's dialect, and that an incompatible credential fails cleanly in the
 * assembler.
 */

import { describe, expect, it } from 'vitest';

import { agentAssembler, sanitizeModelAlias } from '../../src/composable-credentials/assemblers';
import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  CompositionSnapshot,
  Credential,
} from '../../src/composable-credentials/types';
import {
  type Dialect,
  HARNESS_CAPABILITIES,
  resolveHarnessDialect,
} from '../../src/harness-capabilities';
import { PROVIDER_PRESETS, type ProviderPreset } from '../../src/provider-presets';

const SAM_PROXY_BASE = 'https://api.sam.example/ai/proxy/{wstoken}';
const PROVIDER_SECRET = 'PROVIDER-SECRET-KEY';

const preset = (id: string): ProviderPreset => {
  const found = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`preset ${id} not found`);
  return found;
};

/**
 * Registry-derived proxy URL the assembler should inject for a harness. We
 * compute it from `resolveHarnessDialect` (the same registry the assembler
 * reads) so the assertion fails if the registry segment ever drifts. The
 * shipped preset/proxy data has no leading/trailing slash edge cases.
 */
function expectedProxyUrl(agentType: string, dialect: Dialect): string {
  const capability = resolveHarnessDialect(agentType, dialect);
  if (!capability) throw new Error(`${agentType} cannot speak ${dialect}`);
  return `${SAM_PROXY_BASE}/${capability.proxyRouteSegment}`;
}

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

interface TierOpts {
  agentType: string;
  baseUrl: string;
  model: string;
  /** Place an openai-compatible credential at the user tier. */
  user?: { model: string } | null;
  /**
   * Place an openai-compatible credential at the project tier. `active: false`
   * produces an inactive project-scoped attachment (Rule 28 halt fixture).
   */
  project?: { model: string; active?: boolean } | null;
  /** Platform default mode. */
  platform?: 'proxy' | 'none';
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

function openAiCompatCred(name: string): Credential {
  return {
    id: id('cred'),
    ownerId: USER_ID,
    name,
    kind: 'openai-compatible',
    secret: { kind: 'openai-compatible', apiKey: PROVIDER_SECRET, baseUrl: '' },
    isActive: true,
  };
}

/** Build a snapshot with optional project/user openai-compatible tiers + platform. */
function buildSnapshot(opts: TierOpts): CompositionSnapshot {
  seq = 0;
  const { agentType, baseUrl } = opts;
  const credentials: Credential[] = [];
  const configurations: CompositionSnapshot['configurations'] = [];
  const attachments: CompositionSnapshot['attachments'] = [];

  const addTier = (
    scope: 'project' | 'user',
    model: string,
    attachmentActive = true
  ) => {
    const cred = openAiCompatCred(`${scope}-cred`);
    cred.secret = { kind: 'openai-compatible', apiKey: PROVIDER_SECRET, baseUrl };
    credentials.push(cred);
    const cfg: CompositionSnapshot['configurations'][number] = {
      id: id('cfg'),
      ownerId: USER_ID,
      name: `${scope}-cfg`,
      consumer: { kind: 'agent', agentType },
      credentialId: cred.id,
      settings: { model, baseUrl, samProxyBaseUrl: SAM_PROXY_BASE },
      isActive: true,
    };
    configurations.push(cfg);
    attachments.push({
      id: id('att'),
      configurationId: cfg.id,
      consumer: { kind: 'agent', agentType },
      target:
        scope === 'project'
          ? { scope: 'project', userId: USER_ID, projectId: PROJECT_ID }
          : { scope: 'user', userId: USER_ID },
      isActive: attachmentActive,
    });
  };

  if (opts.user) addTier('user', opts.user.model);
  if (opts.project) addTier('project', opts.project.model, opts.project.active ?? true);

  const platform: CompositionSnapshot['platform'] = {};
  if (opts.platform === 'proxy') {
    platform[`agent:${agentType}`] = { mode: 'proxy' };
  }

  return { credentials, configurations, attachments, platform };
}

// ---------------------------------------------------------------------------
// A. openai-compatible alternative providers route through the SAM proxy
// ---------------------------------------------------------------------------

describe('Item 4 — openai-compatible alternative providers (real presets) inject proxy only', () => {
  const OPENAI_DIALECT_PRESETS = ['cohere-north', 'openrouter', 'groq'] as const;
  // openai-codex + opencode are the registry harnesses that speak openai-compatible.
  const HARNESSES = ['openai-codex', 'opencode'] as const;

  for (const presetId of OPENAI_DIALECT_PRESETS) {
    for (const agentType of HARNESSES) {
      it(`${presetId} via ${agentType}: sentinel + registry proxy URL, no provider secret/baseUrl`, () => {
        const p = preset(presetId);
        expect(p.dialect).toBe('openai-compatible');

        const snap = buildSnapshot({
          agentType,
          baseUrl: p.baseUrl,
          model: p.suggestedModels[0],
          user: { model: p.suggestedModels[0] },
        });
        const resolved = resolveEnvironment(
          snap,
          { kind: 'agent', agentType },
          { userId: USER_ID }
        );
        expect(resolved?.source).toBe('user-attachment');

        const injection = agentAssembler.assemble(resolved!);
        const capability = resolveHarnessDialect(agentType, 'openai-compatible')!;
        const proxyUrl = expectedProxyUrl(agentType, 'openai-compatible');

        // Sentinel is always present under the registry-defined auth env var.
        expect(injection.env[capability.authEnvVar]).toBe('__platform_proxy__');

        // The injected base URL is the SAM proxy URL from the registry, NOT the
        // provider's real base URL.
        if (capability.usesOpencodeConfig) {
          const cfg = injection.opencodeConfig as {
            provider: { custom: { options: { baseURL: string; apiKey: string } } };
          };
          expect(cfg.provider.custom.options.baseURL).toBe(proxyUrl);
          expect(cfg.provider.custom.options.apiKey).toBe(
            `{env:${capability.authEnvVar}}`
          );
        } else {
          expect(injection.env[capability.baseUrlEnvVar!]).toBe(proxyUrl);
        }

        // The provider secret and real base URL never reach the workspace.
        const serialized = JSON.stringify(injection);
        expect(serialized).not.toContain(PROVIDER_SECRET);
        expect(serialized).not.toContain(p.baseUrl);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// B. Tier precedence drives the assembled output (project → user → platform)
// ---------------------------------------------------------------------------

describe('Item 4 — tier precedence selects the assembled alternative-provider config', () => {
  const p = preset('openrouter');
  const PROJECT_MODEL = 'openai/gpt-5.5';
  const USER_MODEL = 'anthropic/claude-sonnet-4.6';
  const proxyUrl = expectedProxyUrl('opencode', 'openai-compatible');

  it('project tier wins when a projectId context is supplied', () => {
    const snap = buildSnapshot({
      agentType: 'opencode',
      baseUrl: p.baseUrl,
      model: PROJECT_MODEL,
      project: { model: PROJECT_MODEL },
      user: { model: USER_MODEL },
      platform: 'proxy',
    });
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'opencode' },
      { userId: USER_ID, projectId: PROJECT_ID }
    );
    expect(resolved?.source).toBe('project-attachment');

    const cfg = agentAssembler.assemble(resolved!).opencodeConfig as { model: string };
    expect(cfg.model).toBe(`custom/${sanitizeModelAlias(PROJECT_MODEL)}`);
  });

  it('user tier wins when no projectId context is supplied', () => {
    const snap = buildSnapshot({
      agentType: 'opencode',
      baseUrl: p.baseUrl,
      model: USER_MODEL,
      project: { model: PROJECT_MODEL },
      user: { model: USER_MODEL },
      platform: 'proxy',
    });
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'opencode' },
      { userId: USER_ID }
    );
    expect(resolved?.source).toBe('user-attachment');

    const cfg = agentAssembler.assemble(resolved!).opencodeConfig as { model: string };
    expect(cfg.model).toBe(`custom/${sanitizeModelAlias(USER_MODEL)}`);
  });

  it('inactive project attachment HALTS the chain (Rule 28 — no fallthrough to user)', () => {
    // Companion baseline: with ONLY the active user tier (no project attachment),
    // the same projectId context resolves to the user tier. This proves the user
    // tier is genuinely reachable, so a `null` below means the chain HALTED — not
    // that nothing matched.
    const reachable = buildSnapshot({
      agentType: 'opencode',
      baseUrl: p.baseUrl,
      model: USER_MODEL,
      user: { model: USER_MODEL },
      platform: 'proxy',
    });
    expect(
      resolveEnvironment(
        reachable,
        { kind: 'agent', agentType: 'opencode' },
        { userId: USER_ID, projectId: PROJECT_ID }
      )?.source
    ).toBe('user-attachment');

    // Now add an INACTIVE project-scoped attachment alongside the active user
    // tier. Rule 28: the inactive project row stops the chain — it must NOT fall
    // through to the still-active user tier.
    const halted = buildSnapshot({
      agentType: 'opencode',
      baseUrl: p.baseUrl,
      model: PROJECT_MODEL,
      project: { model: PROJECT_MODEL, active: false },
      user: { model: USER_MODEL },
      platform: 'proxy',
    });
    const resolved = resolveEnvironment(
      halted,
      { kind: 'agent', agentType: 'opencode' },
      { userId: USER_ID, projectId: PROJECT_ID }
    );
    expect(resolved).toBeNull();
  });

  it('platform-proxy fallback injects only the sentinel (no provider key)', () => {
    const snap = buildSnapshot({
      agentType: 'opencode',
      baseUrl: p.baseUrl,
      model: USER_MODEL,
      platform: 'proxy',
    });
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'opencode' },
      { userId: USER_ID }
    );
    expect(resolved?.source).toBe('platform-proxy');

    const injection = agentAssembler.assemble(resolved!);
    expect(injection.env).toEqual({ OPENCODE_API_KEY: '__platform_proxy__' });
    expect(injection.opencodeConfig).toBeUndefined();
    const serialized = JSON.stringify(injection);
    expect(serialized).not.toContain(PROVIDER_SECRET);
    // The bare platform-proxy sentinel path injects no base URL at all — not the
    // provider's, and not even the registry proxy URL (the workspace derives it).
    expect(serialized).not.toContain(proxyUrl);
    expect(serialized).not.toContain(p.baseUrl);
  });
});

// ---------------------------------------------------------------------------
// C. anthropic-dialect alternative provider (deepseek-anthropic)
// ---------------------------------------------------------------------------

// Note on the assembler path: the agent assembler only injects a *credential*
// for the `openai-compatible` secret kind (assemblers.ts) — there is no
// anthropic-dialect credential-injection branch. An anthropic-dialect
// alternative provider therefore reaches the workspace ONLY via platform-proxy
// (the `__platform_proxy__` sentinel under the harness's anthropic auth env
// var), which is exactly what the assembler test below exercises. Adding a
// user-tier anthropic credential injection path would be a behavior change and
// is out of scope. The vertical slice for anthropic is thus: registry gate
// (which harnesses may speak it) + resolveEnvironment + agentAssembler on the
// platform-proxy path.
describe('Item 4 — anthropic-dialect alternative provider (deepseek-anthropic)', () => {
  const p = preset('deepseek-anthropic');

  it('is an anthropic-dialect preset only anthropic-speaking harnesses accept', () => {
    expect(p.dialect).toBe('anthropic');
    // claude-code speaks anthropic; opencode's current assembler is OpenAI-compatible only.
    expect(resolveHarnessDialect('claude-code', 'anthropic')).not.toBeNull();
    expect(resolveHarnessDialect('opencode', 'anthropic')).toBeNull();
    expect(resolveHarnessDialect('openai-codex', 'anthropic')).toBeNull();
    expect(resolveHarnessDialect('mistral-vibe', 'anthropic')).toBeNull();
  });

  it('the registry proxy URL for an anthropic harness is not the provider base URL', () => {
    const proxyUrl = expectedProxyUrl('claude-code', 'anthropic');
    expect(proxyUrl).toBe(`${SAM_PROXY_BASE}/anthropic`);
    expect(proxyUrl).not.toBe(p.baseUrl);
    expect(proxyUrl).not.toContain('api.deepseek.com');
  });

  it('claude-code platform-proxy injects the anthropic sentinel, never the provider key', () => {
    const snap: CompositionSnapshot = {
      credentials: [],
      configurations: [],
      attachments: [],
      platform: { 'agent:claude-code': { mode: 'proxy' } },
    };
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'claude-code' },
      { userId: USER_ID }
    );
    expect(resolved?.source).toBe('platform-proxy');

    const injection = agentAssembler.assemble(resolved!);
    expect(injection.env).toEqual({ ANTHROPIC_API_KEY: '__platform_proxy__' });
    const serialized = JSON.stringify(injection);
    expect(serialized).not.toContain('api.deepseek.com');
  });
});

// ---------------------------------------------------------------------------
// D. Incompatible harness/dialect combinations fail cleanly
// ---------------------------------------------------------------------------

describe('Item 4 — incompatible harness/dialect combinations are rejected', () => {
  it('resolveHarnessDialect returns null for every unsupported pairing', () => {
    const cases: Array<[string, Dialect]> = [
      ['openai-codex', 'anthropic'],
      ['claude-code', 'openai-compatible'],
      ['mistral-vibe', 'openai-compatible'],
      ['mistral-vibe', 'anthropic'],
      ['google-gemini', 'anthropic'],
      ['google-gemini', 'openai-compatible'],
      ['amp', 'openai-compatible'],
      ['amp', 'anthropic'],
    ];
    for (const [agentType, dialect] of cases) {
      expect(resolveHarnessDialect(agentType, dialect)).toBeNull();
    }
  });

  it('an unknown harness never resolves any dialect', () => {
    expect(resolveHarnessDialect('does-not-exist', 'openai-compatible')).toBeNull();
    expect(resolveHarnessDialect('does-not-exist', 'anthropic')).toBeNull();
  });

  it('the assembler throws cleanly when a harness cannot speak an openai-compatible credential', () => {
    const p = preset('openrouter');
    const snap = buildSnapshot({
      agentType: 'claude-code',
      baseUrl: p.baseUrl,
      model: p.suggestedModels[0],
      user: { model: p.suggestedModels[0] },
    });
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'claude-code' },
      { userId: USER_ID }
    );
    expect(resolved).not.toBeNull();
    expect(() => agentAssembler.assemble(resolved!)).toThrow(
      'agent claude-code does not support openai-compatible proxy credentials'
    );
  });

  it('every preset dialect is speakable by at least one registered harness', () => {
    for (const p of PROVIDER_PRESETS) {
      const speakers = HARNESS_CAPABILITIES.filter(
        (cap) => resolveHarnessDialect(cap.agentType, p.dialect) !== null
      );
      expect(speakers.length).toBeGreaterThan(0);
    }
  });
});
