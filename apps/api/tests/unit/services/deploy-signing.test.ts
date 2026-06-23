import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashInterpolationEnv, signDeployPayload } from '../../../src/services/deploy-signing';

const TEST_SEED_B64 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const TEST_PUBLIC_KEY_B64 = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=';
const CONTRACT_FIXTURE_URL = new URL(
  '../../../../../tests/fixtures/deploy-release/apply-payload-with-routes.json',
  import.meta.url,
);

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function signableBytes(payload: {
  environmentId: string;
  nodeId: string;
  seq: number;
  expiresAt: number;
  composeYaml: string;
  routes?: unknown;
  artifacts?: unknown;
  interpolationEnv?: Record<string, string>;
}): Promise<Uint8Array> {
  const canonical = JSON.stringify({
    environmentId: payload.environmentId,
    nodeId: payload.nodeId,
    seq: payload.seq,
    expiresAt: payload.expiresAt,
    composeHash: await sha256Hex(payload.composeYaml),
    routesHash: await sha256Hex(JSON.stringify(payload.routes ?? [])),
    interpolationEnvHash: await hashInterpolationEnv(payload.interpolationEnv),
    artifactsHash: await sha256Hex(JSON.stringify(payload.artifacts ?? [])),
  });
  return new TextEncoder().encode(canonical);
}

describe('signDeployPayload', () => {
  it('hashes interpolation env as sorted key-value entries', async () => {
    await expect(hashInterpolationEnv({ B: 'two', A: 'one' })).resolves.toBe(
      await hashInterpolationEnv({ A: 'one', B: 'two' })
    );
    await expect(hashInterpolationEnv({
      DATABASE_URL: 'postgres://user:pass@host/db',
      MULTILINE_SECRET: 'line one\nline two',
    })).resolves.toBe(
      await sha256Hex(JSON.stringify([
        ['DATABASE_URL', 'postgres://user:pass@host/db'],
        ['MULTILINE_SECRET', 'line one\nline two'],
      ]))
    );
    await expect(hashInterpolationEnv(undefined)).resolves.toBe(
      await sha256Hex(JSON.stringify([]))
    );
  });

  it('signs payloads with a seed key that verifies with the public key', async () => {
    const payload = {
      environmentId: 'env-1',
      nodeId: 'node-1',
      seq: 7,
      expiresAt: 1_800_000_000,
      composeYaml: 'services:\n  web:\n    image: nginx\n',
      routes: [
        {
          hostname: 'r1-web-env.apps.example.com',
          service: 'web',
          containerPort: 3000,
          hostPort: 35000,
        },
      ],
      interpolationEnv: {
        DATABASE_URL: 'postgres://example',
      },
    };

    const signature = await signDeployPayload(payload, {
      DEPLOY_SIGNING_PRIVATE_KEY: TEST_SEED_B64,
    });

    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64(TEST_PUBLIC_KEY_B64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    await expect(crypto.subtle.verify(
      'Ed25519',
      publicKey,
      fromBase64(signature),
      await signableBytes(payload),
    )).resolves.toBe(true);
  });

  it('accepts Go-format private keys containing seed plus public key bytes', async () => {
    const goPrivateKey = Buffer.concat([
      Buffer.from(TEST_SEED_B64, 'base64'),
      Buffer.from(TEST_PUBLIC_KEY_B64, 'base64'),
    ]).toString('base64');

    await expect(signDeployPayload({
      environmentId: 'env-1',
      nodeId: 'node-1',
      seq: 1,
      expiresAt: 1_800_000_000,
      composeYaml: 'services: {}\n',
      routes: [],
      interpolationEnv: {},
    }, {
      DEPLOY_SIGNING_PRIVATE_KEY: goPrivateKey,
    })).resolves.toEqual(expect.any(String));
  });

  it('includes artifact descriptors in the signed payload', async () => {
    const payload = {
      environmentId: 'env-1',
      nodeId: 'node-1',
      seq: 8,
      expiresAt: 1_800_000_000,
      composeYaml: 'services:\n  web:\n    image: sam-env-web:rel\n',
      routes: [],
      artifacts: [
        {
          serviceName: 'web',
          sourceRef: 'workspace-web',
          localImageRef: 'sam-env-web:rel',
          r2Key: 'compose-image-artifacts/proj/env/ws/upload/web.tar',
          sizeBytes: 12,
          archiveSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          archiveType: 'docker-save',
          mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
          downloadUrl: 'https://r2.example/web.tar',
          downloadExpiresIn: 900,
        },
      ],
      interpolationEnv: {},
    };
    const signature = await signDeployPayload(payload, {
      DEPLOY_SIGNING_PRIVATE_KEY: TEST_SEED_B64,
    });
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64(TEST_PUBLIC_KEY_B64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const mutated = {
      ...payload,
      artifacts: [
        {
          ...payload.artifacts[0],
          r2Key: 'compose-image-artifacts/proj/env/ws/upload/other.tar',
        },
      ],
    };

    await expect(crypto.subtle.verify(
      'Ed25519',
      publicKey,
      fromBase64(signature),
      await signableBytes(mutated),
    )).resolves.toBe(false);
  });

  it('matches the shared API-to-vm-agent route payload contract fixture', async () => {
    const fixture = JSON.parse(readFileSync(CONTRACT_FIXTURE_URL, 'utf8')) as {
      environmentId: string;
      nodeId: string;
      seq: number;
      expiresAt: number;
      composeYaml: string;
      routes: unknown[];
      signature: string;
    };

    await expect(signDeployPayload(fixture, {
      DEPLOY_SIGNING_PRIVATE_KEY: TEST_SEED_B64,
    })).resolves.toBe(fixture.signature);
  });
});
