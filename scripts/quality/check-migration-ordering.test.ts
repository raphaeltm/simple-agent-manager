import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/quality/check-migration-ordering.ts');
const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-ordering-'));
  tempDirs.push(dir);
  return dir;
}

function runCheck(...dirs: string[]): string {
  return execFileSync('npx', ['tsx', SCRIPT, ...dirs], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('D1 migration ordering check', () => {
  it('passes on the current codebase without renaming legacy applied migrations', () => {
    expect(runCheck()).toContain('D1 migration ordering check passed');
  });

  it('fails on a new duplicate numeric prefix', () => {
    const dir = makeDir();
    writeFileSync(join(dir, '0100_first.sql'), 'CREATE TABLE first (id TEXT PRIMARY KEY);');
    writeFileSync(join(dir, '0100_second.sql'), 'CREATE TABLE second (id TEXT PRIMARY KEY);');

    expect(() => runCheck(dir)).toThrow(/Duplicate migration numeric prefix 0100/);
  });

  it('fails on migration filenames without a sortable numeric prefix', () => {
    const dir = makeDir();
    writeFileSync(join(dir, '0001_initial.sql'), 'CREATE TABLE first (id TEXT PRIMARY KEY);');
    writeFileSync(join(dir, 'next_change.sql'), 'CREATE TABLE second (id TEXT PRIMARY KEY);');

    expect(() => runCheck(dir)).toThrow(/Migration filename must match NNNN_descriptive_name\.sql/);
  });

  it('fails on unexpected entries in a migration directory', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, '0001_initial.sql'), 'CREATE TABLE first (id TEXT PRIMARY KEY);');
    writeFileSync(join(dir, 'README.md'), 'not a migration');

    expect(() => runCheck(dir)).toThrow(/Unexpected directory in migrations_dir: nested/);
    expect(() => runCheck(dir)).toThrow(/Unexpected non-SQL file in migrations_dir: README\.md/);
  });
});
