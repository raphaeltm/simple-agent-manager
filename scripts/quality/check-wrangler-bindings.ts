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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';

const API_WRANGLER_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const TAIL_WORKER_WRANGLER_PATH = resolve(
  import.meta.dirname,
  '../../apps/tail-worker/wrangler.toml'
);
const API_DURABLE_OBJECTS_DIR = resolve(import.meta.dirname, '../../apps/api/src/durable-objects');

const LEGACY_KV_BACKED_DO_CLASSES = new Map<string, string>([
  ['NodeLifecycle', 'v2'],
  ['AdminLogs', 'v3'],
  ['TaskRunner', 'v4'],
  ['CodexRefreshLock', 'v6'],
  ['TrialEventBus', 'v8'],
]);

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
  migrations?: Array<{
    tag: string;
    new_classes?: string[];
    new_sqlite_classes?: string[];
    [key: string]: unknown;
  }>;
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DurableObjectCreateMigration {
  tag: string;
  backend: 'kv' | 'sqlite';
}

function fail(errors: string[]): never {
  console.error('\nWrangler config check FAILED:\n');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error('\nSee: .claude/rules/07-env-and-urls.md\n');
  process.exit(1);
}

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

function legacyClassUsesSqlStorage(className: string): string | undefined {
  const classPattern = new RegExp(`class\\s+${className}\\b`);

  for (const file of listTypeScriptFiles(API_DURABLE_OBJECTS_DIR)) {
    const content = readFileSync(file, 'utf-8');
    if (classPattern.test(content) && /\bstorage\.sql\b/.test(content)) {
      return file.replace(resolve(import.meta.dirname, '../..') + '/', '');
    }
  }

  return undefined;
}

function collectDoCreateMigrations(
  migrations: NonNullable<WranglerConfig['migrations']>
): Map<string, DurableObjectCreateMigration[]> {
  const creates = new Map<string, DurableObjectCreateMigration[]>();

  for (const migration of migrations) {
    for (const className of migration.new_classes ?? []) {
      const existing = creates.get(className) ?? [];
      existing.push({ tag: migration.tag, backend: 'kv' });
      creates.set(className, existing);
    }

    for (const className of migration.new_sqlite_classes ?? []) {
      const existing = creates.get(className) ?? [];
      existing.push({ tag: migration.tag, backend: 'sqlite' });
      creates.set(className, existing);
    }
  }

  return creates;
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
    errors.push(
      'apps/api/wrangler.toml: top-level missing durable_objects.bindings (sync script copies these to env sections)'
    );
  }

  if (!apiConfig.ai?.binding) {
    errors.push(
      'apps/api/wrangler.toml: top-level missing [ai] binding (sync script copies this to env sections)'
    );
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
    errors.push(
      'apps/api/wrangler.toml: top-level missing [[migrations]] (sync script copies these to env sections)'
    );
  }

  // ========================================
  // Check 3: Durable Object migration safety
  // ========================================

  if (apiConfig.durable_objects?.bindings?.length && apiConfig.migrations?.length) {
    const createMigrations = collectDoCreateMigrations(apiConfig.migrations);

    for (const binding of apiConfig.durable_objects.bindings) {
      if (!binding.class_name) {
        errors.push(
          `apps/api/wrangler.toml: Durable Object binding ${binding.name ?? '<unnamed>'} is missing class_name`
        );
        continue;
      }

      const creates = createMigrations.get(binding.class_name) ?? [];
      if (creates.length === 0) {
        errors.push(
          `apps/api/wrangler.toml: Durable Object ${binding.class_name} has a binding but no create migration`
        );
      } else if (creates.length > 1) {
        const tags = creates.map((create) => `${create.tag}:${create.backend}`).join(', ');
        errors.push(
          `apps/api/wrangler.toml: Durable Object ${binding.class_name} has multiple create migrations (${tags})`
        );
      }
    }

    for (const migration of apiConfig.migrations) {
      for (const className of migration.new_classes ?? []) {
        const expectedTag = LEGACY_KV_BACKED_DO_CLASSES.get(className);
        if (!expectedTag) {
          errors.push(
            `apps/api/wrangler.toml: Durable Object ${className} uses legacy new_classes in ${migration.tag}. ` +
              `New Durable Object classes must use new_sqlite_classes so fresh Free-plan installs work.`
          );
        } else if (migration.tag !== expectedTag) {
          errors.push(
            `apps/api/wrangler.toml: legacy Durable Object ${className} must stay in ${expectedTag}; found ${migration.tag}. ` +
              `Changing shipped migration tags can break existing deployments.`
          );
        }
      }
    }

    for (const [className, expectedTag] of LEGACY_KV_BACKED_DO_CLASSES.entries()) {
      const creates = createMigrations.get(className) ?? [];
      const create = creates[0];
      if (!create || create.tag !== expectedTag || create.backend !== 'kv') {
        errors.push(
          `apps/api/wrangler.toml: legacy Durable Object ${className} must remain new_classes in ${expectedTag} for existing paid-plan deployments`
        );
      }

      const sqlFile = legacyClassUsesSqlStorage(className);
      if (sqlFile) {
        errors.push(
          `${sqlFile}: legacy KV-backed Durable Object ${className} uses storage.sql. ` +
            `Existing deployments keep this class on new_classes, so SQL-only APIs are unsafe.`
        );
      }
    }
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
  console.log(
    `  Top-level: ${doCount} DOs, ${d1Count} D1, ${kvCount} KV, ${r2Count} R2, AI, ${migrationCount} migrations`
  );
}

main();
