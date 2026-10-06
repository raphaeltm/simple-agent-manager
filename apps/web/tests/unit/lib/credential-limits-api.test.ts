import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../../../src/lib/api/client', () => ({
  request: (...args: unknown[]) => request(...args),
}));

import {
  getMyCredentialLimits,
  getProjectCredentialLimits,
  normalizeCredentialLimitsResponse,
} from '../../../src/lib/api/credential-limits';

const validCredential = {
  credentialReference: 'cc_credentials:cred-1',
  credentialId: 'cred-1',
  credentialSource: 'user',
  provider: 'openai',
  providerMode: 'direct',
  agentType: 'openai-codex',
  level: 'ok',
  observedAt: 1_700_000_000_000,
  windows: [
    {
      windowType: 'codex.primary',
      provider: 'openai',
      source: 'vm-agent.codex_rollout',
      status: 'allowed',
      level: 'ok',
      utilizationPercent: 65,
      limitAmount: null,
      remainingAmount: null,
      windowMinutes: 10080,
      resetsAt: null,
      observedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ],
};

describe('credential limits API boundary', () => {
  beforeEach(() => request.mockReset());

  // The session tool-rail Playwright audit answers unknown API paths with `{}`;
  // before this normalizer that crashed the whole chat page ("Cannot read
  // properties of undefined (reading '0')").
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string body', 'nope'],
    ['credentials that is not an array', { credentials: 'x', generatedAt: 1 }],
  ])('turns %s into an empty credential list', (_label, raw) => {
    const normalized = normalizeCredentialLimitsResponse(raw);
    expect(normalized.credentials).toEqual([]);
    expect(typeof normalized.generatedAt).toBe('number');
  });

  it('keeps well-formed credentials and drops malformed ones', () => {
    const normalized = normalizeCredentialLimitsResponse({
      credentials: [
        validCredential,
        { credentialReference: 'cc_credentials:no-windows' },
        42,
        null,
      ],
      generatedAt: 123,
    });
    expect(normalized).toEqual({ credentials: [validCredential], generatedAt: 123 });
  });

  it('getProjectCredentialLimits requests the session-scoped route and normalizes the body', async () => {
    request.mockResolvedValueOnce({});
    await expect(getProjectCredentialLimits('proj-1', { agentSessionId: 'as 1' })).resolves.toEqual(
      expect.objectContaining({ credentials: [] })
    );
    expect(request).toHaveBeenCalledWith(
      '/api/projects/proj-1/credential-limits?agentSessionId=as%201'
    );
  });

  it('getMyCredentialLimits passes a valid body through', async () => {
    request.mockResolvedValueOnce({ credentials: [validCredential], generatedAt: 5 });
    await expect(getMyCredentialLimits()).resolves.toEqual({
      credentials: [validCredential],
      generatedAt: 5,
    });
    expect(request).toHaveBeenCalledWith('/api/credentials/limits');
  });
});
