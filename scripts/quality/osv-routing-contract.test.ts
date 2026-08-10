import { describe, expect, it } from 'vitest';

import { createPrivateFollowUpRequest } from './run-osv-advisory';

const completeEnvironment = {
  GITHUB_REPOSITORY: 'owner/repository',
  GITHUB_RUN_ID: '1001',
  GITHUB_SHA: 'a'.repeat(40),
  SAM_OSV_WEBHOOK_TOKEN: 'synthetic-token',
  SAM_OSV_WEBHOOK_URL: 'https://example.com/private-follow-up',
};

describe('private OSV routing contract', () => {
  it('fails closed when either private-routing secret is missing', () => {
    expect(() =>
      createPrivateFollowUpRequest(1, {
        ...completeEnvironment,
        SAM_OSV_WEBHOOK_URL: undefined,
      })
    ).toThrow('Private SAM OSV routing is not configured.');
    expect(() =>
      createPrivateFollowUpRequest(1, {
        ...completeEnvironment,
        SAM_OSV_WEBHOOK_TOKEN: undefined,
      })
    ).toThrow('Private SAM OSV routing is not configured.');
  });

  it('creates the exact authenticated, summary-only request', () => {
    const request = createPrivateFollowUpRequest(2, completeEnvironment);

    expect(request.url.toString()).toBe('https://example.com/private-follow-up');
    expect(request.headers).toEqual({
      Authorization: 'Bearer synthetic-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': `osv-${'a'.repeat(40)}-1001`,
    });
    expect(JSON.parse(request.body)).toEqual({
      findingCount: 2,
      owner: 'security',
      repository: 'owner/repository',
      revision: 'a'.repeat(40),
      source: 'scheduled-osv',
      summary: 'Create or update owned private SAM backlog follow-up for the scheduled OSV scan.',
    });
    expect(request.body).not.toContain('synthetic-token');
    expect(request.body).not.toContain('GHSA-private-detail');
  });
});
