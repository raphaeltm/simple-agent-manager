import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/quality/check-runtime-state-files.ts');
const TSX_CLI = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const runtimePaths = ['.do-state.md', '.workflow-state.md'];
const tempDirs: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'runtime-state-check-'));
  tempDirs.push(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Runtime state test');
  writeFileSync(join(repo, '.gitignore'), readFileSync(join(ROOT, '.gitignore')));
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

function runCheck(repo: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

function writeState(repo: string, path: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), `durable state for ${path}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runtime state Git contract', () => {
  it('ignores a Git executable shadowed on PATH', () => {
    const repo = makeGitRepo();
    const shadowDir = join(repo, 'shadow-bin');
    mkdirSync(shadowDir);
    writeFileSync(join(shadowDir, 'git'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
    expect(runCheck(repo, { PATH: `${shadowDir}:${process.env.PATH}` }).status).toBe(0);
  });

  it('supports an explicitly configured absolute Git executable', () => {
    const repo = makeGitRepo();
    const customGit = join(repo, 'configured-git');
    symlinkSync('/usr/bin/git', customGit);
    expect(runCheck(repo, { SAM_GIT_BINARY: customGit }).status).toBe(0);
  });

  it('rejects a relative Git executable override', () => {
    const repo = makeGitRepo();
    const result = runCheck(repo, { SAM_GIT_BINARY: 'git' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SAM_GIT_BINARY must be an absolute path');
  });

  it('allows local state and includes it in a Git snapshot tree without modifying the real index', () => {
    const repo = makeGitRepo();
    for (const path of runtimePaths) writeState(repo, path);
    expect(runCheck(repo).status).toBe(0);
    expect(git(repo, 'ls-files', '--others', '--exclude-standard').trim().split('\n')).toEqual(
      runtimePaths
    );

    const env = { ...process.env, GIT_INDEX_FILE: join(repo, '.git', 'snapshot-index') };
    const snapshotGit = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
    snapshotGit('read-tree', 'HEAD');
    snapshotGit('add', '--all');
    const tree = snapshotGit('write-tree');
    for (const path of runtimePaths) {
      expect(git(repo, 'show', `${tree}:${path}`)).toBe(`durable state for ${path}\n`);
    }
    const restoreDir = join(repo, 'restore');
    mkdirSync(restoreDir);
    snapshotGit('checkout-index', '--all', `--prefix=${restoreDir}/`);
    for (const path of runtimePaths) {
      expect(readFileSync(join(restoreDir, path), 'utf8')).toBe(`durable state for ${path}\n`);
    }
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(runCheck(repo).status).toBe(0);
  });

  it.each([...runtimePaths, 'nested/.do-state.md', 'nested/.workflow-state.md'])(
    'rejects staged and committed %s',
    (path) => {
      const repo = makeGitRepo();
      writeState(repo, path);
      git(repo, 'add', '--', path);
      const staged = runCheck(repo);
      expect(staged.status).toBe(1);
      expect(staged.stderr).toContain(`- ${path}`);
      git(repo, 'commit', '-m', 'accidental runtime state');
      const committed = runCheck(repo);
      expect(committed.status).toBe(1);
      expect(committed.stderr).toContain(`- ${path}`);
    }
  );

  it('allows staged removal of accidentally committed state', () => {
    const repo = makeGitRepo();
    writeState(repo, runtimePaths[0]);
    git(repo, 'add', '--', runtimePaths[0]);
    git(repo, 'commit', '-m', 'accidental runtime state');
    git(repo, 'rm', '--cached', '--', runtimePaths[0]);
    expect(runCheck(repo).status).toBe(0);
  });

  it('fails closed outside a Git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-state-no-git-'));
    tempDirs.push(dir);
    const result = runCheck(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
  });
});
