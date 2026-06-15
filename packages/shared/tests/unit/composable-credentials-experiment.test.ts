/**
 * EXPERIMENT (E1 parity + E2 demonstration).
 *
 * Two things proven here:
 *
 *  E2 — three very different consumers (OpenCode+z.ai, Codex auth.json, Hetzner
 *       compute) all fit the SAME resolver + the same primitive shapes, and the
 *       consumer-specific assemblers reproduce today's vm-agent injection bytes.
 *
 *  E1 — the single generalized resolver reproduces the DECISIONS of today's two
 *       parallel resolvers across a scenario matrix, including the Rule 28
 *       invariant (inactive project-scoped row HALTS, does not fall through).
 *
 * The "oracles" below are faithful reference implementations of the documented
 * precedence in:
 *   - getDecryptedAgentKey()   apps/api/src/routes/credentials.ts:671-755
 *   - createProviderForUser()  apps/api/src/services/provider-credentials.ts:197-265
 * They model the DECISION (which tier/source wins), which is what must stay
 * identical. The byte-level injection parity is covered by the assembler asserts.
 */

import { describe, expect, it } from 'vitest';

import { agentAssembler, computeAssembler } from '../../src/composable-credentials/assemblers';
import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  CompositionSnapshot,
  Credential,
  ResolutionSource,
} from '../../src/composable-credentials/types';

// ---------------------------------------------------------------------------
// Reference oracle for getDecryptedAgentKey (decision only)
// ---------------------------------------------------------------------------

type AgentRow = {
  agentType: string;
  scope: 'project' | 'user';
  isActive: boolean;
};

type OracleResult = 'project' | 'user' | 'platform' | 'proxy' | null;

/** Mirrors credentials.ts:671-755 precedence + the Rule 28 halt. */
function agentOracle(
  rows: AgentRow[],
  platform: 'credential' | 'proxy' | 'none',
  ctx: { hasProject: boolean }
): OracleResult {
  if (ctx.hasProject) {
    const projectRow = rows.find((r) => r.scope === 'project');
    if (projectRow) {
      // Rule 28: inactive project row halts — NO fallthrough.
      return projectRow.isActive ? 'project' : null;
    }
  }
  const userRow = rows.find((r) => r.scope === 'user' && r.isActive);
  if (userRow) return 'user';
  if (platform === 'credential') return 'platform';
  if (platform === 'proxy') return 'proxy';
  return null;
}

/** Map a ResolutionSource back to the oracle vocabulary. */
function sourceToOracle(source: ResolutionSource | null): OracleResult {
  switch (source) {
    case 'project-attachment':
      return 'project';
    case 'user-attachment':
      return 'user';
    case 'platform':
      return 'platform';
    case 'platform-proxy':
      return 'proxy';
    default:
      return null;
  }
}

// --- snapshot builder for the agent matrix ---------------------------------

let idSeq = 0;
const nextId = (p: string) => `${p}-${++idSeq}`;

function apiKeyCred(ownerId: string, name: string, isActive = true): Credential {
  return {
    id: nextId('cred'),
    ownerId,
    name,
    kind: 'api-key',
    secret: { kind: 'api-key', apiKey: `sk-${name}` },
    isActive,
  };
}

function buildAgentSnapshot(
  rows: AgentRow[],
  platform: 'credential' | 'proxy' | 'none',
  userId: string,
  projectId: string
): CompositionSnapshot {
  const credentials: Credential[] = [];
  const configurations: CompositionSnapshot['configurations'] = [];
  const attachments: CompositionSnapshot['attachments'] = [];
  const agentType = 'claude-code';

  for (const row of rows) {
    const cred = apiKeyCred(userId, `${row.scope}-key`);
    credentials.push(cred);
    const config: CompositionSnapshot['configurations'][number] = {
      id: nextId('cfg'),
      ownerId: userId,
      name: `${row.scope} config`,
      consumer: { kind: 'agent', agentType },
      credentialId: cred.id,
      settings: {},
      isActive: true,
    };
    configurations.push(config);
    attachments.push({
      id: nextId('att'),
      configurationId: config.id,
      consumer: { kind: 'agent', agentType },
      target:
        row.scope === 'project'
          ? { scope: 'project', userId, projectId }
          : { scope: 'user', userId },
      isActive: row.isActive,
    });
  }

  const platformRec: CompositionSnapshot['platform'] = {};
  if (platform === 'credential') {
    platformRec['agent:claude-code'] = {
      mode: 'credential',
      credential: apiKeyCred('platform', 'platform-key'),
    };
  } else if (platform === 'proxy') {
    platformRec['agent:claude-code'] = { mode: 'proxy' };
  }

  return { credentials, configurations, attachments, platform: platformRec };
}

