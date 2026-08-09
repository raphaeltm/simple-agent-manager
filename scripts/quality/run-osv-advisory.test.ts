import { describe, expect, it } from 'vitest';

import { countOsvVulnerabilities, createPrivateFollowUpRequest } from './run-osv-advisory';

describe('scheduled OSV advisory privacy boundary', () => {
  it('counts findings without exposing package or advisory details', () => {
    const report = {
      results: [
        { packages: [{ vulnerabilities: [{ id: 'private-a' }, { id: 'private-b' }] }] },
        { packages: [{ vulnerabilities: [] }] },
      ],
    };
    expect(countOsvVulnerabilities(report)).toBe(2);
  });

  it('accepts an empty complete report and rejects malformed branches', () => {
    expect(countOsvVulnerabilities({ results: [] })).toBe(0);
    expect(() => countOsvVulnerabilities(null)).toThrow('unexpected report shape');
    expect(() => countOsvVulnerabilities({ results: [{ packages: [{}] }] })).toThrow(
      'unexpected report shape'
    );
    expect(() =>
      countOsvVulnerabilities({ results: [{ packages: [{ vulnerabilities: [{}] }] }] })
    ).toThrow('unexpected report shape');
  });

  it('uses one idempotency key per scheduled run rather than suppressing later scans', () => {
    const environment = {
      GITHUB_REPOSITORY: 'owner/repository',
      GITHUB_RUN_ID: '1001',
      GITHUB_SHA: 'a'.repeat(40),
      SAM_OSV_WEBHOOK_TOKEN: 'synthetic-token',
      SAM_OSV_WEBHOOK_URL: 'https://example.com/private-follow-up',
    };
    const first = createPrivateFollowUpRequest(2, environment);
    const retry = createPrivateFollowUpRequest(2, environment);
    const later = createPrivateFollowUpRequest(2, { ...environment, GITHUB_RUN_ID: '1002' });

    expect(first.headers['Idempotency-Key']).toBe(retry.headers['Idempotency-Key']);
    expect(first.headers['Idempotency-Key']).not.toBe(later.headers['Idempotency-Key']);
    expect(first.body).not.toContain(environment.SAM_OSV_WEBHOOK_TOKEN);
  });

  it('rejects obvious private-network routing targets', () => {
    expect(() =>
      createPrivateFollowUpRequest(1, {
        GITHUB_REPOSITORY: 'owner/repository',
        GITHUB_RUN_ID: '1001',
        GITHUB_SHA: 'a'.repeat(40),
        SAM_OSV_WEBHOOK_TOKEN: 'synthetic-token',
        SAM_OSV_WEBHOOK_URL: 'https://127.0.0.1/private-follow-up',
      })
    ).toThrow('not permitted');
  });
});
