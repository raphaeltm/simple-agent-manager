import { describe, expect, it } from 'vitest';
import { extractOsvIgnores, validateOsvPolicy } from './check-osv-policy';

const now = new Date('2026-08-09T00:00:00Z');

describe('OSV policy validator', () => {
  it('does not redden unrelated pull requests', () => {
    const result = validateOsvPolicy(
      {
        eventName: 'pull_request',
        hasPrivateBacklogRouting: false,
        ignores: [{ id: 'GHSA-test', expires: '2020-01-01', reason: '' }],
      },
      now
    );

    expect(result).toEqual({ ok: true, errors: [], advisoryRun: false });
  });

  it('requires private SAM/backlog routing for scheduled advisory follow-up', () => {
    const result = validateOsvPolicy(
      {
        eventName: 'schedule',
        schedule: '0 4 * * *',
        hasPrivateBacklogRouting: false,
        ignores: [],
      },
      now
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Scheduled OSV advisory follow-up requires private SAM/backlog routing.'
    );
  });

  it('requires every ignore to have reason and future expiry', () => {
    const result = validateOsvPolicy(
      {
        eventName: 'schedule',
        hasPrivateBacklogRouting: true,
        ignores: [
          { id: 'GHSA-expired', reason: 'Awaiting upstream patch.', expires: '2026-01-01' },
          { id: 'GHSA-missing-reason', expires: '2026-09-01' },
        ],
      },
      now
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'OSV ignore GHSA-expired requires a future expiry.',
      'OSV ignore GHSA-missing-reason requires a reason.',
    ]);
  });

  it('extracts vulnerability and package overrides for the same expiry policy', () => {
    expect(
      extractOsvIgnores(`
        [[IgnoredVulns]]
        id = "GHSA-example"
        reason = "Awaiting an upstream fix."
        ignoreUntil = "2026-09-01"

        [[PackageOverrides]]
        name = "example-package"
        vulnerability.ignore = true
        reason = "Not reachable in production."
        effectiveUntil = "2026-09-02"
      `)
    ).toEqual([
      {
        id: 'GHSA-example',
        reason: 'Awaiting an upstream fix.',
        expires: '2026-09-01',
      },
      {
        id: 'example-package',
        reason: 'Not reachable in production.',
        expires: '2026-09-02',
      },
    ]);
  });
});
