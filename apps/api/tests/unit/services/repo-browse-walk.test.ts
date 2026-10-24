import { execSync } from 'node:child_process';
import realFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectCompareFiles, collectTreeEntries } from '../../../src/services/repo-browse/artifacts';

// Regression suite for the isomorphic-git walk recursion bug: `walk` PRUNES
// recursion into a node's children when `map` returns `null`. The original
// listTree/compare returned `null` from the root and every tree node, so the
// walk never descended — artifacts repos showed an EMPTY file tree and an
// EMPTY diff. The class-level tests mock `git.walk` and cannot catch this, so
// these tests run the REAL isomorphic-git against a REAL on-disk repo.

// isomorphic-git's IsoFs type; node's fs/promises satisfies the shape it needs.
const fs = realFs as unknown as Parameters<typeof git.walk>[0]['fs'];

let dir: string;

function run(cmd: string) {
  execSync(cmd, { cwd: dir, stdio: 'pipe' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repo-browse-walk-'));
  run('git init -q -b main');
  run('git config user.email t@example.com');
  run('git config user.name Tester');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function headTreeOid(ref = 'HEAD'): Promise<string> {
  const oid = await git.resolveRef({ fs, dir, ref });
  const { commit } = await git.readCommit({ fs, dir, oid });
  return commit.tree;
}

describe('collectTreeEntries (real git.walk recursion)', () => {
  it('returns nested blobs and trees, not just the root (regression: null pruned recursion)', async () => {
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    mkdirSync(join(dir, 'src', 'deep'));
    writeFileSync(join(dir, 'src', 'deep', 'util.ts'), 'export const y = 2;\n');
    run('git add -A');
    run('git commit -q -m init');

    const entries = await collectTreeEntries(fs, dir, 'main');
    const paths = entries.map((e) => e.path).sort();
    // The bug produced []. All levels must be present.
    expect(paths).toEqual(['README.md', 'src', 'src/deep', 'src/deep/util.ts', 'src/index.ts']);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath['src'].type).toBe('tree');
    expect(byPath['src/deep'].type).toBe('tree');
    expect(byPath['src/deep/util.ts'].type).toBe('blob');
    expect(byPath['README.md'].name).toBe('README.md');
  });

  it('returns [] for a truly empty commit (no false positives)', async () => {
    run('git commit -q --allow-empty -m empty');
    const entries = await collectTreeEntries(fs, dir, 'main');
    expect(entries).toEqual([]);
  });
});

describe('collectCompareFiles (real git.walk two-tree diff)', () => {
  it('detects nested added/modified/removed files across subdirectories', async () => {
    // Base commit
    writeFileSync(join(dir, 'keep.txt'), 'same\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'mod.ts'), 'line1\n');
    writeFileSync(join(dir, 'src', 'gone.ts'), 'bye\n');
    run('git add -A');
    run('git commit -q -m base');
    const baseTree = await headTreeOid();

    // Head commit: modify nested file, remove nested file, add deeply nested file
    writeFileSync(join(dir, 'src', 'mod.ts'), 'line1\nline2\n');
    rmSync(join(dir, 'src', 'gone.ts'));
    mkdirSync(join(dir, 'src', 'new'));
    writeFileSync(join(dir, 'src', 'new', 'added.ts'), 'fresh\n');
    run('git add -A');
    run('git commit -q -m head');
    const headTree = await headTreeOid();

    const { files, truncated } = await collectCompareFiles(fs, dir, baseTree, headTree, 100);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    // The bug produced [] (tree entries returned null → no recursion).
    expect(Object.keys(byPath).sort()).toEqual(['src/gone.ts', 'src/mod.ts', 'src/new/added.ts']);
    expect(byPath['src/mod.ts'].status).toBe('modified');
    expect(byPath['src/mod.ts'].additions).toBeGreaterThan(0);
    expect(byPath['src/mod.ts'].patch).toContain('+line2');
    expect(byPath['src/gone.ts'].status).toBe('removed');
    expect(byPath['src/new/added.ts'].status).toBe('added');
    // unchanged root file must NOT appear
    expect(byPath['keep.txt']).toBeUndefined();
    expect(truncated).toBe(false);
  });

  it('returns an empty diff for identical trees (no false positives)', async () => {
    writeFileSync(join(dir, 'keep.txt'), 'same\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'x\n');
    run('git add -A');
    run('git commit -q -m base');
    const tree = await headTreeOid();
    const { files, truncated } = await collectCompareFiles(fs, dir, tree, tree, 100);
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });
});
