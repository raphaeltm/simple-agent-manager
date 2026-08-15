import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const P256_PRIVATE_KEY_BYTES = 32;
const P256_PUBLIC_KEY_BYTES = 65;

export interface VapidRawKeyPair {
  privateKey: string;
  publicKey: string;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url VAPID key');
  return Buffer.from(value, 'base64url');
}

/** Derive the uncompressed P-256 public key from a raw 32-byte scalar. */
export function deriveVapidPublicKey(privateKey: string): string {
  const privateBytes = decodeBase64Url(privateKey);
  if (privateBytes.length !== P256_PRIVATE_KEY_BYTES) {
    throw new Error(`VAPID private key must be ${P256_PRIVATE_KEY_BYTES} bytes`);
  }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateBytes);
  const publicKey = ecdh.getPublicKey(undefined, 'uncompressed');
  if (publicKey.length !== P256_PUBLIC_KEY_BYTES || publicKey[0] !== 0x04) {
    throw new Error('Derived VAPID public key is not uncompressed P-256');
  }
  return publicKey.toString('base64url');
}

/** Convert a Pulumi tls.PrivateKey PKCS#8 value into browser/Worker raw keys. */
export function deriveVapidKeyPairFromPem(privateKeyPem: string): VapidRawKeyPair {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new Error('VAPID private key is not valid PKCS#8 PEM');
  }
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error('VAPID private key must use the P-256 curve');
  }
  const privateBytes = decodeBase64Url(jwk.d);
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  if (privateBytes.length !== 32 || x.length !== 32 || y.length !== 32) {
    throw new Error('VAPID P-256 JWK has invalid coordinate length');
  }
  const pair = {
    privateKey: privateBytes.toString('base64url'),
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
  };
  if (deriveVapidPublicKey(pair.privateKey) !== pair.publicKey) {
    throw new Error('VAPID derived public key does not match the private key');
  }
  return pair;
}

function main(): void {
  const command = process.argv[2];
  if (command === 'derive-public-from-raw') {
    process.stdout.write(deriveVapidPublicKey(process.env.VAPID_PRIVATE_KEY_INPUT ?? ''));
    return;
  }
  const pair = deriveVapidKeyPairFromPem(process.env.VAPID_PRIVATE_KEY_PEM_INPUT ?? '');
  if (command === 'derive-public-from-pem') {
    process.stdout.write(pair.publicKey);
    return;
  }
  if (command === 'derive-private-from-pem') {
    process.stdout.write(pair.privateKey);
    return;
  }
  throw new Error(
    'Usage: vapid-keys.ts derive-public-from-raw|derive-public-from-pem|derive-private-from-pem'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
