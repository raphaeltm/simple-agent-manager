import { describe, expect, it, beforeAll } from 'vitest';
import * as crypto from 'node:crypto';
import { findRegisteredResource, getOutputValue, getSecretStatus } from './setup';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

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
    await expect(getSecretStatus(secretsModule.deploySigningPublicKey)).resolves.toBe(true);
  });

  it('derives the raw Ed25519 deploy signing public key from the persisted seed', async () => {
    const privateKeySeed = await getOutputValue(secretsModule.deploySigningPrivateKey);
    const publicKey = await getOutputValue(secretsModule.deploySigningPublicKey);
    const privateKeyBytes = Buffer.from(privateKeySeed, 'base64');
    const publicKeyBytes = Buffer.from(publicKey, 'base64');
    expect(privateKeyBytes).toHaveLength(32);
    expect(publicKeyBytes).toHaveLength(32);

    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, privateKeyBytes]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKeyObject = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PUBLIC_KEY_PREFIX, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.from('sam deploy signing compatibility');
    const signature = crypto.sign(null, message, privateKey);

    expect(crypto.verify(null, message, publicKeyObject, signature)).toBe(true);
  });
});
