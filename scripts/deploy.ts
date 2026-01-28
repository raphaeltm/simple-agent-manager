#!/usr/bin/env npx tsx
/**
 * Deploy script for Simple Agent Manager.
 * Deploys both API and Web to production.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PRODUCTION_ENV = 'production';

function run(command: string, cwd?: string): void {
  console.log(`$ ${command}`);
  execSync(command, { stdio: 'inherit', cwd });
}

function checkPrerequisites(): boolean {
  console.log('🔍 Checking prerequisites...\n');

  // Check for wrangler
  try {
    execSync('wrangler --version', { stdio: 'pipe' });
    console.log('✅ Wrangler CLI installed');
  } catch {
    console.error('❌ Wrangler CLI not found. Install with: npm install -g wrangler');
    return false;
  }

  // Check for .env or secrets
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found. Run: pnpm setup');
    return false;
  }
  console.log('✅ Environment file exists');

  return true;
}

async function deployAPI(): Promise<void> {
  console.log('\n📡 Deploying API to Cloudflare Workers...\n');

  const apiDir = path.join(process.cwd(), 'apps', 'api');

  // Build
  run('pnpm build', apiDir);

  // Deploy
  run(`wrangler deploy --env ${PRODUCTION_ENV}`, apiDir);

  console.log('\n✅ API deployed successfully');
}

async function deployWeb(): Promise<void> {
  console.log('\n🌐 Deploying Web UI to Cloudflare Pages...\n');

  const webDir = path.join(process.cwd(), 'apps', 'web');

  // Build
  run('pnpm build', webDir);

  // Deploy (using Cloudflare Pages)
  run(`wrangler pages deploy dist --project-name simple-agent-manager`, webDir);

  console.log('\n✅ Web UI deployed successfully');
}

async function deployVMAgent(): Promise<void> {
  console.log('\n🤖 Building and uploading VM Agent...\n');

  const agentDir = path.join(process.cwd(), 'packages', 'vm-agent');

  // Build for all platforms
  run('make build-all', agentDir);

  // Upload to R2 (if configured)
  const binDir = path.join(agentDir, 'bin');
  const binaries = fs.readdirSync(binDir).filter(f => f.startsWith('vm-agent-'));

  for (const binary of binaries) {
    const binaryPath = path.join(binDir, binary);
    console.log(`Uploading ${binary}...`);
    run(`wrangler r2 object put agents/${binary} --file ${binaryPath} --env ${PRODUCTION_ENV}`);
  }

  // Upload version info
  const versionInfo = {
    version: process.env.npm_package_version || '0.1.0',
    buildDate: new Date().toISOString(),
  };
  const versionPath = path.join(binDir, 'version.json');
  fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2));
  run(`wrangler r2 object put agents/version.json --file ${versionPath} --env ${PRODUCTION_ENV}`);

  console.log('\n✅ VM Agent uploaded successfully');
}

async function runMigrations(): Promise<void> {
  console.log('\n🗄️  Running database migrations...\n');

  const apiDir = path.join(process.cwd(), 'apps', 'api');

  run(`wrangler d1 migrations apply simple-agent-manager --env ${PRODUCTION_ENV}`, apiDir);

  console.log('\n✅ Migrations applied');
}

async function main() {
  const args = process.argv.slice(2);
  const skipChecks = args.includes('--skip-checks');
  const apiOnly = args.includes('--api');
  const webOnly = args.includes('--web');
  const agentOnly = args.includes('--agent');
  const migrationsOnly = args.includes('--migrations');

  console.log('🚀 Simple Agent Manager Deploy\n');
  console.log('─'.repeat(50) + '\n');

  if (!skipChecks && !checkPrerequisites()) {
    process.exit(1);
  }

  try {
    if (migrationsOnly) {
      await runMigrations();
    } else if (apiOnly) {
      await deployAPI();
    } else if (webOnly) {
      await deployWeb();
    } else if (agentOnly) {
      await deployVMAgent();
    } else {
      // Full deploy
      await runMigrations();
      await deployAPI();
      await deployWeb();
      await deployVMAgent();
    }

    console.log('\n' + '─'.repeat(50));
    console.log('\n🎉 Deployment complete!\n');
  } catch (error) {
    console.error('\n❌ Deployment failed:', error);
    process.exit(1);
  }
}

main();
