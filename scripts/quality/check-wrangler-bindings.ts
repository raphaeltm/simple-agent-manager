/**
 * Wrangler Config Quality Check
 *
 * Enforces two invariants:
 *
 * 1. NO [env.*] sections committed — environment-specific config is generated
 *    at deploy time by scripts/deploy/sync-wrangler-config.ts.
 *
 * 2. Top-level config has all required binding types — the sync script copies
 *    static bindings and resolves migrations from the top-level declarations.
 *    If they're missing at the top level, they'll be missing at runtime.
 *
 * 3. Worker secret inventory comments stay aligned with configure-secrets.sh
 *    so operator-facing docs/config comments do not silently drift.
 *
 * This check runs in CI to prevent misconfigurations.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';

const API_WRANGLER_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const TAIL_WORKER_WRANGLER_PATH = resolve(
  import.meta.dirname,
  '../../apps/tail-worker/wrangler.toml'
);
const CONFIGURE_SECRETS_PATH = resolve(import.meta.dirname, '../deploy/configure-secrets.sh');
const SECRET_COMMENT_PATTERN = /^# - `?([A-Z0-9_]+)`?/;
const sortAlphabetically = (left: string, right: string): number => left.localeCompare(right);

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

function extractConfiguredWorkerSecrets(scriptContent: string): string[] {
  return Array.from(
    new Set(
      Array.from(scriptContent.matchAll(/set_worker_secret\s+"([A-Z0-9_]+)"/g), (match) => match[1])
    )
  ).sort(sortAlphabetically);
}

function extractWranglerCommentedSecrets(wranglerContent: string): string[] {
  const secretsHeader = 'Secrets (set via wrangler secret put):';
  const start = wranglerContent.indexOf(secretsHeader);
  if (start === -1) {
    return [];
  }

  const headerLineEnd = wranglerContent.indexOf('\n', start);
  if (headerLineEnd === -1) {
    return [];
  }

  const afterHeader = wranglerContent.slice(headerLineEnd + 1);
  const lines = afterHeader.split('\n');
  const secrets: string[] = [];

  for (const line of lines) {
    if (!line.startsWith('#')) {
      break;
    }
    const match = SECRET_COMMENT_PATTERN.exec(line);
    if (match) {
      secrets.push(match[1]);
    }
  }

  return Array.from(new Set(secrets)).sort(sortAlphabetically);
}

function diffSecrets(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((name) => !actualSet.has(name)),
    extra: actual.filter((name) => !expectedSet.has(name)),
  };
}

function checkNoCommittedEnvSections(errors: string[], config: WranglerConfig, path: string): void {
  if (!config.env || Object.keys(config.env).length === 0) {
    return;
  }

  const envNames = Object.keys(config.env).join(', ');
  errors.push(
    `${path} contains [env.*] sections (${envNames}). These are generated at deploy time. Remove them from the checked-in file.`
  );
}

function checkRequiredApiBindings(errors: string[], apiConfig: WranglerConfig): void {
  const requiredBindingChecks: Array<{ isPresent: boolean; message: string }> = [
    {
      isPresent: Boolean(apiConfig.durable_objects?.bindings?.length),
      message:
        'apps/api/wrangler.toml: top-level missing durable_objects.bindings (sync script copies these to env sections)',
    },
    {
      isPresent: Boolean(apiConfig.ai?.binding),
      message:
        'apps/api/wrangler.toml: top-level missing [ai] binding (sync script copies this to env sections)',
    },
    {
      isPresent: Boolean(apiConfig.d1_databases?.length),
      message: 'apps/api/wrangler.toml: top-level missing d1_databases',
    },
    {
      isPresent: Boolean(apiConfig.kv_namespaces?.length),
      message: 'apps/api/wrangler.toml: top-level missing kv_namespaces',
    },
    {
      isPresent: Boolean(apiConfig.r2_buckets?.length),
      message: 'apps/api/wrangler.toml: top-level missing r2_buckets',
    },
    {
      isPresent: Boolean(apiConfig.migrations?.length),
      message:
        'apps/api/wrangler.toml: top-level missing [[migrations]] (sync script resolves these into env sections)',
    },
  ];

  for (const check of requiredBindingChecks) {
    if (!check.isPresent) {
      errors.push(check.message);
    }
  }
}

function checkSecretInventory(
  errors: string[],
  configuredSecrets: string[],
  commentedSecrets: string[]
): void {
  if (commentedSecrets.length === 0) {
    errors.push(
      'apps/api/wrangler.toml: missing "# Secrets (set via wrangler secret put):" inventory comment'
    );
    return;
  }

  const { missing, extra } = diffSecrets(configuredSecrets, commentedSecrets);
  if (missing.length > 0) {
    errors.push(
      `apps/api/wrangler.toml secret inventory is missing configured secrets from configure-secrets.sh: ${missing.join(', ')}`
    );
  }
  if (extra.length > 0) {
    errors.push(
      `apps/api/wrangler.toml secret inventory lists secrets not configured by configure-secrets.sh: ${extra.join(', ')}`
    );
  }
}

function logSuccess(apiConfig: WranglerConfig, configuredSecrets: string[]): void {
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
  console.log(
    `  Worker secret inventory: ${configuredSecrets.length} configured secrets documented.`
  );
}

function main(): void {
  const errors: string[] = [];
  const apiContent = readFileSync(API_WRANGLER_PATH, 'utf-8');
  const apiConfig = TOML.parse(apiContent) as unknown as WranglerConfig;
  const configureSecretsContent = readFileSync(CONFIGURE_SECRETS_PATH, 'utf-8');
  const tailContent = readFileSync(TAIL_WORKER_WRANGLER_PATH, 'utf-8');
  const tailConfig = TOML.parse(tailContent) as unknown as WranglerConfig;
  const configuredSecrets = extractConfiguredWorkerSecrets(configureSecretsContent);
  const commentedSecrets = extractWranglerCommentedSecrets(apiContent);

  checkNoCommittedEnvSections(errors, apiConfig, 'apps/api/wrangler.toml');
  checkNoCommittedEnvSections(errors, tailConfig, 'apps/tail-worker/wrangler.toml');
  checkRequiredApiBindings(errors, apiConfig);
  checkSecretInventory(errors, configuredSecrets, commentedSecrets);

  if (errors.length > 0) {
    fail(errors);
  }

  logSuccess(apiConfig, configuredSecrets);
}

main();
