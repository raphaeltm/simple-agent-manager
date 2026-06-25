import { describe, expect, it, beforeAll } from 'vitest';
import { findRegisteredResource, getOutputValue, getSecretStatus } from './setup';

describe('Security Key Resources', () => {
  let secretsModule: typeof import('../resources/secrets');

  beforeAll(async () => {
    secretsModule = await import('../resources/secrets');
  });

  it('protects 32-byte random secrets for encryption, trial claims, and deploy signing', () => {
    const encryptionKey = findRegisteredResource(
      'encryption-key',
      'random:index/randomId:RandomId'
    );
    expect(encryptionKey.inputs).toMatchObject({ byteLength: 32 });
    expect(encryptionKey.options.protect).toBe(true);

    const trialClaimSecret = findRegisteredResource(
      'trial-claim-token-secret',
      'random:index/randomId:RandomId'
    );
    expect(trialClaimSecret.inputs).toMatchObject({ byteLength: 32 });
    expect(trialClaimSecret.options.protect).toBe(true);

    const deploySigningKey = findRegisteredResource(
      'deploy-signing-private-key',
      'random:index/randomId:RandomId'
    );
    expect(deploySigningKey.inputs).toMatchObject({ byteLength: 32 });
    expect(deploySigningKey.options.protect).toBe(true);
  });

  it('protects the RSA-2048 JWT signing key', () => {
    const jwtKey = findRegisteredResource('jwt-signing-key', 'tls:index/privateKey:PrivateKey');

    expect(jwtKey.inputs).toMatchObject({
      algorithm: 'RSA',
      rsaBits: 2048,
    });
    expect(jwtKey.options.protect).toBe(true);
  });

  it('exports generated security values as Pulumi secrets', async () => {
    await expect(getSecretStatus(secretsModule.encryptionKey)).resolves.toBe(true);
    await expect(getSecretStatus(secretsModule.jwtPrivateKey)).resolves.toBe(true);
    await expect(getSecretStatus(secretsModule.jwtPublicKey)).resolves.toBe(true);
    await expect(getSecretStatus(secretsModule.trialClaimTokenSecret)).resolves.toBe(true);
    await expect(getSecretStatus(secretsModule.deploySigningPrivateKey)).resolves.toBe(true);
  });

  it('exports a 32-byte Ed25519 seed for deploy signing', async () => {
    const privateKeySeed = await getOutputValue(secretsModule.deploySigningPrivateKey);
    const privateKeyBytes = Buffer.from(privateKeySeed, 'base64');
    expect(privateKeyBytes).toHaveLength(32);
  });
});
