/**
 * Wrangler Binding Consistency Check
 *
 * Validates that all non-inheritable bindings defined at the top level of
 * wrangler.toml are also present in every environment section (staging, production).
 *
 * Wrangler does NOT inherit these binding types into [env.*] sections:
 * - durable_objects.bindings
 * - d1_databases
 * - kv_namespaces
 * - r2_buckets
 * - ai
 * - tail_consumers
 *
 * If a binding exists at the top level but not in an environment, it will be
 * undefined at runtime when deploying with --env <name>.
 *
 * This check runs in CI to prevent the class of bug where tests pass (Miniflare
 * uses its own config) but production breaks because wrangler.toml is misconfigured.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';

const WRANGLER_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const REQUIRED_ENVS = ['staging', 'production'];

interface Binding {
  name?: string;
  binding?: string;
  class_name?: string;
  service?: string;
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
  tail_consumers?: Binding[];
  env?: Record<string, WranglerConfig>;
  [key: string]: unknown;
}

function getBindingNames(bindings: Binding[] | undefined, key: 'name' | 'binding'): string[] {
  if (!bindings || !Array.isArray(bindings)) return [];
  return bindings.map((b) => b[key] as string).filter(Boolean).sort();
}

function fail(errors: string[]): never {
  console.error('\nWrangler binding consistency check FAILED:\n');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error('\nFix: Add missing bindings to the environment section in apps/api/wrangler.toml.');
  console.error('See: .claude/rules/07-env-and-urls.md (Wrangler Non-Inheritable Bindings)\n');
  process.exit(1);
}

function main(): void {
  const content = readFileSync(WRANGLER_PATH, 'utf-8');
  const config = TOML.parse(content) as unknown as WranglerConfig;
  const errors: string[] = [];

  // Extract top-level bindings
  const topLevelDOs = getBindingNames(config.durable_objects?.bindings, 'name');
  const topLevelD1 = getBindingNames(config.d1_databases, 'binding');
  const topLevelKV = getBindingNames(config.kv_namespaces, 'binding');
  const topLevelR2 = getBindingNames(config.r2_buckets, 'binding');
  const topLevelAI = config.ai?.binding ? [config.ai.binding] : [];

  for (const envName of REQUIRED_ENVS) {
    const envConfig = config.env?.[envName] as WranglerConfig | undefined;
    if (!envConfig) {
      errors.push(`Missing [env.${envName}] section entirely`);
      continue;
    }

    // Check Durable Objects
    const envDOs = getBindingNames(
      (envConfig.durable_objects as DurableObjectConfig | undefined)?.bindings,
      'name'
    );
    for (const doName of topLevelDOs) {
      if (!envDOs.includes(doName)) {
        errors.push(
          `[env.${envName}] missing durable_objects binding "${doName}" ` +
          `(defined at top level but not inherited by environments)`
        );
      }
    }

    // Check D1 databases
    const envD1 = getBindingNames(envConfig.d1_databases, 'binding');
    for (const d1Name of topLevelD1) {
      if (!envD1.includes(d1Name)) {
        errors.push(
          `[env.${envName}] missing d1_databases binding "${d1Name}"`
        );
      }
    }

    // Check KV namespaces
    const envKV = getBindingNames(envConfig.kv_namespaces, 'binding');
    for (const kvName of topLevelKV) {
      if (!envKV.includes(kvName)) {
        errors.push(
          `[env.${envName}] missing kv_namespaces binding "${kvName}"`
        );
      }
    }

    // Check R2 buckets
    const envR2 = getBindingNames(envConfig.r2_buckets, 'binding');
    for (const r2Name of topLevelR2) {
      if (!envR2.includes(r2Name)) {
        errors.push(
          `[env.${envName}] missing r2_buckets binding "${r2Name}"`
        );
      }
    }

    // Check AI binding
    const envAI = (envConfig.ai as AIConfig | undefined)?.binding;
    for (const aiName of topLevelAI) {
      if (!envAI) {
        errors.push(
          `[env.${envName}] missing ai binding "${aiName}"`
        );
      }
    }
  }

  if (errors.length > 0) {
    fail(errors);
  }

  console.log('Wrangler binding consistency check passed.');
  console.log(`  Top-level: ${topLevelDOs.length} DOs, ${topLevelD1.length} D1, ${topLevelKV.length} KV, ${topLevelR2.length} R2, ${topLevelAI.length} AI`);
  console.log(`  Verified in: ${REQUIRED_ENVS.join(', ')}`);
}

main();
