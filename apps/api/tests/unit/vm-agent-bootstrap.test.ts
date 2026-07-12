import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../container-entrypoints/vm-agent-bootstrap.sh'
);

const scratchDirs: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vm-agent-bootstrap-'));
  scratchDirs.push(dir);
  return dir;
}

function runBootstrap(env: Record<string, string>) {
  return spawnSync('sh', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

afterEach(() => {
  scratchDirs.length = 0;
});

describe('vm-agent-bootstrap.sh', () => {
  it('fails fast with a structured error when the baked binary is missing', () => {
    const dir = makeScratch();
    const result = runBootstrap({
      CONTROL_PLANE_URL: 'https://api.example.com',
      VM_AGENT_BIN: join(dir, 'does-not-exist'),
      VM_AGENT_VERSION_FILE: join(dir, 'missing.json'),
      VM_AGENT_STATE_DIR: join(dir, 'state'),
      WORKSPACE_DIR: join(dir, 'workspace'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('vm_agent_container_bootstrap_error');
    expect(result.stderr).toContain('baked_artifact_missing');
    // Must not silently continue and emit the ready event.
    expect(result.stdout).not.toContain('vm_agent_container_bootstrap_ready');
  });

  it('fails fast when the version file is missing even if the binary exists', () => {
    const dir = makeScratch();
    const bin = join(dir, 'vm-agent');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const result = runBootstrap({
      CONTROL_PLANE_URL: 'https://api.example.com',
      VM_AGENT_BIN: bin,
      VM_AGENT_VERSION_FILE: join(dir, 'missing.json'),
      VM_AGENT_STATE_DIR: join(dir, 'state'),
      WORKSPACE_DIR: join(dir, 'workspace'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baked_artifact_missing');
  });

  it('emits the ready event and execs the baked binary on success', () => {
    const dir = makeScratch();
    const bin = join(dir, 'vm-agent');
    // The script `exec`s this binary; exit 0 so the whole bootstrap exits 0.
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    const versionFile = join(dir, 'vm-agent-version.json');
    writeFileSync(
      versionFile,
      '{"version":"abc123","buildDate":"2026-07-11T00:00:00Z","sha256":"sha256:deadbeef"}\n'
    );

    const result = runBootstrap({
      CONTROL_PLANE_URL: 'https://api.example.com',
      VM_AGENT_BIN: bin,
      VM_AGENT_VERSION_FILE: versionFile,
      VM_AGENT_STATE_DIR: join(dir, 'state'),
      WORKSPACE_DIR: join(dir, 'workspace'),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vm_agent_container_bootstrap_ready');
    // The baked artifact version metadata is surfaced in the ready telemetry.
    expect(result.stdout).toContain('abc123');
  });

  it('requires CONTROL_PLANE_URL', () => {
    const dir = makeScratch();
    const result = runBootstrap({
      CONTROL_PLANE_URL: '',
      VM_AGENT_STATE_DIR: join(dir, 'state'),
      WORKSPACE_DIR: join(dir, 'workspace'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CONTROL_PLANE_URL');
  });
});
