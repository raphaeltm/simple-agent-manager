import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DEFAULT_HOSTED_GIT_LIMITS } from '../../../src/selfhost/hosted-git/limits';
import { withGitWorkBudget } from '../../../src/vendor/dgit/git/budget';
import { validatePush } from '../../../src/vendor/dgit/git/protocol';
import type { GitStore } from '../../../src/vendor/dgit/git/store';

/**
 * The connectivity walk's per-push failure memo, counted at the object-store boundary.
 * The real-git suite (tests/hosted-git) proves admission end to end; these tests drive
 * validatePush past every count in the path (rule 81) and measure how much it reads.
 */
const ZERO = '0'.repeat(40);
const oidOf = (label: string) => createHash('sha1').update(label).digest('hex');
const enc = new TextEncoder();
const SIG = 'Test <test@example.com> 0 +0000';

type Obj = { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Uint8Array };

/** A fake object store over a map, counting every presence probe and object read. */
function fakeStore(objects: Map<string, Obj>) {
  const counts = { probes: 0, reads: 0 };
  const store = {
    getMeta: () => null,
    reachableVersion: () => 'v',
    refs: () => [],
    resolveHead: () => null,
    getRef: () => null,
    getPeeled: () => null,
    typeAndSize: (oid: string) => {
      counts.probes += 1;
      const obj = objects.get(oid);
      return obj ? { type: obj.type, size: obj.data.length } : null;
    },
    get: async (oid: string) => {
      counts.reads += 1;
      return objects.get(oid) ?? null;
    },
  } as unknown as GitStore;
  return { store, counts };
}

/**
 * A linear history c1..cN sharing one tree. `missingTree` points the ROOT commit at an absent
 * tree, so a walk from the tip must cross the whole history before it fails.
 */
function chain(
  length: number,
  opts: { missingTree?: boolean; brokenRoot?: boolean; label?: string } = {}
) {
  const objects = new Map<string, Obj>();
  const blob = oidOf('blob');
  objects.set(blob, { type: 'blob', data: enc.encode('hello\n') });
  const tree = oidOf('tree');
  const entry = new Uint8Array([...enc.encode('100644 a.txt\0'), ...Buffer.from(blob, 'hex')]);
  objects.set(tree, { type: 'tree', data: entry });
  const commits: string[] = [];
  for (let i = 1; i <= length; i++) {
    const oid = oidOf(`${opts.label ?? 'commit'}-${i}`);
    const parent = commits.length ? `parent ${commits[commits.length - 1]}\n` : '';
    const rootTree = i === 1 && opts.missingTree ? oidOf('absent-tree') : tree;
    const header = i === 1 && opts.brokenRoot ? '' : `tree ${rootTree}\n`;
    const text = `${header}${parent}author ${SIG}\ncommitter ${SIG}\n\nc${i}\n`;
    objects.set(oid, { type: 'commit', data: enc.encode(text) });
    commits.push(oid);
  }
  return { objects, commits };
}

async function decide(store: GitStore, commands: { old: string; next: string; ref: string }[]) {
  return withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () => validatePush(store, commands, null));
}

const N = 1201; // history longer than any internal batch, not a multiple of 2
const K = 2001; // commands, more than the commit count

describe('validatePush closure walk', () => {
  it('rejects many commands at one broken tip after walking the history once', async () => {
    const { objects, commits } = chain(N, { missingTree: true });
    const { store, counts } = fakeStore(objects);
    const tip = commits[commits.length - 1]!;
    const commands = Array.from({ length: K }, (_, i) => ({
      old: ZERO,
      next: tip,
      ref: `refs/heads/b${i}`,
    }));
    const plan = await decide(store, commands);
    expect(plan.decisions).toHaveLength(K);
    for (const d of plan.decisions) expect(d.reject).toBe('missing necessary objects');
    // One full walk (N commits, a type probe for each commit's edge to the shared tree, the
    // tree and blob, the absent tree) plus one branch type probe per command; every later
    // command stops at its tip, which that walk recorded as failed. Unmemoized: about K x N.
    expect(counts.probes).toBeLessThanOrEqual(2 * N + 3 + K);
    expect(counts.reads).toBeLessThanOrEqual(N + 1);
  });

  it('rejects commands at every commit of a broken history without re-walking it', async () => {
    const { objects, commits } = chain(N, { missingTree: true });
    const { store, counts } = fakeStore(objects);
    // Oldest first: each tip's walk reaches its parent, which an earlier command proved broken.
    // Unmemoized, command i re-walks i commits: about N^2 / 2 reads.
    const commands = commits.map((next, i) => ({ old: ZERO, next, ref: `refs/heads/c${i}` }));
    const plan = await decide(store, commands);
    for (const d of plan.decisions) expect(d.reject).toBe('missing necessary objects');
    expect(counts.probes).toBeLessThanOrEqual(5 * N);
    expect(counts.reads).toBeLessThanOrEqual(2 * N);
  });

  it('rejects a commit that does not parse instead of failing the whole push', async () => {
    const { objects, commits } = chain(3, { brokenRoot: true });
    const good = chain(2, { label: 'good' });
    for (const [oid, obj] of good.objects) objects.set(oid, obj);
    const { store } = fakeStore(objects);
    const plan = await decide(store, [
      { old: ZERO, next: commits[2]!, ref: 'refs/heads/broken' },
      { old: ZERO, next: good.commits[1]!, ref: 'refs/heads/good' },
    ]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
    expect(plan.decisions[1]).toMatchObject({ set: good.commits[1] });
  });

  it('accepts a complete history and every commit in it (positive control)', async () => {
    const { objects, commits } = chain(N);
    const { store, counts } = fakeStore(objects);
    const commands = [...commits]
      .reverse()
      .map((next, i) => ({ old: ZERO, next, ref: `refs/heads/ok${i}` }));
    const plan = await decide(store, commands);
    for (const [i, d] of plan.decisions.entries())
      expect(d).toMatchObject({ set: commands[i]!.next });
    // The first command proves the whole history; later commands stop at their own tip.
    expect(counts.reads).toBeLessThanOrEqual(N + 1);
    expect(plan.known.hasHex(commits[0]!)).toBe(true);
  });
});
