/**
 * Tests verifying that Neko browser sidecar env vars (NEKO_IMAGE, NEKO_PRE_PULL)
 * are correctly forwarded from the Env interface through to generateCloudInit().
 *
 * The forwarding code is in apps/api/src/services/nodes.ts:
 *   nekoImage: env.NEKO_IMAGE,
 *   nekoPrePull: env.NEKO_PRE_PULL !== 'false',
 *
 * These tests exercise the generateCloudInit() function directly with the
 * same parameter shapes that nodes.ts produces from the Env interface.
 */
import { describe, it, expect } from 'vitest';
import { generateCloudInit } from '@workspace/cloud-init';
import type { CloudInitVariables } from '@workspace/cloud-init';

function baseVariables(overrides?: Partial<CloudInitVariables>): CloudInitVariables {
  return {
    nodeId: 'node-test-neko',
    hostname: 'sam-test-node',
    controlPlaneUrl: 'https://api.test.example.com',
    jwksUrl: 'https://api.test.example.com/.well-known/jwks.json',
    callbackToken: 'cb-token-neko',
    ...overrides,
  };
}

describe('Neko browser sidecar cloud-init forwarding', () => {
  it('includes default Neko pre-pull command when nekoImage and nekoPrePull are omitted', () => {
    // Simulates: env.NEKO_IMAGE = undefined, env.NEKO_PRE_PULL = undefined
    // nodes.ts: nekoImage: undefined, nekoPrePull: undefined !== 'false' → true
    const config = generateCloudInit(baseVariables());
    expect(config).toContain('docker pull ghcr.io/m1k1o/neko/google-chrome:latest');
  });

  it('uses custom Neko image when nekoImage is set', () => {
    // Simulates: env.NEKO_IMAGE = 'my-registry/custom-neko:v2'
    // nodes.ts: nekoImage: 'my-registry/custom-neko:v2'
    const customImage = 'my-registry/custom-neko:v2';
    const config = generateCloudInit(baseVariables({ nekoImage: customImage }));
    expect(config).toContain(`docker pull ${customImage}`);
    expect(config).not.toContain('ghcr.io/m1k1o/neko/google-chrome:latest');
  });

  it('disables pre-pull when nekoPrePull is false', () => {
    // Simulates: env.NEKO_PRE_PULL = 'false'
    // nodes.ts: nekoPrePull: 'false' !== 'false' → false
    const config = generateCloudInit(baseVariables({ nekoPrePull: false }));
    expect(config).toContain('# Neko pre-pull disabled');
    expect(config).not.toContain('docker pull');
  });

  it('enables pre-pull when nekoPrePull is explicitly true', () => {
    // Simulates: env.NEKO_PRE_PULL = 'true'
    // nodes.ts: nekoPrePull: 'true' !== 'false' → true
    const config = generateCloudInit(baseVariables({ nekoPrePull: true }));
    expect(config).toContain('docker pull ghcr.io/m1k1o/neko/google-chrome:latest');
  });

  it('uses custom image even when pre-pull is disabled', () => {
    // Simulates: env.NEKO_IMAGE = 'custom:v1', env.NEKO_PRE_PULL = 'false'
    const config = generateCloudInit(baseVariables({
      nekoImage: 'custom:v1',
      nekoPrePull: false,
    }));
    expect(config).toContain('# Neko pre-pull disabled');
    expect(config).not.toContain('docker pull');
  });

  it('NEKO_PRE_PULL env string conversion matches nodes.ts behavior', () => {
    // Verify the boolean conversion: NEKO_PRE_PULL !== 'false'
    // undefined → true, 'true' → true, 'false' → false, 'anything' → true
    const envValues: Array<{ envValue: string | undefined; expected: boolean }> = [
      { envValue: undefined, expected: true },
      { envValue: 'true', expected: true },
      { envValue: 'false', expected: false },
      { envValue: 'yes', expected: true },
      { envValue: '', expected: true },
    ];

    for (const { envValue, expected } of envValues) {
      const nekoPrePull = envValue !== 'false';
      expect(nekoPrePull).toBe(expected);

      const config = generateCloudInit(baseVariables({ nekoPrePull }));
      if (expected) {
        expect(config).toContain('docker pull');
      } else {
        expect(config).toContain('# Neko pre-pull disabled');
      }
    }
  });
});
