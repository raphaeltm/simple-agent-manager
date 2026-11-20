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
    return this.put(
      label,
      'tag',
      enc.encode(`object ${object}\ntype ${type}\ntag ${label}\ntagger ${SIG}\n\n${label}\n`)
    );
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
    validatePush(
      repo.store(),
      commands.map(([old, next, ref]) => ({ old, next, ref })),
      null
    )
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
    expect((await decide(repo, [[ZERO, ok, 'refs/heads/child']])).decisions[0]).toMatchObject({
      set: ok,
    });
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
    expect(plan.decisions[0]).toMatchObject({
      reject: 'trying to write non-commit object to branch',
    });
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

describe('push admission: object shapes git can read', () => {
  const header = `author ${SIG}\ncommitter ${SIG}`;
  it('refuses byte-level shapes git cannot read, and accepts names that are not UTF-8', async () => {
    const repo = new Repo();
    const blob = repo.blob('bytes-blob');
    const tree = repo.tree('bytes-tree', [treeEntry('100644', 'f', blob)]);
    const bom = [0xef, 0xbb, 0xbf];
    const raw = (label: string, type: Kind, bytes: number[]) =>
      repo.put(label, type, new Uint8Array(bytes));
    const sigLines = `author ${SIG}\ncommitter ${SIG}\n`;
    const bomCommit = raw('bom-commit', 'commit', [
      ...bom,
      ...enc.encode(`tree ${tree}\n${sigLines}\nx\n`),
    ]);
    const good = repo.commit('good', tree);
    const bomTag = raw('bom-tag', 'tag', [
      ...bom,
      ...enc.encode(`object ${good}\ntype commit\ntag t\n\nx\n`),
    ]);
    const openTag = raw('open-tag', 'tag', [...enc.encode(`object ${good}\ntype commit\ntag v1`)]);
    // The header section must end in a newline even when its last line is optional.
    const openTagger = raw('open-tagger', 'tag', [
      ...enc.encode(`object ${good}\ntype commit\ntag v2\ntagger ${SIG}`),
    ]);
    const nulHeader = raw('nul', 'commit', [
      ...enc.encode(`tree ${tree}\nauthor T`),
      0,
      ...enc.encode(` ${SIG}\ncommitter ${SIG}\n\nx\n`),
    ]);
    const entry = (mode: string, name: number[], oid: string) => [
      ...enc.encode(`${mode} `),
      ...name,
      0,
      ...Buffer.from(oid, 'hex'),
    ];
    const latin = repo.commit(
      'latin',
      repo.tree('latin-tree', [entry('100644', [0xe8], blob), entry('100644', [0xe9], blob)])
    );
    const bomName = repo.commit(
      'bom-name',
      repo.tree('bom-name-tree', [entry('100644', bom, blob)])
    );
    const oddMode = repo.commit(
      'odd-mode',
      repo.tree('odd-mode-tree', [entry('100600', [0x66], blob)])
    );
    const dotGit = repo.commit(
      'dot-git',
      repo.tree('dot-git-tree', [entry('100644', [...enc.encode('.GIT ')], blob)])
    );
    const dotDot = repo.commit(
      'dot-dot',
      repo.tree('dot-dot-tree', [entry('40000', [...enc.encode('..')], tree)])
    );
    const plan = await decide(repo, [
      [ZERO, bomCommit, 'refs/heads/bom'],
      [ZERO, bomTag, 'refs/tags/bom'],
      [ZERO, openTag, 'refs/tags/open'],
      [ZERO, openTagger, 'refs/tags/open-tagger'],
      [ZERO, nulHeader, 'refs/heads/nul'],
      [ZERO, dotGit, 'refs/heads/dot-git'],
      [ZERO, dotDot, 'refs/heads/dot-dot'],
      [ZERO, latin, 'refs/heads/latin'],
      [ZERO, bomName, 'refs/heads/bom-name'],
      [ZERO, oddMode, 'refs/heads/odd-mode'],
    ]);
    expect(plan.decisions.map((d) => (d.reject ? 'reject' : 'set'))).toEqual([
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'set',
      'set',
      'set',
    ]);
  });

  it('refuses a leading continuation line and checkout-breaking names, with controls accepted', async () => {
    const repo = new Repo();
    const blob = repo.blob('lead-blob');
    const tree = repo.tree('lead-tree', [treeEntry('100644', 'f', blob)]);
    const good = repo.commit('lead-good', tree);
    const sigLines = `author ${SIG}\ncommitter ${SIG}\n`;
    const leadCommit = repo.put(
      'lead-commit',
      'commit',
      enc.encode(` junk\ntree ${tree}\n${sigLines}\nx\n`)
    );
    const leadTag = repo.put(
      'lead-tag',
      'tag',
      enc.encode(` junk\nobject ${good}\ntype commit\ntag t\n\nx\n`)
    );
    const named = (label: string, mode: string, name: string, oid: string) =>
      repo.commit(label, repo.tree(`${label}-tree`, [treeEntry(mode, name, oid)]));
    const plan = await decide(repo, [
      [ZERO, leadCommit, 'refs/heads/lead'],
      [ZERO, leadTag, 'refs/tags/lead'],
      [ZERO, named('short', '40000', 'GIT~1', tree), 'refs/heads/short'],
      [ZERO, named('stream', '100644', '.git:x', blob), 'refs/heads/stream'],
      [ZERO, named('modules', '120000', '.gitmodules', blob), 'refs/heads/modules'],
      [ZERO, named('modules-short', '120000', 'GITMOD~1', blob), 'refs/heads/modules-short'],
      [ZERO, named('modules-stream', '120000', '.gitmodules:x', blob), 'refs/heads/modules-stream'],
      [ZERO, named('long', '100644', 'n'.repeat(256), blob), 'refs/heads/long'],
      [ZERO, named('limit', '100644', 'n'.repeat(255), blob), 'refs/heads/limit'],
      [ZERO, named('modules-file', '100644', '.gitmodules', blob), 'refs/heads/modules-file'],
      [ZERO, named('gitignore', '100644', '.gitignore', blob), 'refs/heads/gitignore'],
    ]);
    expect(plan.decisions.map((d) => (d.reject ? 'reject' : 'set'))).toEqual([
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'set',
      'set',
      'set',
    ]);
  });

  it('refuses commits, tags and trees git cannot parse, with git-shaped controls accepted', async () => {
    const repo = new Repo();
    const tree = repo.tree('shape-tree', [treeEntry('100644', 'f', repo.blob('shape-blob'))]);
    const signed = repo.put(
      'signed',
      'commit',
      enc.encode(
        `tree ${tree}\n${header}\nencoding UTF-8\ngpgsig -----BEGIN PGP SIGNATURE-----\n line\n -----END PGP SIGNATURE-----\n\nsigned\n`
      )
    );
    const authorFirst = repo.put(
      'author-first',
      'commit',
      enc.encode(`${header.split('\n')[0]}\ntree ${tree}\n${header.split('\n')[1]}\n\nx\n`)
    );
    const noCommitter = repo.put(
      'no-committer',
      'commit',
      enc.encode(`tree ${tree}\nauthor ${SIG}\n\nx\n`)
    );
    const lateParent = repo.put(
      'late-parent',
      'commit',
      enc.encode(`tree ${tree}\n${header}\nparent ${signed}\n\nx\n`)
    );
    const tagTypeFirst = repo.put(
      'type-first',
      'tag',
      enc.encode(`type commit\nobject ${signed}\ntag t\ntagger ${SIG}\n\nx\n`)
    );
    const tagNoName = repo.put(
      'no-name',
      'tag',
      enc.encode(`object ${signed}\ntype commit\ntagger ${SIG}\n\nx\n`)
    );
    const badMode = repo.commit(
      'bad-mode',
      repo.tree('bad-mode-tree', [treeEntry('8', 'f', repo.blob('m'))])
    );
    const dupName = repo.commit(
      'dup-name',
      repo.tree('dup-tree', [
        treeEntry('100644', 'f', repo.blob('d1')),
        treeEntry('100644', 'f', repo.blob('d2')),
      ])
    );
    const slashName = repo.commit(
      'slash',
      repo.tree('slash-tree', [treeEntry('100644', 'a/b', repo.blob('s'))])
    );
    const plan = await decide(repo, [
      [ZERO, signed, 'refs/heads/signed'],
      [ZERO, authorFirst, 'refs/heads/author-first'],
      [ZERO, noCommitter, 'refs/heads/no-committer'],
      [ZERO, lateParent, 'refs/heads/late-parent'],
      [ZERO, tagTypeFirst, 'refs/tags/type-first'],
      [ZERO, tagNoName, 'refs/tags/no-name'],
      [ZERO, badMode, 'refs/heads/bad-mode'],
      [ZERO, dupName, 'refs/heads/dup-name'],
      [ZERO, slashName, 'refs/heads/slash'],
      [ZERO, repo.tag('good-tag', signed, 'commit'), 'refs/tags/good'],
    ]);
    const outcome = plan.decisions.map((d) => (d.reject ? 'reject' : 'set'));
    expect(outcome).toEqual([
      'set',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
      'set',
    ]);
  });
});

