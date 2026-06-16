/**
 * E6 — wiring parity: CC resolver output → legacy getDecryptedAgentKey shape.
 *
 * Tests the mapping from ResolvedEnvironment (CC model) to the legacy return
 * shape { credential, credentialKind, credentialSource }. This is the exact
 * transformation that credentials.ts:mapResolvedToLegacy() performs. We drive
 * it from the shared resolver output to prove the wiring produces identical
 * results to the old path.
 *
 * Also tests createProviderForUser parity: CC computeAssembler output →
 * buildProviderConfig compatible token.
 */

import { describe, expect, it } from 'vitest';

import { computeAssembler } from '../../src/composable-credentials/assemblers';
import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  CompositionSnapshot,
  Credential,
  ResolvedEnvironment,
} from '../../src/composable-credentials/types';

// ---------------------------------------------------------------------------
// Legacy mapping mirrors — exact copies of credentials.ts mapping functions
// to test in isolation without importing from apps/api
// ---------------------------------------------------------------------------

type LegacyCredentialKind = 'api-key' | 'oauth-token';
type LegacyCredentialSource = 'user' | 'project' | 'platform';

function mapResolvedToLegacy(
  resolved: ResolvedEnvironment,
): { credential: string; credentialKind: LegacyCredentialKind; credentialSource: LegacyCredentialSource } | null {
  if (resolved.source === 'platform-proxy' || !resolved.credential) {
    return null;
  }

  const secret = resolved.credential.secret;
  let credential: string;
  let credentialKind: LegacyCredentialKind;

  switch (secret.kind) {
    case 'api-key':
      credential = secret.apiKey;
      credentialKind = 'api-key';
      break;
    case 'oauth-token':
      credential = secret.token;
      credentialKind = 'oauth-token';
      break;
    case 'auth-json':
      credential = secret.authJson;
      credentialKind = 'oauth-token';
      break;
    case 'openai-compatible':
      credential = secret.apiKey;
      credentialKind = 'api-key';
      break;
    case 'cloud-provider':
      return null;
  }

  const credentialSource = mapSourceToLegacy(resolved.source);
  return { credential, credentialKind, credentialSource };
}

