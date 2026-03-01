/**
 * Wrangler Config Quality Check
 *
 * Enforces two invariants:
 *
 * 1. NO [env.*] sections committed — environment-specific config is generated
 *    at deploy time by scripts/deploy/sync-wrangler-config.ts.
 *
 * 2. Top-level config has all required binding types — the sync script copies
 *    static bindings (Durable Objects, AI, migrations) from top-level into
 *    generated env sections. If they're missing at the top level, they'll be
 *    missing at runtime.
 *
 * This check runs in CI to prevent misconfigurations.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';

const API_WRANGLER_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const TAIL_WORKER_WRANGLER_PATH = resolve(import.meta.dirname, '../../apps/tail-worker/wrangler.toml');

interface Binding {
  name?: string;
  binding?: string;
  class_name?: string;
  [key: string]: unknown;
}

interface DurableObjectConfig {
  bindings?: Binding[];
}

interface AIConfig {
  binding?: string;
}

interface WranglerConfig {
  durable_objects?: DurableObjectConfig;
  d1_databases?: Binding[];
  kv_namespaces?: Binding[];
  r2_buckets?: Binding[];
  ai?: AIConfig;
  migrations?: Array<{ tag: string; [key: string]: unknown }>;
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

function fail(errors: string[]): never {
  console.error('\nWrangler config check FAILED:\n');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error('\nSee: .claude/rules/07-env-and-urls.md\n');
  process.exit(1);
}

function main(): void {
  const errors: string[] = [];

  // ========================================
  // Check 1: No env sections committed
  // ========================================

  const apiContent = readFileSync(API_WRANGLER_PATH, 'utf-8');
  const apiConfig = TOML.parse(apiContent) as unknown as WranglerConfig;

  if (apiConfig.env && Object.keys(apiConfig.env).length > 0) {
    const envNames = Object.keys(apiConfig.env).join(', ');
    errors.push(
      `apps/api/wrangler.toml contains [env.*] sections (${envNames}). ` +
      `These are generated at deploy time by sync-wrangler-config.ts. ` +
      `Remove them from the checked-in file.`
    );
  }

  const tailContent = readFileSync(TAIL_WORKER_WRANGLER_PATH, 'utf-8');
  const tailConfig = TOML.parse(tailContent) as unknown as WranglerConfig;

  if (tailConfig.env && Object.keys(tailConfig.env).length > 0) {
    const envNames = Object.keys(tailConfig.env).join(', ');
    errors.push(
      `apps/tail-worker/wrangler.toml contains [env.*] sections (${envNames}). ` +
      `These are generated at deploy time. Remove them from the checked-in file.`
    );
  }

  // ========================================
  // Check 2: Top-level has required bindings
  // ========================================

  if (!apiConfig.durable_objects?.bindings?.length) {
    errors.push('apps/api/wrangler.toml: top-level missing durable_objects.bindings (sync script copies these to env sections)');
  }

  if (!apiConfig.ai?.binding) {
    errors.push('apps/api/wrangler.toml: top-level missing [ai] binding (sync script copies this to env sections)');
  }

  if (!apiConfig.d1_databases?.length) {
    errors.push('apps/api/wrangler.toml: top-level missing d1_databases');
  }

  if (!apiConfig.kv_namespaces?.length) {
    errors.push('apps/api/wrangler.toml: top-level missing kv_namespaces');
  }

  if (!apiConfig.r2_buckets?.length) {
    errors.push('apps/api/wrangler.toml: top-level missing r2_buckets');
  }

  if (!apiConfig.migrations?.length) {
    errors.push('apps/api/wrangler.toml: top-level missing [[migrations]] (sync script copies these to env sections)');
  }

  // ========================================
  // Result
  // ========================================

  if (errors.length > 0) {
    fail(errors);
  }

  const doCount = apiConfig.durable_objects?.bindings?.length ?? 0;
  const d1Count = apiConfig.d1_databases?.length ?? 0;
  const kvCount = apiConfig.kv_namespaces?.length ?? 0;
  const r2Count = apiConfig.r2_buckets?.length ?? 0;
  const migrationCount = apiConfig.migrations?.length ?? 0;

  console.log('Wrangler config check passed.');
  console.log(`  No [env.*] sections in checked-in files.`);
  console.log(`  Top-level: ${doCount} DOs, ${d1Count} D1, ${kvCount} KV, ${r2Count} R2, AI, ${migrationCount} migrations`);
}

main();
