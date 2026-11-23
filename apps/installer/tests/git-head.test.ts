import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkedOutCommit } from '../scripts/git-head.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'sam-git-head-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'apps/installer/scripts'), { recursive: true });
  return root;
}
const from = (root: string) => join(root, 'apps/installer/scripts');
describe('reading the checked-out commit without running git', () => {
  it('reads a detached HEAD, as a CI checkout leaves it', () => {
    expect(checkedOutCommit(from(repository({ '.git/HEAD': `${A}\n` })))).toBe(A);
  });
  it('follows a branch to its loose ref', () => {
    const root = repository({
      '.git/HEAD': 'ref: refs/heads/sam/feature\n',
      '.git/refs/heads/sam/feature': `${A}\n`,
      '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/sam/feature\n`,
    });
    expect(checkedOutCommit(from(root))).toBe(A);
  });
  it('falls back to a packed ref', () => {
    const root = repository({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `${B} refs/heads/other\n${A} refs/heads/main\n`,
    });
    expect(checkedOutCommit(from(root))).toBe(A);
  });
  it('resolves a linked worktree through its gitdir and commondir', () => {
    const main = repository({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': `${B}\n`,
      '.git/refs/heads/feature': `${A}\n`,
      '.git/worktrees/tree/HEAD': 'ref: refs/heads/feature\n',
      '.git/worktrees/tree/commondir': '../..\n',
    });
    const worktree = repository({ '.git': `gitdir: ${join(main, '.git/worktrees/tree')}\n` });
    expect(checkedOutCommit(from(worktree))).toBe(A);
  });
  it.each([
    ['no repository', {}],
    ['an unborn branch', { '.git/HEAD': 'ref: refs/heads/main\n' }],
    ['a malformed HEAD', { '.git/HEAD': 'not a commit\n' }],
    ['a ref that tries to leave the git directory', { '.git/HEAD': 'ref: refs/../../secret\n' }],
    ['a short hash', { '.git/HEAD': 'abc1234\n' }],
  ])('returns nothing for %s', (_label, files) => {
    expect(checkedOutCommit(from(repository(files)))).toBe('');
  });
  it('refuses a ref that resolves to a real file outside the git directory', () => {
    // refs/../../secret resolves to <root>/secret, which holds a valid-looking commit.
    const root = repository({ '.git/HEAD': 'ref: refs/../../secret\n', secret: `${A}\n` });
    expect(checkedOutCommit(from(root))).toBe('');
  });
  it('agrees with this checkout', () => {
    expect(checkedOutCommit()).toMatch(/^[a-f0-9]{40}$/);
  });
});
