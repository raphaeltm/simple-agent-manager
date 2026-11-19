import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { DEFAULT_HOSTED_GIT_LIMITS } from '../../../src/selfhost/hosted-git/limits';
import { withGitWorkBudget } from '../../../src/vendor/dgit/git/budget';
import { validatePush } from '../../../src/vendor/dgit/git/protocol';
import type { GitStore } from '../../../src/vendor/dgit/git/store';

// Audit every rule in https://git-scm.com/docs/git-check-ref-format. The real smart-HTTP
// suite separately proves the parser/DO/write path with ordinary and nested branch controls.
const invalid = [
  'refs/heads/.hidden/x', 'refs/heads/x/.hidden', 'refs/heads/x.lock/y', 'refs/heads/x.lock',
  'HEAD', '@', 'refs/heads/x y', 'refs/heads/x..y', 'refs/heads/x~y', 'refs/heads/x^y', 'refs/heads/x:y',
  'refs/heads/x?y', 'refs/heads/x*y', 'refs/heads/x[y', '/refs/heads/x', 'refs/heads/x/',
  'refs/heads/x//y', 'refs/heads/x.', 'refs/heads/x@{y', 'refs/heads/x\\y',
  ...Array.from({ length: 33 }, (_, i) => `refs/heads/x${String.fromCharCode(i === 32 ? 127 : i)}y`),
];
const valid = ['refs/heads/normal', 'refs/heads/feature/x', 'refs/tags/v1.0', 'refs/heads/x.lockish/y', 'refs/heads/a.b/c', 'refs/heads/café'];
// The pushed tip is a commit with an empty tree, so valid names reach a `set` decision.
const tip = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const objects: Record<string, { type: string; data: Uint8Array }> = {
  [tip]: { type: 'commit', data: new TextEncoder().encode(`tree ${tree}\n\nmsg\n`) },
  [tree]: { type: 'tree', data: new Uint8Array(0) },
};
const store = {
  getMeta: () => null, reachableVersion: () => '0', refs: () => [], resolveHead: () => null,
  getRef: () => null, getPeeled: () => null,
  typeAndSize: (oid: string) => (objects[oid] ? { type: objects[oid].type, size: 1 } : null),
  get: async (oid: string) => objects[oid] ?? null,
} as unknown as GitStore;
async function decision(ref: string) {
  return withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, async () => {
    const plan = await validatePush(store, [{ old: '0'.repeat(40), next: 'a'.repeat(40), ref }], null);
    return plan.decisions[0];
  });
}
describe('validatePush Git ref-format rules', () => {
  it.each(invalid)('rejects invalid ref %j', async (ref) => {
    // NUL cannot cross an OS argv boundary; the protocol also uses it as the capabilities delimiter.
    if (!ref.includes('\0')) expect(spawnSync('git', ['check-ref-format', ref]).status).not.toBe(0);
    expect(await decision(ref)).toMatchObject({ ref, reject: 'funny refname' });
  });
  it.each(valid)('accepts valid ref %j', async (ref) => {
    expect(spawnSync('git', ['check-ref-format', ref]).status).toBe(0);
    expect(await decision(ref)).toMatchObject({ ref, set: 'a'.repeat(40) });
  });
  it.each(['refs/heads/x<y', 'refs/heads/x>y', 'refs/heads/x&y', 'refs/heads/x`y', 'refs/heads/x"y', "refs/heads/x'y", `refs/heads/${'x'.repeat(256)}`])('keeps SAM conservative safety bound for %j', async (ref) => {
    expect(await decision(ref)).toMatchObject({ reject: 'funny refname' });
  });
});
