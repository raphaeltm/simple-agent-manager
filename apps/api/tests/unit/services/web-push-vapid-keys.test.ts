import * as crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  deriveVapidKeyPairFromPem,
  deriveVapidPublicKey,
} from '../../../../../scripts/deploy/vapid-keys';

describe('Web Push VAPID deployment key derivation', () => {
  it('converts a Pulumi-style P-256 PKCS#8 key into matching raw base64url keys', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const pair = deriveVapidKeyPairFromPem(pem);

    expect(Buffer.from(pair.privateKey, 'base64url')).toHaveLength(32);
    const publicBytes = Buffer.from(pair.publicKey, 'base64url');
    expect(publicBytes).toHaveLength(65);
    expect(publicBytes[0]).toBe(0x04);
    expect(deriveVapidPublicKey(pair.privateKey)).toBe(pair.publicKey);
  });

  it('rejects non-P-256 Pulumi key material', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => deriveVapidKeyPairFromPem(pem)).toThrow(/P-256/);
  });

  it('rejects malformed raw private keys', () => {
    expect(() => deriveVapidPublicKey('too-short')).toThrow(/32 bytes/);
  });
});
