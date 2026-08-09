import { describe, expect, it } from 'vitest';

import { countOsvVulnerabilities } from './run-osv-advisory';

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

  it('treats malformed and empty report branches as no findings', () => {
    expect(countOsvVulnerabilities(null)).toBe(0);
    expect(countOsvVulnerabilities({ results: [] })).toBe(0);
  });
});
