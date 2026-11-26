import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { getOutputValue, getRegisteredResources, getSecretStatus } from './setup';

const INFRA = join(__dirname, '..');
const RANDOM_ID = 'random:index/randomId:RandomId';

/** Every non-test TypeScript file of the Pulumi program. */
function programSources(): Array<{ file: string; text: string }> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__', 'bin'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(INFRA);
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

describe('installation identity and the retired key resources', () => {
  let secretsModule: typeof import('../resources/secrets');

  beforeAll(async () => {
    secretsModule = await import('../resources/secrets');
  });

  it('declares only the installation identity and the retirement marker', () => {
    const declared = getRegisteredResources()
      .filter((resource) => resource.type === RANDOM_ID)
      .map((resource) => resource.name)
      .sort();
    expect(declared).toEqual(['installation-id', 'installation-keys-retired']);
  });

  it.each([
    'encryption-key',
    'deploy-signing-private-key',
    'preview-signing-key',
    'trial-claim-token-secret',
    'jwt-signing-key',
    'vapid-key',
  ])('no longer declares the key resource %s', (name) => {
    expect(getRegisteredResources().map((resource) => resource.name)).not.toContain(name);
  });

  it('protects the marker, which holds no secret', () => {
    const marker = getRegisteredResources().find(
      (resource) => resource.name === 'installation-keys-retired'
    );
    expect(marker?.type).toBe(RANDOM_ID);
    expect(marker?.inputs).toEqual({ byteLength: 1 });
    expect(marker?.options.protect).toBe(true);
  });

  it('protects a stable 128-bit non-secret installation identity', async () => {
    const identity = getRegisteredResources().find(
      (resource) => resource.name === 'installation-id'
    );
    expect(identity?.inputs).toMatchObject({ byteLength: 16 });
    expect(identity?.options.protect).toBe(true);
    await expect(getSecretStatus(secretsModule.installationId)).resolves.toBe(false);
    await expect(getOutputValue(secretsModule.installationId)).resolves.toMatch(/^[0-9a-f]{32}$/);
  });

  it('exports nothing but the installation identity', () => {
    expect(Object.keys(secretsModule)).toEqual(['installationId']);
  });
});

describe('the Pulumi program holds no installation key', () => {
  it('generates no random secret other than the identity and the marker', () => {
    const generators = programSources().flatMap(({ file, text }) =>
      [...text.matchAll(/new\s+random\.(\w+)\(\s*['"`]([^'"`]+)['"`]/g)].map(
        (match) => `${file.slice(INFRA.length + 1)} ${match[1]} ${match[2]}`
      )
    );
    expect(generators.sort()).toEqual([
      'resources/secrets.ts RandomId installation-id',
      'resources/secrets.ts RandomId installation-keys-retired',
    ]);
  });

  it('generates no private key other than the legacy Origin CA key', () => {
    // The Origin CA key, CSR and certificate are retired by a separate approved change (decision
    // D3, tasks/backlog/2026-11-26-retire-origin-ca-key.md).
    const keys = programSources().flatMap(({ file, text }) =>
      [...text.matchAll(/new\s+tls\.PrivateKey\(\s*['"`]([^'"`]+)['"`]/g)].map(
        (match) => `${file.slice(INFRA.length + 1)} ${match[1]}`
      )
    );
    expect(keys).toEqual(['resources/origin-ca.ts origin-ca-key']);
  });

  it('exports nothing named like a key, secret, token or PEM from the stack', async () => {
    const stack = await import('../index');
    const keyLike = Object.keys(stack).filter((name) => /key|secret|token|pem|password/i.test(name));
    // The legacy Origin CA pair is retired by decision D3 (tasks/backlog/2026-11-26-retire-origin-ca-key.md).
    expect(keyLike.sort()).toEqual(['originCaCertPem', 'originCaKeyPem']);
  });

  it('exports no installation key from the stack', () => {
    const index = readFileSync(join(INFRA, 'index.ts'), 'utf8');
    for (const name of [
      'encryptionKey',
      'jwtPrivateKey',
      'jwtPublicKey',
      'deploySigningPrivateKey',
      'previewSigningKey',
      'vapidPrivateKeyPem',
    ])
      expect(index).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});
