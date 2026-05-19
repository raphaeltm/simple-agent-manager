/**
 * Tests for getAgentConnectionSummary with platform-sam fallback.
 */
import type { AgentInfo } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { getAgentConnectionSummary } from '../../src/lib/agent-status';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Claude Code agent',
    supportsAcp: false,
    configured: false,
    credentialHelpUrl: null,
    fallbackCredentialSource: null,
    ...overrides,
  };
}

describe('getAgentConnectionSummary', () => {
  it('returns SAM status for platform-sam fallback', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ fallbackCredentialSource: 'platform-sam' }),
      [],
      null,
      'user',
    );
    expect(result.status).toBe('connected');
    expect(result.label).toBe('SAM');
  });

  it('returns SAM for project scope too (platform-sam is scope-independent)', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ fallbackCredentialSource: 'platform-sam' }),
      [],
      null,
      'project',
    );
    expect(result.status).toBe('connected');
    expect(result.label).toBe('SAM');
  });

  it('SAM provider takes precedence over active credential (platform-level fallback)', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ fallbackCredentialSource: 'platform-sam' }),
      [{ agentType: 'claude-code', credentialKind: 'api-key', isActive: true, label: 'My Key' }],
      null,
      'user',
    );
    // SAM is checked before credentials in priority order
    expect(result.status).toBe('connected');
    expect(result.label).toBe('SAM');
  });

  it('returns Not Configured when no fallback and no credentials', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ fallbackCredentialSource: null }),
      [],
      null,
      'user',
    );
    expect(result.status).toBe('disconnected');
    expect(result.label).toBe('Not Configured');
  });
});
