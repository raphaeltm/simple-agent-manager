/**
 * EXPERIMENT (E3) — migration backfill dry-run.
 *
 * Proves the pathway from today's single-table credential model into the E2
 * three-primitive model is deterministic and NON-DESTRUCTIVE: every source row
 * fans out into Credential + Configuration + Attachment without changing the
 * runtime resolution decision.
 *
 * The load-bearing assertions:
 *   1. Fan-out shape  — N rows → N configs → N attachments.
 *   2. Secret dedup   — identical secrets collapse to ONE Credential (the
 *                       decoupling), while per-consumer Configurations stay wired.
 *   3. Rule 28        — an inactive project row becomes an inactive project
 *                       Attachment; the E2 resolver HALTS on it (no fall-through).
 *   4. Platform rows  — become PlatformDefaults keyed by consumer.
 *   5. Round-trip     — feeding the backfilled snapshot into resolveEnvironment
 *                       reproduces the OLD resolver's decision for a matrix.
 *   6. No silent drops — malformed rows are reported in `skipped`.
 */

import { describe, expect, it } from 'vitest';

import {
  backfill,
  mapKind,
  type SourceCredentialRow,
  type SourcePlatformRow,
} from '../../src/composable-credentials/backfill';
import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type { ResolutionSource } from '../../src/composable-credentials/types';

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function agentRow(over: Partial<SourceCredentialRow> = {}): SourceCredentialRow {
  return {
    id: id('row'),
    userId: 'user-1',
    projectId: null,
    credentialType: 'agent-api-key',
    agentType: 'claude-code',
    provider: 'anthropic',
    credentialKind: 'api-key',
    isActive: true,
    secretFingerprint: id('secret'),
    ...over,
  };
}

function cloudRow(over: Partial<SourceCredentialRow> = {}): SourceCredentialRow {
  return {
    id: id('row'),
    userId: 'user-1',
    projectId: null,
    credentialType: 'cloud-provider',
    agentType: null,
    provider: 'hetzner',
    credentialKind: 'api-key',
    isActive: true,
    secretFingerprint: id('secret'),
    ...over,
  };
}

