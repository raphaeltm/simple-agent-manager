import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { armHostedGitGcAlarm, GC_DELAY_MS } from '../../../src/selfhost/hosted-git/hosted-git-gc';
import { DEFAULT_HOSTED_GIT_LIMITS } from '../../../src/selfhost/hosted-git/limits';
import { withGitWorkBudget } from '../../../src/vendor/dgit/git/budget';
import { commitPush, validatePush } from '../../../src/vendor/dgit/git/protocol';
import type { GitStore } from '../../../src/vendor/dgit/git/store';

/**
 * Push admission guards from the adversarial review of PR #2907, at the store boundary:
 * ref seeding reads no objects, every walked edge has the type git requires, branches hold
 * only commits, directory/file ref conflicts are refused, and deleting a missing ref is a
 * no-op that queues no GC. tests/hosted-git covers the same guards through real git.
 */
const ZERO = '0'.repeat(40);
const enc = new TextEncoder();
const oidOf = (label: string) => createHash('sha1').update(label).digest('hex');
const SIG = 'Test <test@example.com> 0 +0000';

type Kind = 'commit' | 'tree' | 'blob' | 'tag';
type Obj = { type: Kind; data: Uint8Array };

function treeEntry(mode: string, name: string, oid: string): number[] {
  return [...enc.encode(`${mode} ${name}\0`), ...Buffer.from(oid, 'hex')];
}

class Repo {
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
  reads = 0;