describe('push admission: old history and the reachable cache', () => {
  it('never trusts the reachable cache for a push: a cached but absent parent is refused', async () => {
    // A clone racing a stranding push could once stamp a stale reachable set as current,
    // and GC then deleted an object the cache still listed. Admission must not consult it.
    const repo = new Repo();
    const base = repo.simple('base');
    repo.refs.set('refs/heads/main', base);
    const gone = oidOf('collected-commit');
    const child = repo.simple('child-of-gone', [gone]);
    const store = repo.store() as unknown as Record<string, unknown>;
    store.getMeta = (key: string) => (key === 'reachable-version' ? 'v' : null);
    store.reachableHas = (oid: string) => oid === gone || repo.objects.has(oid);
    const plan = await withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () =>
      validatePush(
        store as unknown as GitStore,
        [{ old: ZERO, next: child, ref: 'refs/heads/child' }],
        null
      )
    );
    expect(plan.decisions[0]).toMatchObject({ reject: 'missing necessary objects' });
    const ok = repo.simple('child-of-base', [base]);
    const control = await withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () =>
      validatePush(
        store as unknown as GitStore,
        [{ old: ZERO, next: ok, ref: 'refs/heads/ok' }],
        null
      )
    );
    expect(control.decisions[0]).toMatchObject({ set: ok });
  });

  it('treats an update as forced when the ancestry check exhausts the work budget', async () => {
    const repo = new Repo();
    const old = repo.simple('old');
    const side = repo.simple('side');
    const next = repo.simple('next', [side]);
    repo.refs.set('refs/heads/main', old);
    repo.refs.set('refs/heads/side', side);
    const store = repo.store() as unknown as Record<string, unknown>;
    const get = store.get as (oid: string) => Promise<unknown>;
    let failRead: string | null = side;
    store.get = async (oid: string) => {
      if (oid === failRead) throw new Error('git work exceeds decompression budget');
      return get(oid);
    };
    const plan = await withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () =>
      validatePush(store as unknown as GitStore, [{ old, next, ref: 'refs/heads/main' }], null)
    );
    expect(plan.decisions[0]).toMatchObject({ set: next, forced: true });
    // Any other failure still fails the push.
    failRead = side;
    store.get = async (oid: string) => {
      if (oid === failRead) throw new Error('storage unavailable');
      return get(oid);
    };
    await expect(
      withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () =>
        validatePush(store as unknown as GitStore, [{ old, next, ref: 'refs/heads/main' }], null)
      )
    ).rejects.toThrow('storage unavailable');
  });
});

