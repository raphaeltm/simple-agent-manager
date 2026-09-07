/**
 * Unit tests for the composable-credentials backfill mapper.
 *
 * Uses the shared backfill function directly (the API service wraps it
 * with DB reads/writes, which is tested separately).
 */

import {
  backfill,
  type CCSourceCredentialRow,
  type CCSourcePlatformRow,
  mapKind,
} from '@simple-agent-manager/shared';
import { describe, expect,it } from 'vitest';

function makeSourceRow(overrides: Partial<CCSourceCredentialRow>): CCSourceCredentialRow {
  return {
    id: 'row-1',
    userId: 'user-1',
    projectId: null,
    credentialType: 'agent-api-key',
    agentType: 'claude-code',
    provider: 'anthropic',
    credentialKind: 'api-key',
    isActive: true,
    secretFingerprint: 'fp-abc',
    ...overrides,
  };
}

function makePlatformRow(overrides: Partial<CCSourcePlatformRow>): CCSourcePlatformRow {
  return {
    id: 'plat-1',
    credentialType: 'agent-api-key',
    agentType: 'claude-code',
    provider: null,
    credentialKind: 'api-key',
    isEnabled: true,
    secretFingerprint: 'fp-plat-abc',
    ...overrides,
  };
}

describe('backfill mapper', () => {
  it('produces one credential + one configuration + one attachment per source row', () => {
    const result = backfill([makeSourceRow({})], []);

    expect(result.snapshot.credentials).toHaveLength(1);
    expect(result.snapshot.configurations).toHaveLength(1);
    expect(result.snapshot.attachments).toHaveLength(1);
    expect(result.report.producedCredentials).toBe(1);
  });

  it('deduplicates secrets with the same fingerprint', () => {
    const rows = [
      makeSourceRow({ id: 'row-1', agentType: 'claude-code', secretFingerprint: 'same-fp' }),
      makeSourceRow({ id: 'row-2', agentType: 'openai-codex', secretFingerprint: 'same-fp' }),
    ];

    const result = backfill(rows, []);

    // Same fingerprint → 1 credential, but 2 configs + 2 attachments
    expect(result.snapshot.credentials).toHaveLength(1);
    expect(result.snapshot.configurations).toHaveLength(2);
    expect(result.snapshot.attachments).toHaveLength(2);
  });

  it('preserves Rule 28: inactive project row → inactive attachment', () => {
    const row = makeSourceRow({
      projectId: 'proj-1',
      isActive: false,
    });

    const result = backfill([row], []);

    const att = result.snapshot.attachments[0];
    expect(att.isActive).toBe(false);
    expect(att.target.scope).toBe('project');
    expect(result.report.inactiveProjectRows).toBe(1);
  });

  it('active user-scoped row becomes active attachment', () => {
    const row = makeSourceRow({ projectId: null, isActive: true });
    const result = backfill([row], []);

    const att = result.snapshot.attachments[0];
    expect(att.isActive).toBe(true);
    expect(att.target.scope).toBe('user');
  });

  it('handles platform rows', () => {
    const result = backfill([], [makePlatformRow({})]);

    expect(Object.keys(result.snapshot.platform)).toHaveLength(1);
    expect(result.report.producedPlatformDefaults).toBe(1);
  });

  it('skips disabled platform rows', () => {
    const result = backfill([], [makePlatformRow({ isEnabled: false })]);

    expect(Object.keys(result.snapshot.platform)).toHaveLength(0);
  });
});

describe('mapKind', () => {
  it('maps cloud-provider correctly', () => {
    expect(mapKind('cloud-provider', 'api-key')).toBe('cloud-provider');
    expect(mapKind('cloud-provider', 'oauth-token')).toBe('cloud-provider');
  });

  it('maps agent-api-key api-key correctly', () => {
    expect(mapKind('agent-api-key', 'api-key')).toBe('api-key');
  });

  it('maps agent-api-key oauth-token correctly', () => {
    expect(mapKind('agent-api-key', 'oauth-token')).toBe('oauth-token');
  });
});
