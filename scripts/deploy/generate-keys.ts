#!/usr/bin/env tsx
/**
 * Generate security keys for LOCAL DEVELOPMENT only.
 *
 * For production deployments, security keys are managed by Pulumi
 * and persist automatically in Pulumi state (encrypted in R2).
 *
 * This script is useful for:
 * - Generating keys for local .env files
 * - Testing key formats
 * - Manual key rotation (advanced users)
 *
 * Usage:
 *   pnpm tsx scripts/deploy/generate-keys.ts
 */

import * as crypto from 'node:crypto';

import { generateDeploySigningKeyPair } from './deploy-signing-keys';

function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { publicKey, privateKey };
}

async function main(): Promise<void> {
  console.log('🔑 Generating security keys for local development\n');
  console.log('NOTE: For production, keys are managed by Pulumi and persist automatically.\n');

  const encryptionKey = generateEncryptionKey();
  const { publicKey, privateKey } = generateKeyPair();
  const deploySigningKey = generateDeploySigningKeyPair();

  console.log('Add these to your apps/api/.env file:\n');
  console.log('# Security keys (auto-generated)');
  console.log(`ENCRYPTION_KEY=${encryptionKey}`);
  console.log(`JWT_PRIVATE_KEY="${privateKey.replaceAll('\n', String.raw`\n`)}"`);
  console.log(`JWT_PUBLIC_KEY="${publicKey.replaceAll('\n', String.raw`\n`)}"`);
  console.log(`DEPLOY_SIGNING_PRIVATE_KEY=${deploySigningKey.privateKey}`);
  console.log(`DEPLOY_SIGNING_PUBLIC_KEY=${deploySigningKey.publicKey}`);
  console.log('');
  console.log('Or copy this formatted version:\n');
  console.log('---');
  console.log(`ENCRYPTION_KEY=${encryptionKey}`);
  console.log(`DEPLOY_SIGNING_PRIVATE_KEY=${deploySigningKey.privateKey}`);
  console.log(`DEPLOY_SIGNING_PUBLIC_KEY=${deploySigningKey.publicKey}`);
  console.log('');
  console.log('JWT_PRIVATE_KEY=');
  console.log(privateKey);
  console.log('');
  console.log('JWT_PUBLIC_KEY=');
  console.log(publicKey);
  console.log('---');
}

main().catch((error) => {
  console.error('❌ Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