describe('reachable cache stamping and GC', () => {
  it('stamps a clone-built reachable set only if refs did not move during the walk', async () => {
    const { GitStore } = await import('../../../src/vendor/dgit/git/store');
    const { OidSet } = await import('../../../src/vendor/dgit/git/oidset');
    const set = new OidSet(16);
    set.markHex(oidOf('reachable-1'));
    const fakeThis = (current: string) => ({
      reachableSaveGeneration: 0,
      reachableVersion: () => current,
      sql: { exec: vi.fn() },
      setMeta: vi.fn(),
    });
    const moved = fakeThis('after-push');
    await GitStore.prototype.saveReachable.call(moved as unknown as GitStore, set, 'before-push');
    expect(moved.setMeta).not.toHaveBeenCalled();
    expect(moved.sql.exec).not.toHaveBeenCalled();
    const steady = fakeThis('same');
    await GitStore.prototype.saveReachable.call(steady as unknown as GitStore, set, 'same');
    // Unstamped before the rewrite, restamped only after it completes.
    expect(steady.setMeta.mock.calls).toEqual([
      ['reachable-version', ''],
      ['reachable-version', 'same'],
    ]);
  });

  it('invalidates the reachable cache when GC deletes objects, and only then', async () => {
    const { runHostedGitGc } = await import('../../../src/selfhost/hosted-git/hosted-git-gc');
    const gcStore = (loose: string[]) => {
      const invalidateReachable = vi.fn();
      const store = {
        objectCount: () => loose.length,
        refs: () => [],
        resolveHead: () => null,
        typeAndSize: () => null,
        get: async () => null,
        packs: {
          baseOids: () => [],
          packIds: () => [],
          countObjects: () => 0,
          totalPackBytes: () => 0,
          lookup: () => null,
          reset: () => undefined,
        },
        dbSize: () => 0,
        allOids: () => loose,
        deleteObject: vi.fn(),
        invalidateReachable,
      } as unknown as GitStore;
      return { store, invalidateReachable };
    };
    const withGarbage = gcStore([oidOf('garbage')]);
    expect((await runHostedGitGc(withGarbage.store)).removed).toBe(1);
    expect(withGarbage.invalidateReachable).toHaveBeenCalledOnce();
    const clean = gcStore([]);
    expect((await runHostedGitGc(clean.store)).removed).toBe(0);
    expect(clean.invalidateReachable).not.toHaveBeenCalled();
  });
});