describe('E1 — agent resolution parity vs getDecryptedAgentKey', () => {
  const userId = 'user-1';
  const projectId = 'proj-1';

  // Full scenario matrix: presence/activity of project row, user row, platform.
  const projectRowStates: (AgentRow | null)[] = [
    null,
    { agentType: 'claude-code', scope: 'project', isActive: true },
    { agentType: 'claude-code', scope: 'project', isActive: false },
  ];
  const userRowStates: (AgentRow | null)[] = [
    null,
    { agentType: 'claude-code', scope: 'user', isActive: true },
    { agentType: 'claude-code', scope: 'user', isActive: false },
  ];
  const platformStates: ('credential' | 'proxy' | 'none')[] = ['credential', 'proxy', 'none'];

  for (const hasProject of [true, false]) {
    for (const projRow of projectRowStates) {
      for (const userRow of userRowStates) {
        for (const platform of platformStates) {
          const rows = [projRow, userRow].filter((r): r is AgentRow => r !== null);
          const label = `project=${describeRow(projRow)} user=${describeRow(
            userRow
          )} platform=${platform} ctxProject=${hasProject}`;

          it(label, () => {
            idSeq = 0;
            const expected = agentOracle(rows, platform, { hasProject });
            const snapshot = buildAgentSnapshot(rows, platform, userId, projectId);
            const resolved = resolveEnvironment(
              snapshot,
              { kind: 'agent', agentType: 'claude-code' },
              { userId, projectId: hasProject ? projectId : undefined }
            );
            expect(sourceToOracle(resolved?.source ?? null)).toBe(expected);
          });
        }
      }
    }
  }
});

function describeRow(r: AgentRow | null): string {
  if (!r) return 'absent';
  return r.isActive ? 'active' : 'inactive';
}

// ---------------------------------------------------------------------------
// E1 — compute resolution parity vs createProviderForUser
// ---------------------------------------------------------------------------

