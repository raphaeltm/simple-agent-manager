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
    );
    expect(result.status).toBe('connected');
    expect(result.label).toBe('SAM');
  });

  it('SAM provider takes precedence over active credential (platform-level fallback)', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ fallbackCredentialSource: 'platform-sam' }),
      [{ agentType: 'claude-code', credentialKind: 'api-key', isActive: true, label: 'My Key' }],
    );
    // SAM is checked before credentials in priority order
    expect(result.status).toBe('connected');
    expect(result.label).toBe('SAM');
  });

  it('returns Not Configured when no fallback and no credentials', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ fallbackCredentialSource: null }),
      [],
    );
    expect(result.status).toBe('disconnected');
    expect(result.label).toBe('Not Configured');
  });

  it('returns the active credential label when one exists', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ id: 'opencode', fallbackCredentialSource: null }),
      [{ agentType: 'opencode', credentialKind: 'api-key', isActive: true, label: 'My Key' }],
    );
    expect(result.status).toBe('connected');
    expect(result.label).toBe('My Key');
  });

  it('returns Not Configured for OpenCode without a credential', () => {
    const result = getAgentConnectionSummary(
      makeAgent({ id: 'opencode', fallbackCredentialSource: null }),
      [],
    );
    expect(result.status).toBe('disconnected');
    expect(result.label).toBe('Not Configured');
  });
});
