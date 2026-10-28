import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runtimeInputIdentity,
  runtimeInputPaths,
  runtimeAgentAssociation,
} from './installer-runtime-identity.mjs';

test('frontend changes reuse runtime pins and agent identity; real runtime input changes rotate both', () => {
  const root = mkdtempSync(join(tmpdir(), 'sam-runtime-input-test-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const commit = (message) => {
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    for (const path of runtimeInputPaths) {
      const file = ['scripts/diagnostics/pinned-codex-bin', 'scripts/diagnostics/patches'].includes(
        path
      )
        ? join(path, 'reviewed-input')
        : path;
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `reviewed ${path}\n`);
    }
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    writeFileSync(join(root, 'apps/web/home.tsx'), 'first frontend');
    const first = commit('runtime source baseline');
    const inputA = runtimeInputIdentity(root, first);
    const base = git('rev-list', '-1', first, '--', 'packages/vm-agent');
    const trust = {
      archiveSHA256: 'a'.repeat(64),
      archiveBytes: 1234,
      catalogSHA256: 'b'.repeat(64),
      installerSHA256: 'c'.repeat(64),
    };
    const cache = new Map([[inputA, trust]]);
    const firstAssociation = runtimeAgentAssociation(
      base,
      '2026-10-28T12:00:00Z',
      cache.get(inputA),
      inputA
    );
    writeFileSync(join(root, 'apps/web/home.tsx'), 'frontend-only change');
    const frontend = commit('frontend only');
    assert.notEqual(frontend, first);
    const inputFrontend = runtimeInputIdentity(root, frontend);
    assert.equal(inputFrontend, inputA);
    assert.equal(git('rev-list', '-1', frontend, '--', 'packages/vm-agent'), base);
    const frontendAssociation = runtimeAgentAssociation(
      base,
      '2026-10-28T12:00:00Z',
      cache.get(inputFrontend),
      inputFrontend
    );
    assert.deepEqual(frontendAssociation, firstAssociation);
    writeFileSync(
      join(root, 'scripts/diagnostics/patches/reviewed-input'),
      'changed reviewed runtime patch'
    );
    const runtime = commit('runtime patch change outside VM-agent directory');
    const inputB = runtimeInputIdentity(root, runtime);
    assert.notEqual(inputB, inputA);
    assert.equal(git('rev-list', '-1', runtime, '--', 'packages/vm-agent'), base);
    const nextTrust = {
      ...trust,
      archiveSHA256: 'd'.repeat(64),
      catalogSHA256: 'e'.repeat(64),
      installerSHA256: 'f'.repeat(64),
    };
    cache.set(inputB, nextTrust);
    const nextAssociation = runtimeAgentAssociation(
      base,
      '2026-10-28T12:00:00Z',
      cache.get(inputB),
      inputB
    );
    assert.notEqual(nextAssociation.release, firstAssociation.release);
    assert.match(nextAssociation.release, /^[a-f0-9]{40}$/);
    // Even an unexpected rebuild with identical inputs cannot reuse an immutable
    // VM release key for changed archive or embedded-installer bytes.
    assert.notEqual(
      runtimeAgentAssociation(base, '2026-10-28T12:00:00Z', nextTrust, inputA).release,
      firstAssociation.release
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