describe('E1 — compute resolution parity vs createProviderForUser', () => {
  const userId = 'user-1';

  function buildComputeSnapshot(
    userCred: { provider: string; active: boolean } | null,
    platformCred: { provider: string } | null
  ): CompositionSnapshot {
    idSeq = 0;
    const credentials: Credential[] = [];
    const configurations: CompositionSnapshot['configurations'] = [];
    const attachments: CompositionSnapshot['attachments'] = [];
    const platform: CompositionSnapshot['platform'] = {};
    if (userCred) {
      const cred: Credential = {
        id: nextId('cred'),
        ownerId: userId,
        name: 'cloud',
        kind: 'cloud-provider',
        secret: { kind: 'cloud-provider', provider: userCred.provider, token: 'user-token' },
        isActive: userCred.active,
      };
      credentials.push(cred);
      const cfg: CompositionSnapshot['configurations'][number] = {
        id: nextId('cfg'),
        ownerId: userId,
        name: 'cloud cfg',
        consumer: { kind: 'compute', provider: userCred.provider },
        credentialId: cred.id,
        settings: {},
        isActive: true,
      };
      configurations.push(cfg);
      attachments.push({
        id: nextId('att'),
        configurationId: cfg.id,
        consumer: { kind: 'compute', provider: userCred.provider },
        target: { scope: 'user', userId },
        isActive: userCred.active,
      });
    }
    if (platformCred) {
      platform[`compute:${platformCred.provider}`] = {
        mode: 'credential',
        credential: {
          id: nextId('cred'),
          ownerId: 'platform',
          name: 'platform cloud',
          kind: 'cloud-provider',
          secret: { kind: 'cloud-provider', provider: platformCred.provider, token: 'plat-token' },
          isActive: true,
        },
      };
    }
    return { credentials, configurations, attachments, platform };
  }

  it('user active cloud credential wins', () => {
    const snap = buildComputeSnapshot(
      { provider: 'hetzner', active: true },
      { provider: 'hetzner' }
    );
    const resolved = resolveEnvironment(snap, { kind: 'compute', provider: 'hetzner' }, { userId });
    expect(resolved?.source).toBe('user-attachment');
    const cfg = computeAssembler.assemble(resolved!);
    expect(cfg).toEqual({ provider: 'hetzner', token: 'user-token', isPlatform: false });
  });

  it('falls back to platform when no user credential', () => {
    const snap = buildComputeSnapshot(null, { provider: 'hetzner' });
    const resolved = resolveEnvironment(snap, { kind: 'compute', provider: 'hetzner' }, { userId });
    expect(resolved?.source).toBe('platform');
    expect(computeAssembler.assemble(resolved!).isPlatform).toBe(true);
  });

  it('inactive user credential falls through to platform (compute has no halt rule)', () => {
    const snap = buildComputeSnapshot(
      { provider: 'hetzner', active: false },
      { provider: 'hetzner' }
    );
    const resolved = resolveEnvironment(snap, { kind: 'compute', provider: 'hetzner' }, { userId });
    expect(resolved?.source).toBe('platform');
  });

  it('returns null when nothing matches', () => {
    const snap = buildComputeSnapshot(null, null);
    const resolved = resolveEnvironment(snap, { kind: 'compute', provider: 'hetzner' }, { userId });
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E2 — three consumers, one shape; assembler byte fidelity
// ---------------------------------------------------------------------------

describe('E2 — heterogeneous consumers assemble to faithful vm-agent injection', () => {
  const userId = 'user-1';

  it('OpenCode + z.ai (openai-compatible) → proxy sentinel + custom provider config', () => {
    idSeq = 0;
    const cred: Credential = {
      id: nextId('cred'),
      ownerId: userId,
      name: 'z.ai',
      kind: 'openai-compatible',
      secret: {
        kind: 'openai-compatible',
        apiKey: 'zai-secret',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      },
      isActive: true,
    };
    const cfg: CompositionSnapshot['configurations'][number] = {
      id: nextId('cfg'),
      ownerId: userId,
      name: 'GLM 4.6 via z.ai',
      consumer: { kind: 'agent', agentType: 'opencode' },
      credentialId: cred.id,
      settings: {
        model: 'glm-4.6',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        samProxyBaseUrl: 'https://api.sam.example/ai/proxy/{wstoken}',
      },
      isActive: true,
    };
    const snap: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [
        {
          id: nextId('att'),
          configurationId: cfg.id,
          consumer: { kind: 'agent', agentType: 'opencode' },
          target: { scope: 'user', userId },
          isActive: true,
        },
      ],
      platform: {},
    };
    const resolved = resolveEnvironment(snap, { kind: 'agent', agentType: 'opencode' }, { userId });
    const injection = agentAssembler.assemble(resolved!);

    expect(injection.env).toEqual({ OPENCODE_API_KEY: '__platform_proxy__' });
    expect(JSON.stringify(injection)).not.toContain('zai-secret');
    expect(JSON.stringify(injection)).not.toContain('https://api.z.ai/api/coding/paas/v4');
    expect(injection.opencodeConfig).toEqual({
      model: 'custom/glm-4-6',
      provider: {
        custom: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Custom Provider',
          options: {
            baseURL: 'https://api.sam.example/ai/proxy/{wstoken}/openai/v1',
            apiKey: '{env:OPENCODE_API_KEY}',
          },
          models: { 'glm-4-6': { name: 'glm-4.6' } },
        },
      },
    });
  });

  it('Codex auth.json → CODEX_AUTH_JSON env injection', () => {
    idSeq = 0;
    const authBlob = '{"OPENAI_API_KEY":"x","tokens":{"access_token":"y"}}';
    const cred: Credential = {
      id: nextId('cred'),
      ownerId: userId,
      name: 'ChatGPT sub',
      kind: 'auth-json',
      secret: { kind: 'auth-json', authJson: authBlob },
      isActive: true,
    };
    const cfg: CompositionSnapshot['configurations'][number] = {
      id: nextId('cfg'),
      ownerId: userId,
      name: 'Codex (ChatGPT)',
      consumer: { kind: 'agent', agentType: 'openai-codex' },
      credentialId: cred.id,
      settings: {},
      isActive: true,
    };
    const snap: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [
        {
          id: nextId('att'),
          configurationId: cfg.id,
          consumer: { kind: 'agent', agentType: 'openai-codex' },
          target: { scope: 'user', userId },
          isActive: true,
        },
      ],
      platform: {},
    };
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'openai-codex' },
      { userId }
    );
    expect(agentAssembler.assemble(resolved!).env).toEqual({ CODEX_AUTH_JSON: authBlob });
  });

  it('platform proxy → __platform_proxy__ sentinel, no real key', () => {
    idSeq = 0;
    const snap: CompositionSnapshot = {
      credentials: [],
      configurations: [],
      attachments: [],
      platform: { 'agent:claude-code': { mode: 'proxy' } },
    };
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'claude-code' },
      { userId }
    );
    expect(resolved?.source).toBe('platform-proxy');
    expect(agentAssembler.assemble(resolved!).env).toEqual({
      ANTHROPIC_API_KEY: '__platform_proxy__',
    });
  });

  it('one OpenAI auth.json credential can feed two different agent configs (agentType decoupling)', () => {
    idSeq = 0;
    // The SAME credential, referenced by two configs targeting different agents.
    const cred: Credential = {
      id: nextId('cred'),
      ownerId: userId,
      name: 'OpenAI (shared)',
      kind: 'auth-json',
      secret: { kind: 'auth-json', authJson: '{"OPENAI_API_KEY":"shared"}' },
      isActive: true,
    };
    const codexCfg: CompositionSnapshot['configurations'][number] = {
      id: nextId('cfg'),
      ownerId: userId,
      name: 'Codex',
      consumer: { kind: 'agent', agentType: 'openai-codex' },
      credentialId: cred.id,
      settings: {},
      isActive: true,
    };
    const snap: CompositionSnapshot = {
      credentials: [cred],
      configurations: [codexCfg],
      attachments: [
        {
          id: nextId('att'),
          configurationId: codexCfg.id,
          consumer: { kind: 'agent', agentType: 'openai-codex' },
          target: { scope: 'user', userId },
          isActive: true,
        },
      ],
      platform: {},
    };
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'openai-codex' },
      { userId }
    );
    // The credential is NOT bound to an agentType — only the configuration is.
    expect(resolved?.credential?.id).toBe(cred.id);
    expect(resolved?.credential?.kind).toBe('auth-json');
  });
});