describe('reachable cache writers check validity when they write', () => {
  it('lets only the latest of two overlapping clone saves keep writing and stamp', async () => {
    const { GitStore } = await import('../../../src/vendor/dgit/git/store');
    const { OidSet } = await import('../../../src/vendor/dgit/git/oidset');
    const n = 8192 * 2 + 5; // more than one insert batch, so each save yields mid-rewrite
    const set = new OidSet(n);
    for (let i = 0; i < n; i++) set.markHex(oidOf(`row-${i}`));
    let inserts = 0;
    const store = {
      reachableSaveGeneration: 0,
      reachableVersion: () => 'v',
      sql: { exec: (q: string) => void (q.startsWith('INSERT') && inserts++) },
      setMeta: vi.fn(),
    } as unknown as InstanceType<typeof GitStore>;
    const save = GitStore.prototype.saveReachable;
    const first = save.call(store, set, 'v'); // runs one batch, then yields
    const second = save.call(store, set, 'v'); // supersedes it
    await Promise.all([first, second]);
    const stamps = (store.setMeta as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, v]) => v === 'v'
    );
    expect(stamps).toHaveLength(1);
    // The superseded save stopped after its first batch; the latest wrote every row.
    expect(inserts).toBe(8192 + n);
  });

  it('extends the cache at commit only if it is still stamped current, with a control', async () => {
    const run = async (stillValid: boolean) => {
      const repo = new Repo();
      const base = repo.simple('base');
      repo.refs.set('refs/heads/main', base);
      const next = repo.simple('next', [base]);
      const store = repo.store() as unknown as Record<string, unknown>;
      store.getMeta = (key: string) => (key === 'reachable-version' ? 'v' : null);
      const extendReachable = vi.fn();
      const invalidateReachable = vi.fn();
      Object.assign(store, {
        extendReachable,
        invalidateReachable,
        reachableCacheValid: () => stillValid,
      });
      const plan = await withGitWorkBudget(DEFAULT_HOSTED_GIT_LIMITS, () =>
        validatePush(
          store as unknown as GitStore,
          [{ old: base, next, ref: 'refs/heads/main' }],
          null
        )
      );
      expect(plan.hadCache).toBe(true);
      commitPush(store as unknown as GitStore, plan);
      return { extendReachable, invalidateReachable };
    };
    const rewritten = await run(false); // a clone's save unstamped the cache during validation
    expect(rewritten.extendReachable).not.toHaveBeenCalled();
    expect(rewritten.invalidateReachable).toHaveBeenCalledOnce();
    const steady = await run(true);
    expect(steady.extendReachable).toHaveBeenCalledOnce();
    expect(steady.invalidateReachable).not.toHaveBeenCalled();
  });
});

