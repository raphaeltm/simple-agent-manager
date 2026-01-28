#!/usr/bin/env npx tsx
/**
 * Generate security keys for Simple Agent Manager.
 * Creates RSA key pair for JWT and AES key for encryption.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function generateKeyPair(): { publicKey: string; privateKey: string; keyId: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const keyId = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  return { publicKey, privateKey, keyId };
}

function main() {
  const outputDir = process.argv[2] || '.';

  console.log('🔑 Generating Security Keys\n');

  // Generate encryption key
  const encryptionKey = generateEncryptionKey();
  console.log('✅ Generated AES-256 encryption key');

  // Generate RSA key pair
  const { publicKey, privateKey, keyId } = generateKeyPair();
  console.log('✅ Generated RSA-2048 key pair');
  console.log(`   Key ID: ${keyId}`);

  // Output
  console.log('\n' + '─'.repeat(50) + '\n');

  if (process.argv.includes('--env')) {
    // Output as environment variables
    console.log('# Add these to your .env or wrangler.toml:\n');
    console.log(`ENCRYPTION_KEY="${encryptionKey}"`);
    console.log(`JWT_KEY_ID="${keyId}"`);
    console.log(`JWT_PUBLIC_KEY="${publicKey.replace(/\n/g, '\\n')}"`);
    console.log(`JWT_PRIVATE_KEY="${privateKey.replace(/\n/g, '\\n')}"`);
  } else if (process.argv.includes('--files')) {
    // Output as files
    const keysDir = path.join(outputDir, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });

    fs.writeFileSync(path.join(keysDir, 'encryption.key'), encryptionKey);
    fs.writeFileSync(path.join(keysDir, 'jwt.pub'), publicKey);
    fs.writeFileSync(path.join(keysDir, 'jwt.key'), privateKey);
    fs.writeFileSync(path.join(keysDir, 'jwt.kid'), keyId);

    console.log(`Keys written to: ${keysDir}/`);
    console.log('  - encryption.key');
    console.log('  - jwt.pub');
    console.log('  - jwt.key');
    console.log('  - jwt.kid');
  } else {
    // Output to console
    console.log('ENCRYPTION_KEY (AES-256):');
    console.log(encryptionKey);
    console.log('\nJWT_KEY_ID:');
    console.log(keyId);
    console.log('\nJWT_PUBLIC_KEY:');
    console.log(publicKey);
    console.log('\nJWT_PRIVATE_KEY:');
    console.log(privateKey);
  }

  console.log('\n⚠️  Keep these keys secure! Do not commit them to version control.');
}

main();
