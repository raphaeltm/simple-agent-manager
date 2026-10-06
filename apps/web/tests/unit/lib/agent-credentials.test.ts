import type { AgentCredentialInfo } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { hasAgentCredentials, removeAgentCredentialKind } from '../../../src/lib/agent-credentials';

function credential(overrides: Partial<AgentCredentialInfo>): AgentCredentialInfo {
  return {
    id: 'credential-id',
    agentType: 'claude-code',
    credentialKind: 'api-key',
    maskedKey: 'sk-****abcd',
    isActive: false,
    createdAt: '2026-05-23T00:00:00Z',
    updatedAt: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

describe('agent credential state helpers', () => {
  it('removes only the targeted API key and activates the remaining OAuth token', () => {
    const credentials = [
      credential({ id: 'api-key', credentialKind: 'api-key', isActive: true }),
      credential({
        id: 'oauth-token',
        credentialKind: 'oauth-token',
        maskedKey: 'oauth-****wxyz',
        isActive: false,
      }),
    ];

    const next = removeAgentCredentialKind(credentials, 'claude-code', 'api-key');

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: 'oauth-token',
      credentialKind: 'oauth-token',
      maskedKey: 'oauth-****wxyz',
      isActive: true,
    });
    expect(hasAgentCredentials(next, 'claude-code')).toBe(true);
  });

  it('removes only the targeted OAuth token and leaves the API key active', () => {
    const credentials = [
      credential({ id: 'api-key', credentialKind: 'api-key', isActive: false }),
      credential({
        id: 'oauth-token',
        credentialKind: 'oauth-token',
        maskedKey: 'oauth-****wxyz',
        isActive: true,
      }),
    ];

    const next = removeAgentCredentialKind(credentials, 'claude-code', 'oauth-token');

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: 'api-key',
      credentialKind: 'api-key',
      maskedKey: 'sk-****abcd',
      isActive: true,
    });
    expect(hasAgentCredentials(next, 'claude-code')).toBe(true);
  });

  it('reports no remaining agent credentials after deleting the only kind', () => {
    const next = removeAgentCredentialKind(
      [credential({ id: 'api-key', isActive: true })],
      'claude-code',
      'api-key'
    );

    expect(next).toEqual([]);
    expect(hasAgentCredentials(next, 'claude-code')).toBe(false);
  });
});
