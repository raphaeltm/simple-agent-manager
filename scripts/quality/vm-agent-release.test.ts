import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  computeVmAgentBuildFingerprint,
  createGitBuildInputReader,
  type DeployedVmAgentRelease,
  getDeployedVmAgentRelease,
  LEGACY_VM_AGENT_COMPATIBILITY_VERSION,
  resolveVmAgentRelease,
  type VmAgentBuildInputReader,
} from '../deploy/vm-agent-release';

const OLD_VERSION = '1'.repeat(40);
const TARGET_VERSION = '2'.repeat(40);
const TARGET_FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

function deployed(fingerprint: string | null = TARGET_FINGERPRINT): DeployedVmAgentRelease {
  return { requiredVersion: OLD_VERSION, fingerprint };
}

function reader(input: string, marker: string | null = '1'): VmAgentBuildInputReader {
  return {
    listTrackedInputs: vi.fn(() => input),
    readCompatibilityVersion: vi.fn(() => marker),
  };
}

describe('computeVmAgentBuildFingerprint', () => {
  it('is deterministic for the tracked package tree and compatibility marker', () => {
    const first = computeVmAgentBuildFingerprint('ref-a', reader('tree-a'));
    const second = computeVmAgentBuildFingerprint('ref-b', reader('tree-a'));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes for source, dependency, toolchain, or Makefile tree changes', () => {
    const baseline = computeVmAgentBuildFingerprint('ref', reader('tree-a'));
    expect(computeVmAgentBuildFingerprint('ref', reader('tree-b'))).not.toBe(baseline);
  });

  it('changes when the explicit compatibility marker changes', () => {
    const baseline = computeVmAgentBuildFingerprint('ref', reader('tree-a', '1'));
    expect(computeVmAgentBuildFingerprint('ref', reader('tree-a', '2'))).not.toBe(baseline);
  });

  it('uses the documented legacy marker only for first-rollout inference', () => {
    const explicit = computeVmAgentBuildFingerprint(
      'target',
      reader('tree-a', LEGACY_VM_AGENT_COMPATIBILITY_VERSION)
    );
    const inferred = computeVmAgentBuildFingerprint('prior', reader('tree-a', null), {
      allowLegacyMissingMarker: true,
    });
    expect(inferred).toBe(explicit);
    expect(() => computeVmAgentBuildFingerprint('target', reader('tree-a', null))).toThrow(
      'Missing VM-agent compatibility marker'
    );
  });

  it('tracks the real VM-agent git tree and marker while ignoring unrelated files', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'sam-vm-agent-release-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const commit = (message: string) => {
      git('add', '.');
      git('commit', '-m', message);
      return git('rev-parse', 'HEAD');
    };

    try {
      git('init');
      git('config', 'user.name', 'SAM test');
      git('config', 'user.email', 'sam-test@example.invalid');
      mkdirSync(join(repositoryRoot, 'packages/vm-agent'), { recursive: true });
      mkdirSync(join(repositoryRoot, 'scripts/deploy'), { recursive: true });
      mkdirSync(join(repositoryRoot, 'apps/api'), { recursive: true });
      const vmAgentFiles = ['main.go', 'go.mod', 'go.sum', 'Makefile'];
      for (const filename of vmAgentFiles) {
        writeFileSync(join(repositoryRoot, 'packages/vm-agent', filename), `${filename} v1\n`);
      }
      writeFileSync(
        join(repositoryRoot, 'scripts/deploy/vm-agent-compatibility-version.txt'),
        '1\n'
      );
      writeFileSync(join(repositoryRoot, 'apps/api/index.ts'), 'unrelated v1\n');

      const reader = createGitBuildInputReader(repositoryRoot);
      const baselineRef = commit('baseline');
      const baseline = computeVmAgentBuildFingerprint(baselineRef, reader);

      writeFileSync(join(repositoryRoot, 'apps/api/index.ts'), 'unrelated v2\n');
      const unrelatedRef = commit('unrelated API change');
      expect(computeVmAgentBuildFingerprint(unrelatedRef, reader)).toBe(baseline);

      let previous = baseline;
      for (const filename of vmAgentFiles) {
        writeFileSync(join(repositoryRoot, 'packages/vm-agent', filename), `${filename} v2\n`);
        const ref = commit(`change ${filename}`);
        const fingerprint = computeVmAgentBuildFingerprint(ref, reader);
        expect(fingerprint).not.toBe(previous);
        previous = fingerprint;
      }

      writeFileSync(
        join(repositoryRoot, 'scripts/deploy/vm-agent-compatibility-version.txt'),
        '2\n'
      );
      const markerRef = commit('change compatibility marker');
      expect(computeVmAgentBuildFingerprint(markerRef, reader)).not.toBe(previous);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveVmAgentRelease', () => {
  it('carries the last published version and skips build for unchanged inputs', () => {
    expect(
      resolveVmAgentRelease({
        targetVersion: TARGET_VERSION,
        targetFingerprint: TARGET_FINGERPRINT,
        deployed: deployed(),
        skipAgent: false,
      })
    ).toEqual({
      buildAgent: false,
      requiredVersion: OLD_VERSION,
      fingerprint: TARGET_FINGERPRINT,
      reason: 'inputs-unchanged',
    });
  });

  it('publishes and advances when tracked inputs changed', () => {
    expect(
      resolveVmAgentRelease({
        targetVersion: TARGET_VERSION,
        targetFingerprint: TARGET_FINGERPRINT,
        deployed: deployed(OTHER_FINGERPRINT),
        skipAgent: false,
      })
    ).toEqual({
      buildAgent: true,
      requiredVersion: TARGET_VERSION,
      fingerprint: TARGET_FINGERPRINT,
      reason: 'inputs-changed',
    });
  });

  it('publishes on first deployment', () => {
    const result = resolveVmAgentRelease({
      targetVersion: TARGET_VERSION,
      targetFingerprint: TARGET_FINGERPRINT,
      deployed: null,
      skipAgent: false,
    });
    expect(result.buildAgent).toBe(true);
    expect(result.requiredVersion).toBe(TARGET_VERSION);
    expect(result.reason).toBe('first-deploy');
  });

  it('carries a legacy release when its inferred fingerprint matches', () => {
    const result = resolveVmAgentRelease({
      targetVersion: TARGET_VERSION,
      targetFingerprint: TARGET_FINGERPRINT,
      deployed: deployed(null),
      inferredPriorFingerprint: TARGET_FINGERPRINT,
      skipAgent: false,
    });
    expect(result).toMatchObject({
      buildAgent: false,
      requiredVersion: OLD_VERSION,
      reason: 'legacy-fingerprint-match',
    });
  });

  it('publishes when legacy equivalence cannot be proven', () => {
    const result = resolveVmAgentRelease({
      targetVersion: TARGET_VERSION,
      targetFingerprint: TARGET_FINGERPRINT,
      deployed: deployed(null),
      inferredPriorFingerprint: null,
      skipAgent: false,
    });
    expect(result).toMatchObject({
      buildAgent: true,
      requiredVersion: TARGET_VERSION,
      reason: 'legacy-fingerprint-unproven',
    });
  });

  it('preserves the published version for unchanged skip_agent', () => {
    const result = resolveVmAgentRelease({
      targetVersion: TARGET_VERSION,
      targetFingerprint: TARGET_FINGERPRINT,
      deployed: deployed(),
      skipAgent: true,
    });
    expect(result.buildAgent).toBe(false);
    expect(result.requiredVersion).toBe(OLD_VERSION);
  });

  it('rejects first-deploy, changed-input, and unproven skip_agent', () => {
    for (const prior of [null, deployed(OTHER_FINGERPRINT), deployed(null)]) {
      expect(() =>
        resolveVmAgentRelease({
          targetVersion: TARGET_VERSION,
          targetFingerprint: TARGET_FINGERPRINT,
          deployed: prior,
          skipAgent: true,
        })
      ).toThrow(/skip_agent/);
    }
  });

  it('never carries an empty or malformed deployed required version', () => {
    for (const requiredVersion of [null, '', 'not-a-sha']) {
      const result = resolveVmAgentRelease({
        targetVersion: TARGET_VERSION,
        targetFingerprint: TARGET_FINGERPRINT,
        deployed: { requiredVersion, fingerprint: TARGET_FINGERPRINT },
        skipAgent: false,
      });
      expect(result.buildAgent).toBe(true);
      expect(result.requiredVersion).toBe(TARGET_VERSION);
    }
  });
});

describe('getDeployedVmAgentRelease', () => {
  it('returns null only for a confirmed missing Worker', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      getDeployedVmAgentRelease({
        accountId: 'account',
        workerName: 'worker',
        apiToken: 'token',
        fetchImpl,
      })
    ).resolves.toBeNull();
  });

  it('allowlists release bindings without returning other plaintext values', async () => {
    const canary = 'CANARY_SUPER_SECRET_DO_NOT_COPY';
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        result: {
          bindings: [
            { name: 'SETUP_TOKEN', type: 'plain_text', text: canary },
            {
              name: 'VM_AGENT_REQUIRED_VERSION',
              type: 'plain_text',
              text: OLD_VERSION,
            },
            {
              name: 'VM_AGENT_BUILD_FINGERPRINT',
              type: 'plain_text',
              text: TARGET_FINGERPRINT,
            },
          ],
        },
      })
    );
    const result = await getDeployedVmAgentRelease({
      accountId: 'account',
      workerName: 'worker',
      apiToken: 'token',
      fetchImpl,
    });
    expect(result).toEqual({
      requiredVersion: OLD_VERSION,
      fingerprint: TARGET_FINGERPRINT,
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('fails closed on unreadable or malformed settings state', async () => {
    const forbidden = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(
      getDeployedVmAgentRelease({
        accountId: 'account',
        workerName: 'worker',
        apiToken: 'token',
        fetchImpl: forbidden,
      })
    ).rejects.toThrow('HTTP 403');

    const malformed = vi.fn(async () => Response.json({ success: true, result: {} }));
    await expect(
      getDeployedVmAgentRelease({
        accountId: 'account',
        workerName: 'worker',
        apiToken: 'token',
        fetchImpl: malformed,
      })
    ).rejects.toThrow('invalid Worker settings response');
  });
});
