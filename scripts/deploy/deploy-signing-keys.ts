import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function deriveDeploySigningPublicKey(privateKeyB64: string): string {
  const privateKeyBytes = Buffer.from(privateKeyB64, 'base64');
  if (privateKeyBytes.length !== 32 && privateKeyBytes.length !== 64) {
    throw new Error(
      `DEPLOY_SIGNING_PRIVATE_KEY has invalid length: got ${privateKeyBytes.length} bytes, expected 32 (seed) or 64 (seed+pubkey)`
    );
  }

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, privateKeyBytes.subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicDer = crypto.createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;

  if (
    !publicDer
      .subarray(0, ED25519_SPKI_PUBLIC_KEY_PREFIX.length)
      .equals(ED25519_SPKI_PUBLIC_KEY_PREFIX)
  ) {
    throw new Error('derived DEPLOY_SIGNING_PUBLIC_KEY has unexpected Ed25519 SPKI prefix');
  }

  return publicDer.subarray(ED25519_SPKI_PUBLIC_KEY_PREFIX.length).toString('base64');
}

export function generateDeploySigningKeyPair(): { publicKey: string; privateKey: string } {
  const privateKey = crypto.randomBytes(32).toString('base64');
  return {
    privateKey,
    publicKey: deriveDeploySigningPublicKey(privateKey),
  };
}

function main(): void {
  const command = process.argv[2];
  if (command !== 'derive-public') {
    throw new Error('Usage: deploy-signing-keys.ts derive-public');
  }

  process.stdout.write(
    deriveDeploySigningPublicKey(process.env.DEPLOY_SIGNING_PRIVATE_KEY_INPUT ?? '')
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
