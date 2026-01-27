#!/usr/bin/env npx tsx
/**
 * Setup wizard for Cloud AI Workspaces.
 * Guides the user through initial configuration.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function generateSecureKey(length: number = 32): string {
  return crypto.randomBytes(length).toString('base64');
}

async function main() {
  console.log('\n🚀 Cloud AI Workspaces Setup Wizard\n');
  console.log('This wizard will help you configure your environment.\n');
  console.log('─'.repeat(50) + '\n');

  const config: Record<string, string> = {};

  // Domain configuration
  console.log('📡 Domain Configuration\n');
  config.BASE_DOMAIN = await ask('Enter your base domain (e.g., workspaces.example.com): ');

  // Cloudflare configuration
  console.log('\n☁️  Cloudflare Configuration\n');
  console.log('You need a Cloudflare API token with Zone.Zone (Read) and Zone.DNS (Edit) permissions.\n');
  config.CF_API_TOKEN = await ask('Cloudflare API Token: ');
  config.CF_ZONE_ID = await ask('Cloudflare Zone ID: ');

  // GitHub App configuration
  console.log('\n🐙 GitHub App Configuration\n');
  console.log('Create a GitHub App at https://github.com/settings/apps/new\n');
  config.GITHUB_APP_ID = await ask('GitHub App ID: ');
  console.log('\nPaste your GitHub App private key (end with an empty line):');
  let privateKeyLines: string[] = [];
  while (true) {
    const line = await ask('');
    if (line === '') break;
    privateKeyLines.push(line);
  }
  config.GITHUB_APP_PRIVATE_KEY = privateKeyLines.join('\n');

  // GitHub OAuth (for user authentication)
  console.log('\n🔐 GitHub OAuth Configuration (for user login)\n');
  config.GITHUB_CLIENT_ID = await ask('GitHub OAuth Client ID: ');
  config.GITHUB_CLIENT_SECRET = await ask('GitHub OAuth Client Secret: ');

  // Generate security keys
  console.log('\n🔑 Generating Security Keys...\n');
  config.ENCRYPTION_KEY = generateSecureKey();
  console.log('✅ Generated AES-256 encryption key');

  // Generate RSA key pair for JWT
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  config.JWT_PRIVATE_KEY = privateKey;
  config.JWT_PUBLIC_KEY = publicKey;
  config.JWT_KEY_ID = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  console.log('✅ Generated RSA key pair for JWT signing');

  // Generate wrangler secrets
  console.log('\n📝 Generating Configuration Files...\n');

  // Create .env file
  const envContent = Object.entries(config)
    .filter(([key]) => !key.includes('PRIVATE_KEY'))
    .map(([key, value]) => `${key}="${value}"`)
    .join('\n');

  fs.writeFileSync(
    path.join(process.cwd(), '.env'),
    envContent + '\n'
  );
  console.log('✅ Created .env file');

  // Create secrets file for wrangler
  const secretsContent = `# Run these commands to set secrets:
wrangler secret put CF_API_TOKEN
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put ENCRYPTION_KEY
wrangler secret put JWT_PRIVATE_KEY
wrangler secret put JWT_PUBLIC_KEY
`;

  fs.writeFileSync(
    path.join(process.cwd(), 'secrets.txt'),
    secretsContent
  );
  console.log('✅ Created secrets.txt with instructions');

  // Summary
  console.log('\n' + '─'.repeat(50));
  console.log('\n✨ Setup Complete!\n');
  console.log('Next steps:');
  console.log('1. Review .env file and update any values as needed');
  console.log('2. Set Cloudflare Worker secrets using the commands in secrets.txt');
  console.log('3. Deploy the API: pnpm deploy:api');
  console.log('4. Deploy the Web UI: pnpm deploy:web');
  console.log('\nFor more information, see docs/guides/getting-started.md');

  rl.close();
}

main().catch(console.error);