  put(label: string, type: Kind, data: Uint8Array): string {
    const oid = oidOf(label);
    this.objects.set(oid, { type, data });
    return oid;
  }
  blob(label: string) {
    return this.put(label, 'blob', enc.encode(`${label}\n`));
  }
  tree(label: string, entries: number[][]) {
    return this.put(label, 'tree', new Uint8Array(entries.flat()));
  }
  commit(label: string, tree: string, parents: string[] = []) {
    const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${SIG}\ncommitter ${SIG}\n\n${label}\n`;
    return this.put(label, 'commit', enc.encode(text));
  }
  tag(label: string, object: string, type: string) {
    return this.put(label, 'tag', enc.encode(`object ${object}\ntype ${type}\ntag ${label}\ntagger ${SIG}\n\n${label}\n`));
  }
  /** A complete one-file commit. */
  simple(label: string, parents: string[] = []) {
    const tree = this.tree(`${label}-tree`, [treeEntry('100644', 'f', this.blob(`${label}-blob`))]);
    return this.commit(label, tree, parents);
  }

  store(): GitStore {
    return {
      getMeta: () => null,
      reachableVersion: () => 'v',
      refs: () => [...this.refs].map(([name, target]) => ({ name, target })),
      resolveHead: () => null,
      getRef: (name: string) => this.refs.get(name) ?? null,
      getPeeled: () => null,
      typeAndSize: (oid: string) => {
        const obj = this.objects.get(oid);
        return obj ? { type: obj.type, size: obj.data.length } : null;
      },
      get: async (oid: string) => {
        this.reads += 1;
        return this.objects.get(oid) ?? null;
      },
      head: () => 'refs/heads/main',
      setHead: () => undefined,
      setRef: (name: string, target: string) => void this.refs.set(name, target),
      delRef: (name: string) => void this.refs.delete(name),
      invalidateReachable: () => undefined,
      extendReachable: () => undefined,
    } as unknown as GitStore;
  }
}

async function decide(repo: Repo, commands: [old: string, next: string, ref: string][]) {
  return withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () =>
    validatePush(repo.store(), commands.map(([old, next, ref]) => ({ old, next, ref })), null)
  );
}

describe('push admission: ref seeding', () => {
  it('reads no existing ref tip before deciding commands', async () => {
    const repo = new Repo();
    const tips: string[] = [];
    for (let i = 0; i < 1201; i++) {
      tips.push(repo.simple(`tip-${i}`));
      repo.refs.set(`refs/heads/t${i}`, tips[i]!);
    }
    const next = repo.simple('on-top', [tips[7]!]);
    repo.reads = 0;
    const plan = await decide(repo, [
      [tips[3]!, ZERO, 'refs/heads/t3'],
      [ZERO, next, 'refs/heads/new'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ del: true });
    expect(plan.decisions[1]).toMatchObject({ set: next });
    // The new commit and its tree: its parent is an existing tip and is never read.
    expect(repo.reads).toBe(2);
  });
});

describe('push admission: edge types', () => {
  it('refuses a commit whose tree is a blob, with a valid sibling accepted', async () => {
    const repo = new Repo();
    const blob = repo.blob('loose');
    const evil = repo.commit('blob-as-tree', blob);
    const good = repo.simple('good');
    const plan = await decide(repo, [
      [ZERO, evil, 'refs/heads/evil'],
      [ZERO, good, 'refs/heads/good'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
    expect(plan.decisions[1]).toMatchObject({ set: good });
  });

  it('refuses a commit whose parent is a tree', async () => {
    const repo = new Repo();
    const base = repo.simple('base');
    const tree = repo.tree('t', [treeEntry('100644', 'f', repo.blob('b'))]);
    const evil = repo.commit('tree-as-parent', tree, [tree]);
    repo.refs.set('refs/heads/main', base);
    const plan = await decide(repo, [[ZERO, evil, 'refs/heads/evil']]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
  });

  it('refuses a validated object at an edge of the wrong type', async () => {
    const repo = new Repo();
    const tip = repo.simple('tip');
    repo.refs.set('refs/heads/main', tip);
    // The existing tip is in the validated set, but a commit's tree must be a tree.
    const evil = repo.commit('commit-as-tree', tip);
    const plan = await decide(repo, [[ZERO, evil, 'refs/heads/evil']]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
    const ok = repo.simple('child', [tip]);
    expect((await decide(repo, [[ZERO, ok, 'refs/heads/child']])).decisions[0]).toMatchObject({ set: ok });
  });

  it('refuses a tree entry whose mode disagrees with its object type', async () => {
    const repo = new Repo();
    const inner = repo.tree('inner', [treeEntry('100644', 'f', repo.blob('x'))]);
    const evil = repo.commit('mode', repo.tree('outer', [treeEntry('100644', 'dir', inner)]));
    const fine = repo.commit('fine', repo.tree('outer-ok', [treeEntry('40000', 'dir', inner)]));
    const plan = await decide(repo, [
      [ZERO, evil, 'refs/heads/evil'],
      [ZERO, fine, 'refs/heads/fine'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
    expect(plan.decisions[1]).toMatchObject({ set: fine });
  });

  it('refuses an annotated tag whose type header disagrees with its object', async () => {
    const repo = new Repo();
    const commit = repo.simple('tagged');
    const lying = repo.tag('lying', commit, 'tree');
    const honest = repo.tag('honest', commit, 'commit');
    const plan = await decide(repo, [
      [ZERO, lying, 'refs/tags/lying'],
      [ZERO, honest, 'refs/tags/honest'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
    expect(plan.decisions[1]).toMatchObject({ set: honest });
  });

  it('refuses a non-commit on a branch but allows it as a lightweight tag', async () => {
    const repo = new Repo();
    const tree = repo.tree('bare', [treeEntry('100644', 'f', repo.blob('y'))]);
    const plan = await decide(repo, [
      [ZERO, tree, 'refs/heads/tree'],
      [ZERO, tree, 'refs/tags/tree'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ reject: 'trying to write non-commit object to branch' });
    expect(plan.decisions[1]).toMatchObject({ set: tree });
  });
});

describe('push admission: directory/file ref conflicts', () => {
  it('refuses a ref nested under an existing ref, and an existing ref nested under a new one', async () => {
    const repo = new Repo();
    const c = repo.simple('c');
    repo.refs.set('refs/heads/a', c);
    repo.refs.set('refs/heads/x/y', c);
    const plan = await decide(repo, [
      [ZERO, c, 'refs/heads/a/b'],
      [ZERO, c, 'refs/heads/x'],
      [ZERO, c, 'refs/heads/ab'],
      [ZERO, c, 'refs/heads/x-y'],
    ]);
    expect(plan.decisions.map((d) => d.reject ?? 'set')).toEqual([
      'ref name conflicts with an existing ref',
      'ref name conflicts with an existing ref',
      'set',
      'set',
    ]);
  });

  it('refuses the second of two conflicting new refs in one push', async () => {
    const repo = new Repo();
    const c = repo.simple('c');
    const plan = await decide(repo, [
      [ZERO, c, 'refs/heads/n'],
      [ZERO, c, 'refs/heads/n/m'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ set: c });
    expect(plan.decisions[1]).toMatchObject({ reject: 'ref name conflicts with an existing ref' });
  });

  it('allows replacing a ref with a nested one when the same push deletes it', async () => {
    const repo = new Repo();
    const c = repo.simple('c');
    repo.refs.set('refs/heads/a', c);
    const plan = await decide(repo, [
      [ZERO, c, 'refs/heads/a/b'],
      [c, ZERO, 'refs/heads/a'],
    ]);
    expect(plan.decisions[0]).toMatchObject({ set: c });
    expect(plan.decisions[1]).toMatchObject({ del: true });
  });
});

describe('push admission: deleting a missing ref', () => {
  it('reports success without changing refs or queueing GC, with a real deletion control', async () => {
    const repo = new Repo();
    const c = repo.simple('c');
    repo.refs.set('refs/heads/real', c);
    const missing = commitPush(repo.store(), await decide(repo, [[ZERO, ZERO, 'refs/heads/nope']]));
    expect(missing).toMatchObject({ changed: false, needsGc: false });
    expect(missing.results).toEqual([{ ref: 'refs/heads/nope', ok: true }]);
    const real = commitPush(repo.store(), await decide(repo, [[c, ZERO, 'refs/heads/real']]));
    expect(real).toMatchObject({ changed: true, needsGc: true });
    expect(repo.refs.has('refs/heads/real')).toBe(false);
  });
});

describe('armHostedGitGcAlarm', () => {
  it('keeps an alarm already due sooner, and arms one when none is due or it is later', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const due = Date.now() + GC_DELAY_MS;
      const storage = (armed: number | null) => ({
        getAlarm: vi.fn(async () => armed),
        setAlarm: vi.fn(async () => undefined),
      });
      const sooner = storage(Date.now() + 1000);
      await armHostedGitGcAlarm(sooner);
      expect(sooner.setAlarm).not.toHaveBeenCalled();
      const none = storage(null);
      await armHostedGitGcAlarm(none);
      expect(none.setAlarm).toHaveBeenCalledWith(due);
      const later = storage(due + 60_000);
      await armHostedGitGcAlarm(later);
      expect(later.setAlarm).toHaveBeenCalledWith(due);
    } finally {
      vi.useRealTimers();
    }
  });
});
