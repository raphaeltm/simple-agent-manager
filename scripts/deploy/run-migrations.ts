#!/usr/bin/env tsx
/**
 * Run database migrations
 *
 * This script reads the database name from wrangler.toml and runs migrations.
 * It supports both local and remote migrations.
 *
 * Usage:
 *   pnpm tsx scripts/deploy/run-migrations.ts --env staging|production
 *   pnpm tsx scripts/deploy/run-migrations.ts --local
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';
import { ExecD1MigrationSafetyRunner, runSafeRemoteMigrations } from './d1-migration-safety.js';
import type { D1DatabaseTarget } from './d1-migration-safety.js';
import type { WranglerToml } from './types.js';

const WRANGLER_TOML_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');

function loadWranglerToml(): WranglerToml {
  const content = readFileSync(WRANGLER_TOML_PATH, 'utf-8');
  return TOML.parse(content) as WranglerToml;
}

function getDatabaseNames(config: WranglerToml, environment?: string): D1DatabaseTarget[] {
  const databases =
    environment && config.env?.[environment]?.d1_databases
      ? config.env[environment].d1_databases
      : config.d1_databases;

  if (!databases || databases.length === 0) {
    throw new Error('No D1 database configuration found');
  }

  return databases.map((db) => ({
    binding: db.binding,
    name: db.database_name,
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf('--env');
  const environment = envIndex >= 0 ? args[envIndex + 1] : undefined;
  const isLocal = args.includes('--local');

  if (isLocal && environment) {
    throw new Error('Use either --local or --env <environment>, not both');
  }

  if (!isLocal && !environment) {
    throw new Error('--env <environment> is required for remote migrations');
  }

  const config = loadWranglerToml();
  const databases = getDatabaseNames(config, environment);

  console.log(`🚀 Running migrations for ${databases.length} database(s)`);
  console.log(`   Environment: ${environment || 'development'}`);
  console.log(`   Mode: ${isLocal ? 'local' : 'remote'}`);
  console.log(`   Databases: ${databases.map((db) => `${db.binding} (${db.name})`).join(', ')}\n`);

  const unsafeRemote = args.includes('--unsafe-remote-migrations-i-understand-data-loss-risk');
  const appsApiDir = resolve(import.meta.dirname, '../../apps/api');

  if (!isLocal && !unsafeRemote) {
    runSafeRemoteMigrations({
      environment: environment!,
      databases,
      runner: new ExecD1MigrationSafetyRunner(),
      cwd: appsApiDir,
    });
    console.log(`\n✅ All migrations applied safely!`);
    return;
  }

  if (!isLocal && unsafeRemote) {
    console.error(
      '⚠️  UNSAFE remote migration acknowledgement supplied. Backup/count safety gates are bypassed.'
    );
  }

  for (const db of databases) {
    console.log(`\n📦 Migrating ${db.binding} (${db.name})...\n`);

    const command = [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      db.name,
      isLocal ? '--local' : '--remote',
      ...(environment ? ['--env', environment] : []),
    ];

    console.log(`Executing: pnpm ${command.join(' ')}\n`);

    try {
      new ExecD1MigrationSafetyRunner().execute('pnpm', command, {
        stdio: 'inherit',
        cwd: appsApiDir,
      });
      console.log(`\n✅ ${db.binding} migrations applied successfully!`);
    } catch (error) {
      console.error(`\n❌ Failed to apply migrations for ${db.binding} (${db.name})`);
      process.exit(1);
    }
  }

  console.log(`\n✅ All migrations applied successfully!`);
}

main().catch((error) => {
  console.error('❌ Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
