import { describe, expect, it } from 'vitest';

import { canonicalProjectPullRequestUrl } from '../src/pull-requests';

describe('project pull request URL identity', () => {
  it('normalizes equivalent URLs to one project-scoped key', () => {
    expect(
      canonicalProjectPullRequestUrl('https://github.com/Owner/Repo/pull/0012/', 'owner/repo')
    ).toBe('https://github.com/owner/repo/pull/12');
    expect(
      canonicalProjectPullRequestUrl('https://github.com/owner/repo/pull/12', 'owner/repo')
    ).toBe('https://github.com/owner/repo/pull/12');
  });
  it.each([
    'https://github.com/other/repo/pull/12',
    'https://github.com/owner/repo/pull/12?source=foreign',
    'https://github.com/owner/repo/issues/12',
    'https://github.com@evil.example/owner/repo/pull/12',
  ])('rejects invalid or foreign URL %s', (url) => {
    expect(canonicalProjectPullRequestUrl(url, 'owner/repo')).toBeNull();
  });
});