function mapSourceToLegacy(source: string): LegacyCredentialSource {
  switch (source) {
    case 'project-attachment': return 'project';
    case 'user-attachment': return 'user';
    default: return 'platform';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

function makeSnapshot(opts: {
  userId: string;
  credentials: Credential[];
  agentType: string;
  projectId?: string;
  platform?: CompositionSnapshot['platform'];
}): CompositionSnapshot {
  const configs = opts.credentials.map((cred) => ({
    id: id('cfg'),
    ownerId: opts.userId,
    name: `config for ${cred.kind}`,
    consumer: { kind: 'agent' as const, agentType: opts.agentType },
    credentialId: cred.id,
    settings: {},
    isActive: true,
  }));

  const attachments = configs.map((cfg) => ({
    id: id('att'),
    configurationId: cfg.id,
    consumer: { kind: 'agent' as const, agentType: opts.agentType },
    target: opts.projectId
      ? { scope: 'project' as const, userId: opts.userId, projectId: opts.projectId }
      : { scope: 'user' as const, userId: opts.userId },
    isActive: true,
  }));

  return {
    credentials: opts.credentials,
    configurations: configs,
    attachments,
    platform: opts.platform ?? {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E6 — mapResolvedToLegacy: CC resolver output → legacy shape', () => {
  beforeEach(() => { seq = 0; });

  it('api-key credential maps to { credential: apiKey, credentialKind: "api-key" }', () => {
    const userId = 'user-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'anthropic key',
      kind: 'api-key',
      secret: { kind: 'api-key', apiKey: 'sk-ant-123' },
      isActive: true,
    };
    const snap = makeSnapshot({ userId, credentials: [cred], agentType: 'claude-code' });
    const resolved = resolveEnvironment(snap, { kind: 'agent', agentType: 'claude-code' }, { userId });

    expect(resolved).not.toBeNull();
    const legacy = mapResolvedToLegacy(resolved!);
    expect(legacy).toEqual({
      credential: 'sk-ant-123',
      credentialKind: 'api-key',
      credentialSource: 'user',
    });
  });

  it('oauth-token credential maps to { credential: token, credentialKind: "oauth-token" }', () => {
    const userId = 'user-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'oauth',
      kind: 'oauth-token',
      secret: { kind: 'oauth-token', token: 'gho_abc123' },
      isActive: true,
    };
    const snap = makeSnapshot({ userId, credentials: [cred], agentType: 'claude-code' });
    const resolved = resolveEnvironment(snap, { kind: 'agent', agentType: 'claude-code' }, { userId });

    const legacy = mapResolvedToLegacy(resolved!);
    expect(legacy).toEqual({
      credential: 'gho_abc123',
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });
  });

  it('auth-json credential maps to credentialKind "oauth-token" for auth-file injection', () => {
    const userId = 'user-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'codex auth',
      kind: 'auth-json',
      secret: { kind: 'auth-json', authJson: '{"token":"abc"}' },
      isActive: true,
    };
    const snap = makeSnapshot({ userId, credentials: [cred], agentType: 'codex' });
    const resolved = resolveEnvironment(snap, { kind: 'agent', agentType: 'codex' }, { userId });

    const legacy = mapResolvedToLegacy(resolved!);
    expect(legacy).toEqual({
      credential: '{"token":"abc"}',
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });
  });

  it('openai-compatible credential maps to credentialKind "api-key"', () => {
    const userId = 'user-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'openai-compat',
      kind: 'openai-compatible',
      secret: { kind: 'openai-compatible', apiKey: 'sk-oai-xyz', baseUrl: 'https://api.example.com/v1' },
      isActive: true,
    };
    const snap = makeSnapshot({ userId, credentials: [cred], agentType: 'opencode' });
    const resolved = resolveEnvironment(snap, { kind: 'agent', agentType: 'opencode' }, { userId });

    const legacy = mapResolvedToLegacy(resolved!);
    expect(legacy).toEqual({
      credential: 'sk-oai-xyz',
      credentialKind: 'api-key',
      credentialSource: 'user',
    });
  });

  it('cloud-provider credential returns null for agent consumers', () => {
    const userId = 'user-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'hetzner',
      kind: 'cloud-provider',
      secret: { kind: 'cloud-provider', provider: 'hetzner', token: 'hetzner-tok' },
      isActive: true,
    };
    // Attach as compute consumer but resolve as agent — shouldn't match
    // (resolver won't match consumer kind mismatch, so this just tests null path)
    const resolved: ResolvedEnvironment = {
      credential: cred,
      source: 'user-attachment',
      configuration: null as never,
    };
    const legacy = mapResolvedToLegacy(resolved);
    expect(legacy).toBeNull();
  });

  it('platform-proxy source returns null (no raw credential)', () => {
    const resolved: ResolvedEnvironment = {
      credential: null as never,
      source: 'platform-proxy',
      configuration: null as never,
    };
    const legacy = mapResolvedToLegacy(resolved);
    expect(legacy).toBeNull();
  });
});

describe('E6 — mapSourceToLegacy: ResolutionSource → CredentialSource', () => {
  const cases: Array<[string, LegacyCredentialSource]> = [
    ['project-attachment', 'project'],
    ['user-attachment', 'user'],
    ['platform', 'platform'],
    ['platform-proxy', 'platform'],
  ];

  for (const [source, expected] of cases) {
    it(`"${source}" → "${expected}"`, () => {
      expect(mapSourceToLegacy(source)).toBe(expected);
    });
  }
});

describe('E6 — project-scoped resolution maps to credentialSource "project"', () => {
  it('project-attached credential → credentialSource "project"', () => {
    seq = 0;
    const userId = 'user-1';
    const projectId = 'proj-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'project key',
      kind: 'api-key',
      secret: { kind: 'api-key', apiKey: 'sk-proj-key' },
      isActive: true,
    };
    const snap = makeSnapshot({ userId, credentials: [cred], agentType: 'claude-code', projectId });
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'claude-code' },
      { userId, projectId },
    );

    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('project-attachment');
    const legacy = mapResolvedToLegacy(resolved!);
    expect(legacy!.credentialSource).toBe('project');
  });
});

