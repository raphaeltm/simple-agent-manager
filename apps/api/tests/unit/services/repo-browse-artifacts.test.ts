import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { ArtifactsRepoBrowser } from '../../../src/services/repo-browse/artifacts';

// Mock isomorphic-git (the git mechanics themselves are proven by the workerd
// spike, idea §10). The real `diff` lib is used so patch generation is exercised.
const iso = vi.hoisted(() => ({
  clone: vi.fn(),
  fetch: vi.fn(),
  listServerRefs: vi.fn(),
  resolveRef: vi.fn(),
  readBlob: vi.fn(),
  walk: vi.fn(),
  TREE: vi.fn((o: unknown) => ({ __tree: o })),
}));
vi.mock('isomorphic-git', () => ({ default: iso }));
vi.mock('isomorphic-git/http/web', () => ({ default: {} }));

const enc = (s: string) => new TextEncoder().encode(s);

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {
      get: vi.fn().mockResolvedValue({
        remote: 'https://artifacts.example/repo.git',
        defaultBranch: 'main',
        createToken: vi.fn().mockResolvedValue({ plaintext: 'read-token' }),
      }),
    },
    ARTIFACTS_TOKEN_TTL_SECONDS: '60',
    ...extra,
  } as unknown as Env;
}

function browser(env: Env = makeEnv()): ArtifactsRepoBrowser {
  return new ArtifactsRepoBrowser('repo-1', 'main', env);
}

/** A fake walk tree entry with async type()/oid(). */
function entry(type: 'blob' | 'tree', oid: string | null) {
  return { type: async () => type, oid: async () => oid };
}

beforeEach(() => {
  vi.clearAllMocks();
  iso.clone.mockResolvedValue(undefined);
  iso.fetch.mockResolvedValue(undefined);
});

describe('ArtifactsRepoBrowser.listBranches', () => {
  it('puts the default branch first, then the rest alphabetically', async () => {
    iso.listServerRefs.mockResolvedValue([
      { ref: 'refs/heads/zeb' },
      { ref: 'refs/heads/feat' },
      { ref: 'refs/heads/main' },
    ]);
    const res = await browser().listBranches();
    expect(res.branches.map((b) => b.name)).toEqual(['main', 'feat', 'zeb']);
    expect(res.branches[0]).toEqual({ name: 'main', isDefault: true });
    // token auth uses the read-scoped token from ARTIFACTS.get
    expect(iso.listServerRefs).toHaveBeenCalled();
  });
});

describe('ArtifactsRepoBrowser.getFile', () => {
  beforeEach(() => {
    iso.resolveRef.mockResolvedValue('commit-oid');
  });

  it('returns inline text for small files', async () => {
    iso.readBlob.mockResolvedValue({ blob: enc('hello world') });
    const f = await browser().getFile('main', 'a.txt');
    expect(f).toMatchObject({ content: 'hello world', isBinary: false, tooLarge: false });
  });

  it('flags binary (NUL byte)', async () => {
    iso.readBlob.mockResolvedValue({ blob: new Uint8Array([1, 0, 2]) });
    const f = await browser().getFile('main', 'x.bin');
    expect(f.isBinary).toBe(true);
    expect(f.content).toBeNull();
  });

  it('flags oversized files as tooLarge', async () => {
    iso.readBlob.mockResolvedValue({ blob: enc('hello world') });
    const f = await browser(makeEnv({ REPO_BROWSE_MAX_INLINE_BYTES: '3' })).getFile('main', 'big.txt');
    expect(f.tooLarge).toBe(true);
    expect(f.content).toBeNull();
  });
});

describe('ArtifactsRepoBrowser.listTree', () => {
  it('maps blob/tree entries from the walk', async () => {
    iso.walk.mockImplementation(async ({ map }: { map: (fp: string, e: unknown[]) => Promise<unknown> }) => {
      await map('src', [entry('tree', 't1')]);
      await map('src/a.ts', [entry('blob', 'b1')]);
      await map('.', [entry('tree', 'root')]); // root — skipped
      return [];
    });
    const res = await browser().listTree('main');
    expect(res.entries).toEqual([
      { path: 'src', name: 'src', type: 'tree', size: null },
      { path: 'src/a.ts', name: 'a.ts', type: 'blob', size: null },
    ]);
  });
});

describe('ArtifactsRepoBrowser.compare (two-tree diff + real diff patches)', () => {
  it('detects add/modify/remove and generates unified-diff patches', async () => {
    iso.resolveRef.mockImplementation(async ({ ref }: { ref: string }) =>
      ref === 'main' ? 'baseOid' : 'headOid'
    );
    const blobs: Record<string, Uint8Array> = {
      modBase: enc('line1\n'),
      modHead: enc('line1\nline2\n'),
      removed: enc('bye\n'),
      added: enc('hi\n'),
    };
    iso.readBlob.mockImplementation(async ({ oid }: { oid: string }) => ({ blob: blobs[oid] }));
    iso.walk.mockImplementation(async ({ map }: { map: (fp: string, e: unknown[]) => Promise<unknown> }) => {
      await map('mod.ts', [entry('blob', 'modBase'), entry('blob', 'modHead')]);
      await map('gone.ts', [entry('blob', 'removed'), null]);
      await map('new.ts', [null, entry('blob', 'added')]);
      await map('same.ts', [entry('blob', 'x'), entry('blob', 'x')]); // unchanged — excluded
      return [];
    });

    const res = await browser().compare('main', 'feat');
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['gone.ts', 'mod.ts', 'new.ts']);
    expect(byPath['mod.ts'].status).toBe('modified');
    expect(byPath['mod.ts'].patch).toContain('+line2');
    expect(byPath['mod.ts'].additions).toBeGreaterThan(0);
    expect(byPath['gone.ts'].status).toBe('removed');
    expect(byPath['new.ts'].status).toBe('added');
    // head ref resolved through the remote-tracking ref
    expect(iso.fetch).toHaveBeenCalled();
  });

  it('marks binary changes without a patch', async () => {
    iso.resolveRef.mockImplementation(async ({ ref }: { ref: string }) =>
      ref === 'main' ? 'baseOid' : 'headOid'
    );
    iso.readBlob.mockImplementation(async ({ oid }: { oid: string }) => ({
      blob: oid === 'p1' ? new Uint8Array([0, 1]) : new Uint8Array([0, 2]),
    }));
    iso.walk.mockImplementation(async ({ map }: { map: (fp: string, e: unknown[]) => Promise<unknown> }) => {
      await map('img.png', [entry('blob', 'p1'), entry('blob', 'p2')]);
      return [];
    });
    const res = await browser().compare('main', 'feat');
    expect(res.files[0]).toMatchObject({ path: 'img.png', isBinary: true, patch: null });
  });
});