describe('GC reclaims packs without inflating and drops delta-only bases', () => {
  /**
   * A fake object store with packs and loose objects. A ref points at commit C; C's tree T holds
   * blob B2, which is stored as a delta on blob B1 (unreachable). Pack 1 holds C, T, B2 and B1;
   * pack 2 is a rejected push's pack holding only unreachable X.
   */
  function gcFixture(opts: { noHeadroom?: boolean } = {}) {
    const repo = new Repo();
    const b1 = repo.blob('base-blob');
    const b2 = repo.blob('delta-blob');
    const tree = repo.tree('gc-tree', [treeEntry('100644', 'f', b2)]);
    const commit = repo.commit('gc-commit', tree);
    const x = repo.blob('rejected');
    repo.refs.set('refs/heads/main', commit);
    const packs = new Map<number, string[]>([
      [1, [commit, tree, b2, b1]],
      [2, [x]],
    ]);
    const loose = new Map<string, true>();
    const dropped: number[] = [];
    const migrated: string[] = [];
    const reads: string[] = [];
    const store = {
      ...(repo.store() as unknown as Record<string, unknown>),
      objectCount: () => [...packs.values()].flat().length + loose.size,
      get: async (oid: string) => {
        reads.push(oid);
        return repo.objects.get(oid) ?? null;
      },
      packs: {
        baseOids: () => [b1],
        packIds: () => [...packs.keys()],
        packObjectOids: (id: number) => packs.get(id) ?? [],
        dropPack: async (id: number) => {
          dropped.push(id);
          packs.delete(id);
        },
        countObjects: () => [...packs.values()].flat().length,
        totalPackBytes: () => (opts.noHeadroom ? 11 * 1024 ** 3 : 0),
        lookup: (oid: string) => ([...packs.values()].some((o) => o.includes(oid)) ? {} : null),
        reset: () => packs.clear(),
      },
      dbSize: () => 0,
      put: (oid: string) => {
        migrated.push(oid);
        loose.set(oid, true);
      },
      allOids: () => [...loose.keys()],
      deleteObject: (oid: string) => loose.delete(oid),
      invalidateReachable: () => undefined,
    } as unknown as GitStore;
    return { store, ids: { b1, b2, tree, commit, x }, dropped, migrated, reads, loose };
  }

  it('drops a pack with nothing reachable before reading any pack object', async () => {
    const { runHostedGitGc } = await import('../../../src/selfhost/hosted-git/hosted-git-gc');
    const f = gcFixture();
    let readsAtDrop = -1;
    const packs = (f.store as unknown as { packs: { dropPack: (id: number) => Promise<void> } })
      .packs;
    const drop = packs.dropPack;
    packs.dropPack = async (id) => {
      readsAtDrop = f.reads.filter((oid) => oid === f.ids.b2).length;
      await drop(id);
    };
    await runHostedGitGc(f.store);
    expect(f.dropped).toEqual([2]);
    // The rejected pack went before migration inflated any blob.
    expect(readsAtDrop).toBe(0);
  });

  it('does not keep a delta-only base after migrating, but keeps a loose base while packs stay', async () => {
    const { runHostedGitGc } = await import('../../../src/selfhost/hosted-git/hosted-git-gc');
    const migrating = gcFixture();
    await runHostedGitGc(migrating.store);
    expect(migrating.migrated.sort()).toEqual(
      [migrating.ids.commit, migrating.ids.tree, migrating.ids.b2].sort()
    );
    expect(migrating.loose.has(migrating.ids.b1)).toBe(false);

    const kept = gcFixture({ noHeadroom: true });
    kept.loose.set(kept.ids.b1, true); // a loose base that pack deltas still use
    const result = await runHostedGitGc(kept.store);
    expect(result.skipped).toBe(true);
    expect(kept.loose.has(kept.ids.b1)).toBe(true);
  });
});