function platformAgentRow(over: Partial<SourcePlatformRow> = {}): SourcePlatformRow {
  return {
    id: id('plat'),
    credentialType: 'agent-api-key',
    agentType: 'claude-code',
    provider: null,
    credentialKind: 'api-key',
    isEnabled: true,
    secretFingerprint: id('psecret'),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Fan-out shape
// ---------------------------------------------------------------------------

describe('E3 backfill — fan-out shape', () => {
  it('maps N agent rows to N credentials, configs, and user attachments', () => {
    const rows = [
      agentRow({ agentType: 'claude-code' }),
      agentRow({ agentType: 'openai-codex', credentialKind: 'oauth-token' }),
      agentRow({ agentType: 'amp' }),
    ];
    const { report, snapshot } = backfill(rows, []);

    expect(report.sourceCredentialRows).toBe(3);
    expect(report.producedCredentials).toBe(3);
    expect(report.producedConfigurations).toBe(3);
    expect(report.producedAttachments).toBe(3);
    expect(snapshot.attachments.every((a) => a.target.scope === 'user')).toBe(true);
    expect(report.skipped).toEqual([]);
  });

  it('maps a cloud-provider row to a compute consumer', () => {
    const { snapshot } = backfill([cloudRow({ provider: 'scaleway' })], []);
    expect(snapshot.configurations[0].consumer).toEqual({ kind: 'compute', provider: 'scaleway' });
    expect(snapshot.credentials[0].kind).toBe('cloud-provider');
  });
});

// ---------------------------------------------------------------------------
// 2. Secret dedup — the decoupling
// ---------------------------------------------------------------------------

describe('E3 backfill — secret dedup', () => {
  it('collapses identical secrets into ONE credential, keeps both configurations', () => {
    // One OpenAI auth.json feeding BOTH Codex and OpenCode — same fingerprint.
    const shared = 'shared-openai-secret';
    const rows = [
      agentRow({ agentType: 'openai-codex', secretFingerprint: shared }),
      agentRow({ agentType: 'opencode', secretFingerprint: shared }),
    ];
    const { report, snapshot } = backfill(rows, []);

    expect(report.producedCredentials).toBe(1); // deduped
    expect(report.producedConfigurations).toBe(2); // still two consumers
    expect(report.sharedSecretGroups).toBe(1);
    // Both configurations point at the same credential id.
    const credIds = new Set(snapshot.configurations.map((c) => c.credentialId));
    expect(credIds.size).toBe(1);
  });

  it('does NOT dedup identical fingerprints across different users', () => {
    const fp = 'same-bytes-different-owner';
    const rows = [
      agentRow({ userId: 'user-a', secretFingerprint: fp }),
      agentRow({ userId: 'user-b', secretFingerprint: fp }),
    ];
    const { report } = backfill(rows, []);
    expect(report.producedCredentials).toBe(2);
    expect(report.sharedSecretGroups).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Rule 28 — inactive project row halts (no fall-through)
// ---------------------------------------------------------------------------

describe('E3 backfill — Rule 28 preserved through migration', () => {
  it('an inactive project row becomes an inactive project attachment that HALTS', () => {
    const rows = [
      // active user default for claude-code
      agentRow({ id: 'user-row', agentType: 'claude-code', projectId: null, isActive: true }),
      // INACTIVE project override for the SAME consumer
      agentRow({
        id: 'proj-row',
        agentType: 'claude-code',
        projectId: 'proj-1',
        isActive: false,
        secretFingerprint: 'proj-secret',
      }),
    ];
    const { report, snapshot } = backfill(rows, []);

    expect(report.inactiveProjectRows).toBe(1);
    const projAtt = snapshot.attachments.find((a) => a.target.scope === 'project');
    expect(projAtt?.isActive).toBe(false);

    // Resolve in the project context — must HALT (null), NOT fall through to the
    // active user default. This is the exact getDecryptedAgentKey() invariant.
    const resolved = resolveEnvironment(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      { userId: 'user-1', projectId: 'proj-1' },
    );
    expect(resolved).toBeNull();

    // Resolving WITHOUT the project context still uses the user default.
    const userResolved = resolveEnvironment(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      { userId: 'user-1' },
    );
    expect(userResolved?.source).toBe('user-attachment');
  });
});

// ---------------------------------------------------------------------------
// 4. Platform rows → PlatformDefaults
// ---------------------------------------------------------------------------

describe('E3 backfill — platform defaults', () => {
  it('registers enabled platform rows as defaults; skips disabled ones', () => {
    const platform = [
      platformAgentRow({ agentType: 'claude-code', isEnabled: true }),
      platformAgentRow({ credentialType: 'cloud-provider', agentType: null, provider: 'hetzner' }),
      platformAgentRow({ agentType: 'openai-codex', isEnabled: false }),
    ];
    const { report, snapshot } = backfill([], platform);

    expect(report.producedPlatformDefaults).toBe(2);
    expect(snapshot.platform['agent:claude-code']).toEqual({
      mode: 'credential',
      credential: expect.objectContaining({ ownerId: '__platform__' }),
    });
    expect(snapshot.platform['compute:hetzner']).toBeDefined();
    expect(snapshot.platform['agent:openai-codex']).toBeUndefined();
  });

  it('a user with no attachment falls through to the platform default', () => {
    const { snapshot } = backfill([], [platformAgentRow({ agentType: 'claude-code' })]);
    const resolved = resolveEnvironment(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      { userId: 'user-1' },
    );
    expect(resolved?.source).toBe('platform');
  });
});

// ---------------------------------------------------------------------------
// 5. Round-trip parity vs the old resolver decision
// ---------------------------------------------------------------------------

type OldDecision = 'project' | 'user' | 'platform' | null;

/** Reference oracle mirroring getDecryptedAgentKey() precedence + Rule 28. */
function oldResolver(
  rows: SourceCredentialRow[],
  hasPlatform: boolean,
  ctx: { userId: string; projectId?: string },
): OldDecision {
  if (ctx.projectId) {
    const proj = rows.find(
      (r) => r.projectId === ctx.projectId && r.userId === ctx.userId,
    );
    if (proj) return proj.isActive ? 'project' : null; // Rule 28 halt
  }
  const user = rows.find((r) => r.projectId === null && r.userId === ctx.userId && r.isActive);
  if (user) return 'user';
  return hasPlatform ? 'platform' : null;
}

function newToOld(source: ResolutionSource | null | undefined): OldDecision {
  switch (source) {
    case 'project-attachment':
      return 'project';
    case 'user-attachment':
      return 'user';
    case 'platform':
      return 'platform';
    default:
      return null;
  }
}

describe('E3 backfill — round-trip parity', () => {
  const scenarios: {
    name: string;
    rows: SourceCredentialRow[];
    hasPlatform: boolean;
    ctx: { userId: string; projectId?: string };
  }[] = [
    {
      name: 'user default only, no project',
      rows: [agentRow({ projectId: null, isActive: true })],
      hasPlatform: false,
      ctx: { userId: 'user-1' },
    },
    {
      name: 'active project override wins',
      rows: [
        agentRow({ projectId: null, isActive: true }),
        agentRow({ projectId: 'proj-1', isActive: true, secretFingerprint: 'p' }),
      ],
      hasPlatform: false,
      ctx: { userId: 'user-1', projectId: 'proj-1' },
    },
    {
      name: 'inactive project override HALTS (Rule 28)',
      rows: [
        agentRow({ projectId: null, isActive: true }),
        agentRow({ projectId: 'proj-1', isActive: false, secretFingerprint: 'p' }),
      ],
      hasPlatform: true,
      ctx: { userId: 'user-1', projectId: 'proj-1' },
    },
    {
      name: 'no user row, platform fallback',
      rows: [],
      hasPlatform: true,
      ctx: { userId: 'user-1' },
    },
    {
      name: 'nothing matches',
      rows: [],
      hasPlatform: false,
      ctx: { userId: 'user-1' },
    },
    {
      name: 'inactive user row is invisible, falls to platform',
      rows: [agentRow({ projectId: null, isActive: false })],
      hasPlatform: true,
      ctx: { userId: 'user-1' },
    },
  ];

  for (const s of scenarios) {
    it(`reproduces the old decision: ${s.name}`, () => {
      const platform = s.hasPlatform ? [platformAgentRow({ agentType: 'claude-code' })] : [];
      const { snapshot } = backfill(s.rows, platform);
      const resolved = resolveEnvironment(
        snapshot,
        { kind: 'agent', agentType: 'claude-code' },
        s.ctx,
      );
      expect(newToOld(resolved?.source ?? null)).toBe(oldResolver(s.rows, s.hasPlatform, s.ctx));
    });
  }
});

// ---------------------------------------------------------------------------
// 6. No silent drops
// ---------------------------------------------------------------------------

describe('E3 backfill — malformed rows reported, never dropped silently', () => {
  it('reports an agent row missing agent_type', () => {
    const { report } = backfill([agentRow({ agentType: null })], []);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toMatch(/agent_type/);
  });

  it('reports a platform row missing both provider and agent_type', () => {
    const { report } = backfill(
      [],
      [platformAgentRow({ credentialType: 'cloud-provider', agentType: null, provider: null })],
    );
    expect(report.skipped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// kind mapping unit
// ---------------------------------------------------------------------------

describe('E3 backfill — mapKind', () => {
  it('maps today kinds to E2 kinds', () => {
    expect(mapKind('agent-api-key', 'api-key')).toBe('api-key');
    expect(mapKind('agent-api-key', 'oauth-token')).toBe('oauth-token');
    expect(mapKind('cloud-provider', 'api-key')).toBe('cloud-provider');
  });
});
