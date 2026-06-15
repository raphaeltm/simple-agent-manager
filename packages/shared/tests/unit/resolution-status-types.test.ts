/**
 * Tests for the resolution-status types and the resolver's integration with
 * the resolution-status response shape.
 *
 * Verifies that resolveEnvironment() output maps correctly to the
 * ConsumerResolutionStatus type used by the GET /api/credentials/resolution-status endpoint.
 */
import { describe, expect, it } from 'vitest';

import { resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  Attachment,
  CompositionSnapshot,
  Configuration,
  ConsumerRef,
  ConsumerResolutionStatus,
  Credential,
  ResolutionSource,
} from '../../src/composable-credentials/types';
import { consumerKey } from '../../src/composable-credentials/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-1',
    ownerId: 'user-1',
    name: 'My Anthropic Key',
    kind: 'api-key',
    secret: { kind: 'api-key', apiKey: 'sk-ant-test' },
    isActive: true,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Configuration> = {}): Configuration {
  return {
    id: 'cfg-1',
    ownerId: 'user-1',
    name: 'Claude Code config',
    consumer: { kind: 'agent', agentType: 'claude-code' },
    credentialId: 'cred-1',
    settings: {},
    isActive: true,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    configurationId: 'cfg-1',
    consumer: { kind: 'agent', agentType: 'claude-code' },
    target: { scope: 'user', userId: 'user-1' },
    isActive: true,
    ...overrides,
  };
}

/** Simulate what the resolution-status endpoint does: resolve + map to status. */
function resolveConsumerStatus(
  snapshot: CompositionSnapshot,
  consumer: ConsumerRef,
  consumerId: string,
  consumerKind: 'agent' | 'compute',
  consumerName: string,
  userId: string,
  projectId?: string,
): ConsumerResolutionStatus {
  const ctx = { userId, projectId };
  const resolved = resolveEnvironment(snapshot, consumer, ctx);

  if (resolved) {
    return {
      consumerId,
      consumerKind,
      consumerName,
      source: resolved.source,
      maskedLabel: resolved.credential?.name ?? null,
      halted: false,
    };
  }

  // Check for Rule 28 halt
  if (projectId) {
    const key = consumerKey(consumer);
    const isHalted = snapshot.attachments.some(
      (a) =>
        consumerKey(a.consumer) === key &&
        a.target.scope === 'project' &&
        a.target.userId === userId &&
        'projectId' in a.target &&
        a.target.projectId === projectId &&
        !a.isActive,
    );
    if (isHalted) {
      return {
        consumerId,
        consumerKind,
        consumerName,
        source: 'halted',
        maskedLabel: null,
        halted: true,
      };
    }
  }

  return {
    consumerId,
    consumerKind,
    consumerName,
    source: 'unresolved',
    maskedLabel: null,
    halted: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolution-status mapping', () => {
  it('returns user-attachment source when user has active attachment', () => {
    const cred = makeCredential();
    const cfg = makeConfig();
    const att = makeAttachment();
    const snapshot: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [att],
      platform: {},
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      'claude-code',
      'agent',
      'Claude Code',
      'user-1',
    );

    expect(status.source).toBe('user-attachment');
    expect(status.maskedLabel).toBe('My Anthropic Key');
    expect(status.halted).toBe(false);
  });

  it('returns project-attachment source for project-scoped attachment', () => {
    const cred = makeCredential();
    const cfg = makeConfig();
    const att = makeAttachment({
      target: { scope: 'project', userId: 'user-1', projectId: 'proj-1' },
    });
    const snapshot: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [att],
      platform: {},
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      'claude-code',
      'agent',
      'Claude Code',
      'user-1',
      'proj-1',
    );

    expect(status.source).toBe('project-attachment');
    expect(status.maskedLabel).toBe('My Anthropic Key');
    expect(status.halted).toBe(false);
  });

  it('returns halted when project attachment is inactive (Rule 28)', () => {
    const cred = makeCredential();
    const cfg = makeConfig();
    const att = makeAttachment({
      target: { scope: 'project', userId: 'user-1', projectId: 'proj-1' },
      isActive: false,
    });
    // Also add a user-level attachment that should NOT be used
    const userAtt = makeAttachment({ id: 'att-2' });

    const snapshot: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [att, userAtt],
      platform: {},
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      'claude-code',
      'agent',
      'Claude Code',
      'user-1',
      'proj-1',
    );

    expect(status.source).toBe('halted');
    expect(status.halted).toBe(true);
    expect(status.maskedLabel).toBeNull();
  });

  it('returns platform source when platform default exists', () => {
    const platformCred = makeCredential({ id: 'platform-cred', name: 'Platform Key' });
    const snapshot: CompositionSnapshot = {
      credentials: [platformCred],
      configurations: [],
      attachments: [],
      platform: {
        'agent:claude-code': { mode: 'credential', credential: platformCred },
      },
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      'claude-code',
      'agent',
      'Claude Code',
      'user-1',
    );

    expect(status.source).toBe('platform');
    expect(status.maskedLabel).toBe('Platform Key');
  });

  it('returns platform-proxy source for proxy platform default', () => {
    const snapshot: CompositionSnapshot = {
      credentials: [],
      configurations: [],
      attachments: [],
      platform: {
        'agent:claude-code': { mode: 'proxy' },
      },
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      'claude-code',
      'agent',
      'Claude Code',
      'user-1',
    );

    expect(status.source).toBe('platform-proxy');
    expect(status.maskedLabel).toBeNull();
  });

  it('returns unresolved when no attachment or platform default', () => {
    const snapshot: CompositionSnapshot = {
      credentials: [],
      configurations: [],
      attachments: [],
      platform: {},
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'agent', agentType: 'claude-code' },
      'claude-code',
      'agent',
      'Claude Code',
      'user-1',
    );

    expect(status.source).toBe('unresolved');
    expect(status.maskedLabel).toBeNull();
    expect(status.halted).toBe(false);
  });

  it('handles compute consumers the same way', () => {
    const cred = makeCredential({
      id: 'hetzner-cred',
      name: 'Hetzner Token',
      kind: 'cloud-provider',
      secret: { kind: 'cloud-provider', provider: 'hetzner', token: 'test-token' },
    });
    const cfg = makeConfig({
      id: 'cfg-hetzner',
      consumer: { kind: 'compute', provider: 'hetzner' },
      credentialId: 'hetzner-cred',
    });
    const att = makeAttachment({
      id: 'att-hetzner',
      configurationId: 'cfg-hetzner',
      consumer: { kind: 'compute', provider: 'hetzner' },
    });

    const snapshot: CompositionSnapshot = {
      credentials: [cred],
      configurations: [cfg],
      attachments: [att],
      platform: {},
    };

    const status = resolveConsumerStatus(
      snapshot,
      { kind: 'compute', provider: 'hetzner' },
      'hetzner',
      'compute',
      'Hetzner Cloud',
      'user-1',
    );

    expect(status.source).toBe('user-attachment');
    expect(status.consumerKind).toBe('compute');
    expect(status.maskedLabel).toBe('Hetzner Token');
  });
});