describe('E6 — Rule 28: inactive project-scoped attachment halts CC resolution', () => {
  it('inactive project attachment returns null (does NOT fall through to user-scoped)', () => {
    seq = 0;
    const userId = 'user-1';
    const projectId = 'proj-1';

    // Active user-scoped credential that should NOT be reached
    const userCred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'user key',
      kind: 'api-key',
      secret: { kind: 'api-key', apiKey: 'sk-user-key' },
      isActive: true,
    };

    // Project-scoped credential (also active, but attachment is inactive)
    const projCred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'project key',
      kind: 'api-key',
      secret: { kind: 'api-key', apiKey: 'sk-proj-key' },
      isActive: true,
    };

    const userCfg = {
      id: id('cfg'),
      ownerId: userId,
      name: 'user config',
      consumer: { kind: 'agent' as const, agentType: 'claude-code' },
      credentialId: userCred.id,
      settings: {},
      isActive: true,
    };
    const projCfg = {
      id: id('cfg'),
      ownerId: userId,
      name: 'project config',
      consumer: { kind: 'agent' as const, agentType: 'claude-code' },
      credentialId: projCred.id,
      settings: {},
      isActive: true,
    };

    const userAtt = {
      id: id('att'),
      configurationId: userCfg.id,
      consumer: { kind: 'agent' as const, agentType: 'claude-code' },
      target: { scope: 'user' as const, userId },
      isActive: true,
    };
    // INACTIVE project attachment — Rule 28 says this halts the chain
    const projAtt = {
      id: id('att'),
      configurationId: projCfg.id,
      consumer: { kind: 'agent' as const, agentType: 'claude-code' },
      target: { scope: 'project' as const, userId, projectId },
      isActive: false,
    };

    const snap: CompositionSnapshot = {
      credentials: [userCred, projCred],
      configurations: [userCfg, projCfg],
      attachments: [userAtt, projAtt],
      platform: {},
    };

    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'claude-code' },
      { userId, projectId },
    );

    // Rule 28: inactive project attachment HALTS — returns null, does NOT
    // fall through to the active user-scoped attachment
    expect(resolved).toBeNull();
  });

  it('active project attachment resolves normally', () => {
    seq = 0;
    const userId = 'user-1';
    const projectId = 'proj-1';

    const projCred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'project key',
      kind: 'api-key',
      secret: { kind: 'api-key', apiKey: 'sk-proj-active' },
      isActive: true,
    };
    const snap = makeSnapshot({ userId, credentials: [projCred], agentType: 'claude-code', projectId });
    const resolved = resolveEnvironment(
      snap,
      { kind: 'agent', agentType: 'claude-code' },
      { userId, projectId },
    );

    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('project-attachment');
    const legacy = mapResolvedToLegacy(resolved!);
    expect(legacy).not.toBeNull();
    expect(legacy!.credential).toBe('sk-proj-active');
  });
});

describe('E6 — compute assembler output compatible with buildProviderConfig', () => {
  it('hetzner compute credential produces token string for buildProviderConfig', () => {
    seq = 0;
    const userId = 'user-1';
    const cred: Credential = {
      id: id('cred'),
      ownerId: userId,
      name: 'hetzner cloud',
      kind: 'cloud-provider',
      secret: { kind: 'cloud-provider', provider: 'hetzner', token: 'hetzner-api-tok-123' },
      isActive: true,
    };
    const cfg = {
      id: id('cfg'),
      ownerId: userId,
      name: 'hetzner compute',
      consumer: { kind: 'compute' as const, provider: 'hetzner' },
      credentialId: cred.id,
      settings: {},
      isActive: true,
    };
    const att = {
      id: id('att'),
      configurationId: cfg.id,
      consumer: { kind: 'compute' as const, provider: 'hetzner' },
      target: { scope: 'user' as const, userId },
      isActive: true,
    };
    const snap: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [att],
      platform: {},
    };

    const resolved = resolveEnvironment(
      snap,
      { kind: 'compute', provider: 'hetzner' },
      { userId },
    );
    expect(resolved).not.toBeNull();

    const assembled = computeAssembler.assemble(resolved!);
    expect(assembled).not.toBeNull();
    expect(assembled!.token).toBe('hetzner-api-tok-123');
    expect(assembled!.isPlatform).toBe(false);
  });
});
