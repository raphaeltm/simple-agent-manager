import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkTrackedArtifacts } from './check-tracked-artifacts';

const tempDirs: string[] = [];

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tracked-artifacts-'));
  tempDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('tracked artifact guard', () => {
  it('passes when the blocked VM-agent root binary is absent and untracked', () => {
    const root = makeGitRepo();

    expect(checkTrackedArtifacts(root).findings).toEqual([]);
  });

  it('fails when the blocked VM-agent root binary is tracked', () => {
    const root = makeGitRepo();
    const artifactDir = join(root, 'packages/vm-agent');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'vm-agent'), 'binary');
    execFileSync('git', ['add', 'packages/vm-agent/vm-agent'], { cwd: root });

    expect(checkTrackedArtifacts(root).findings).toEqual([
      {
        path: 'packages/vm-agent/vm-agent',
        reason: 'tracked by git',
      },
    ]);
  });

  it('fails when the blocked VM-agent root binary exists untracked in the working tree', () => {
    const root = makeGitRepo();
    const artifactDir = join(root, 'packages/vm-agent');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'vm-agent'), 'binary');

    expect(checkTrackedArtifacts(root).findings).toEqual([
      {
        path: 'packages/vm-agent/vm-agent',
        reason: 'present in working tree',
      },
    ]);
  });
});
