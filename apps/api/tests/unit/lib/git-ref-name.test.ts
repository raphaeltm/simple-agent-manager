import { describe, expect, it } from 'vitest';

import { isValidGitBranchName, isValidGitRefName } from '../../../src/lib/git-ref-name';

describe('git ref-name admission', () => {
  it.each(['main', 'feature/x', 'sam/fix-123', 'release-2026.11', 'v1.0/hotfix', 'a.b'])(
    'accepts branch %s',
    (branch) => {
      expect(isValidGitBranchName(branch)).toBe(true);
    }
  );

  it.each([
    ['foo.lock', 'a .lock component'],
    ['dir.lock/x', 'an intermediate .lock component'],
    ['.hidden', 'a component starting with a dot'],
    ['x/.hidden', 'a later component starting with a dot'],
    ['a..b', 'two consecutive dots'],
    ['trailing.', 'a trailing dot'],
    ['trailing/', 'a trailing slash'],
    ['a//b', 'an empty component'],
    ['a@{b', 'the @{ sequence'],
    ['has space', 'whitespace'],
    ['a~b', 'a check-ref-format metacharacter'],
    ['', 'an empty name'],
    ['x'.repeat(250), 'more than 255 characters as a full ref'],
  ])('rejects %j (%s)', (branch) => {
    expect(isValidGitBranchName(branch)).toBe(false);
  });

  it('requires a full ref under refs/', () => {
    expect(isValidGitRefName('refs/heads/main')).toBe(true);
    expect(isValidGitRefName('heads/main')).toBe(false);
  });
});
