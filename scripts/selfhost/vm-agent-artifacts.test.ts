import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decideVmAgentPublish,
  isR2NoObjectError,
  parseVmAgentRelease,
  VM_AGENT_BUILD_IMAGE,
  vmAgentLegacyKey,
  vmAgentReleaseKey,
} from './vm-agent-artifacts.js';

const RELEASE = 'cabd2fde853d5dfd405714c6b86cc82b6f053782';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('parseVmAgentRelease', () => {
  it('reads the lines resolve-vm-agent-release.sh prints', () => {
    expect(parseVmAgentRelease(`release=${RELEASE}\nbuild_date=2026-11-10T12:23:48Z\n`)).toEqual({
      release: RELEASE,
      buildDate: '2026-11-10T12:23:48Z',
    });
  });

  it('refuses output without a 40-hex release or a parseable date', () => {
    expect(() => parseVmAgentRelease('build_date=2026-11-10T12:23:48Z')).toThrow(/release/);
    expect(() => parseVmAgentRelease('release=abc\nbuild_date=2026-11-10T12:23:48Z')).toThrow(
      /release/
    );
    expect(() => parseVmAgentRelease(`release=${RELEASE}\nbuild_date=never`)).toThrow(/build_date/);
    // Date.parse accepts this; it would reach a make recipe.
    expect(() =>
      parseVmAgentRelease(`release=${RELEASE}\nbuild_date=2026-11-10T12:23:48Z ($(id))`)
    ).toThrow(/build_date/);
    expect(
      parseVmAgentRelease(`release=${RELEASE}\nbuild_date=2026-11-10T12:23:48+01:00`).buildDate
    ).toBe('2026-11-10T12:23:48+01:00');
  });
});

describe('object keys', () => {
  it('match the keys the Cloudflare pipeline publishes (publish-vm-agent-artifacts.sh)', () => {
    const script = readFileSync(
      resolve(import.meta.dirname, '../deploy/publish-vm-agent-artifacts.sh'),
      'utf8'
    );
    const asTemplate = (key: string): string =>
      key.replace(RELEASE, '$VM_AGENT_RELEASE').replace(/amd64$/, '$architecture');
    expect(script).toContain(`$R2_BUCKET/${asTemplate(vmAgentReleaseKey(RELEASE, 'amd64'))}"`);
    expect(script).toContain(`$R2_BUCKET/${asTemplate(vmAgentLegacyKey('amd64'))}"`);
  });

  it('match the keys /api/agent/download reads (routes/agent.ts)', () => {
    expect(vmAgentReleaseKey(RELEASE, 'amd64')).toBe(
      `agents/releases/${RELEASE}/vm-agent-linux-amd64`
    );
    expect(vmAgentLegacyKey('arm64')).toBe('agents/vm-agent-linux-arm64');
  });
});

describe('decideVmAgentPublish', () => {
  const key = vmAgentReleaseKey(RELEASE, 'amd64');

  it('uploads a missing key of either kind', () => {
    expect(decideVmAgentPublish('release', key, null, SHA_A)).toBe('upload');
    expect(decideVmAgentPublish('legacy', vmAgentLegacyKey('amd64'), null, SHA_A)).toBe('upload');
  });

  it('reuses an identical release object', () => {
    expect(decideVmAgentPublish('release', key, SHA_A, SHA_A)).toBe('reuse');
  });

  it('refuses to overwrite a release object holding different bytes', () => {
    expect(() => decideVmAgentPublish('release', key, SHA_A, SHA_B)).toThrow(
      /refusing to overwrite immutable vm-agent artifact/
    );
  });

  it('never advances an existing legacy object, whatever its bytes', () => {
    const legacy = vmAgentLegacyKey('amd64');
    expect(decideVmAgentPublish('legacy', legacy, SHA_A, SHA_B)).toBe('preserve-legacy');
    expect(decideVmAgentPublish('legacy', legacy, SHA_A, SHA_A)).toBe('preserve-legacy');
  });
});

describe('build pins', () => {
  it('builds with the Go toolchain packages/vm-agent/go.mod names, pinned by digest', () => {
    const goMod = readFileSync(
      resolve(import.meta.dirname, '../../packages/vm-agent/go.mod'),
      'utf8'
    );
    const toolchain = /^toolchain go([0-9.]+)$/m.exec(goMod)?.[1];
    expect(toolchain).toBeDefined();
    expect(VM_AGENT_BUILD_IMAGE).toMatch(
      new RegExp(`^golang:${toolchain!.replaceAll('.', '\\.')}-bookworm@sha256:[0-9a-f]{64}$`)
    );
  });

  it("treats only celld's missing-object error for this exact key and bucket as absent", () => {
    // Captured from celld 0.6.3 on the T4 box (`celld r2 get workspaces-dev-assets agents/nope`).
    const real = 'Error: no object "agents/nope" in r2 bucket "workspaces-dev-assets"';
    const logged = `2026-11-10T19:36:40Z  INFO object_store::gcp::credential: fetching token\n${real}\n`;
    expect(isR2NoObjectError(logged, 'workspaces-dev-assets', 'agents/nope')).toBe(true);
    expect(isR2NoObjectError(real, 'other-bucket', 'agents/nope')).toBe(false);
    expect(isR2NoObjectError(real, 'workspaces-dev-assets', 'agents/other')).toBe(false);
    expect(isR2NoObjectError(`prefix ${real}`, 'workspaces-dev-assets', 'agents/nope')).toBe(false);
    expect(
      isR2NoObjectError('Error: no node leases in the bucket', 'workspaces-dev-assets', 'k')
    ).toBe(false);
  });
});
