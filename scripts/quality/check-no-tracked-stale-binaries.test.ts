import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/quality/check-no-tracked-stale-binaries.ts');
const GIT_BINARY = '/usr/bin/git';
const tempDirs: string[] = [];

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-binary-check-'));
  tempDirs.push(dir);
  execFileSync(GIT_BINARY, ['init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function runCheck(cwd: string): string {
  return execFileSync('npx', ['tsx', SCRIPT], {
    cwd,
    encoding: 'utf-8',
    stderr: 'pipe',
    timeout: 30_000,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('stale binary tracking check', () => {
  it('passes when the forbidden VM agent root binary is not tracked', () => {
    const repo = makeGitRepo();

    expect(runCheck(repo)).toBe('');
  });

  it('fails when the forbidden VM agent root binary is tracked', () => {
    const repo = makeGitRepo();
    const binaryPath = join(repo, 'packages/vm-agent/vm-agent');
    mkdirSync(join(repo, 'packages/vm-agent'), { recursive: true });
    writeFileSync(binaryPath, 'compiled artifact');
    execFileSync(GIT_BINARY, ['add', 'packages/vm-agent/vm-agent'], { cwd: repo });

    expect(() => runCheck(repo)).toThrow(/Generated binary artifacts must not be tracked/);
  });
});
