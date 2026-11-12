import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { celldReleaseTarget } from './celld-binary.js';
import { CELLD_RELEASE_SHA256, CELLD_VERSION } from './versions.js';

const COMPOSE = readFileSync(
  resolve(import.meta.dirname, '../../deploy/selfhost/docker-compose.yml'),
  'utf8'
);

describe('pinned versions', () => {
  it('deploys with the same celld version the compose stack runs', () => {
    const image = /image:\s*ghcr\.io\/denoland\/celld:v([0-9.]+)@sha256:[0-9a-f]{64}/.exec(COMPOSE);
    expect(image?.[1]).toBe(CELLD_VERSION);
  });

  it('pins every compose image by digest', () => {
    const images = [...COMPOSE.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]!);
    // Locally built images pin their base images by digest in their Dockerfiles.
    const local: Record<string, string> = {
      'sam-selfhost-caddy:local': 'caddy/Dockerfile',
      'sam-selfhost-egress-fence:local': 'egress-fence/Dockerfile',
      'sam-selfhost-sam-mx:local': 'sam-mx/Dockerfile',
      'sam-selfhost-key-agent:local': 'key-agent/Dockerfile',
    };
    const pulled = images.filter((image) => !(image in local));
    expect(pulled.length).toBeGreaterThanOrEqual(4);
    for (const image of pulled) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    for (const dockerfilePath of Object.values(local)) {
      const dockerfile = readFileSync(
        resolve(import.meta.dirname, '../../deploy/selfhost', dockerfilePath),
        'utf8'
      );
      for (const from of dockerfile.matchAll(/^FROM\s+(\S+)/gm))
        expect(from[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('has a checksum for every release target it can select', () => {
    for (const [os, cpu] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'arm64'],
    ] as const) {
      expect(CELLD_RELEASE_SHA256[celldReleaseTarget(os, cpu)]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(() => celldReleaseTarget('win32', 'x64')).toThrow(/set CELLD_BIN/);
  });
});
