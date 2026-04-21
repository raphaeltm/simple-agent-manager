#!/usr/bin/env tsx
/**
 * Sync Pulumi outputs to wrangler.toml
 *
 * Generates complete [env.*] sections for both the API worker and tail worker
 * at deploy time. The checked-in wrangler.toml files contain only top-level
 * config for local dev — all environment sections are generated here.
 *
 * Static bindings (Durable Objects, AI, migrations) are copied from the
 * top-level config. Dynamic bindings (D1 IDs, KV IDs, R2 names) come from
 * Pulumi stack outputs. Worker names are derived from DEPLOYMENT_CONFIG.
 *
 * Usage:
 *   PULUMI_STACK=prod pnpm tsx scripts/deploy/sync-wrangler-config.ts
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';
import type {
  PulumiOutputs,
  WranglerToml,
  WranglerEnvConfig,
  DurableObjectsConfig,
  AIBinding,
  AnalyticsEngineDatasetBinding,
  MigrationEntry,
  TailWorkerWranglerToml,
} from './types.js';
import { DEPLOYMENT_CONFIG } from './config.js';

const INFRA_DIR = resolve(import.meta.dirname, '../../infra');
const WRANGLER_TOML_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const TAIL_WORKER_WRANGLER_TOML_PATH = resolve(
  import.meta.dirname,
  '../../apps/tail-worker/wrangler.toml'
);
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');
const FIRST_DEPLOY_MARKER = resolve(DEPLOY_STATE_DIR, 'tail-worker-first-deploy');

// ============================================================================
// Pulumi
// ============================================================================

function getPulumiOutputs(stack: string): PulumiOutputs {
  const command = `pulumi stack output --json --stack ${stack}`;
  console.log(`Fetching Pulumi outputs: ${command}`);

  try {
    const output = execSync(command, {
      cwd: INFRA_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output) as PulumiOutputs;
    validatePulumiOutputs(parsed);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get Pulumi outputs: ${message}`);
  }
}

export function validatePulumiOutputs(outputs: PulumiOutputs): void {
  const required: Array<{ key: keyof PulumiOutputs; label: string }> = [
    { key: 'd1DatabaseId', label: 'D1 Database ID' },
    { key: 'd1DatabaseName', label: 'D1 Database Name' },
    { key: 'observabilityD1DatabaseId', label: 'Observability D1 Database ID' },
    { key: 'observabilityD1DatabaseName', label: 'Observability D1 Database Name' },
    { key: 'kvId', label: 'KV Namespace ID' },
    { key: 'r2Name', label: 'R2 Bucket Name' },
    { key: 'cloudflareAccountId', label: 'Cloudflare Account ID' },
    { key: 'pagesName', label: 'Pages Project Name' },
  ];

  const missing = required.filter(({ key }) => {
    const value = outputs[key];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    const labels = missing.map(({ label, key }) => `  - ${label} (${key})`).join('\n');
    throw new Error(`Pulumi outputs missing required fields:\n${labels}`);
  }

  if (!outputs.stackSummary?.baseDomain) {
    throw new Error('Pulumi outputs missing required field: stackSummary.baseDomain');
  }
}

// ============================================================================
// Tail Worker Existence Check
// ============================================================================

async function checkTailWorkerExists(accountId: string, tailWorkerName: string): Promise<boolean> {
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    console.log('  No CF API token available, assuming tail worker does not exist');
    return false;
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${tailWorkerName}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    return response.ok;
  } catch {
    console.log('  Failed to check tail worker existence, assuming it does not exist');
    return false;
  }
}

// ============================================================================
// Static Binding Extraction
// ============================================================================

function extractStaticBindings(topLevel: WranglerToml): {
  durable_objects: DurableObjectsConfig | undefined;
  ai: AIBinding | undefined;
  analytics_engine_datasets: AnalyticsEngineDatasetBinding[] | undefined;
  migrations: MigrationEntry[] | undefined;
} {
  return {
    durable_objects: topLevel.durable_objects as DurableObjectsConfig | undefined,
    ai: topLevel.ai as AIBinding | undefined,
    analytics_engine_datasets: topLevel.analytics_engine_datasets as
      | AnalyticsEngineDatasetBinding[]
      | undefined,
    migrations: topLevel.migrations as MigrationEntry[] | undefined,
  };
}

// ============================================================================
// API Worker Config Generation
// ============================================================================

function loadWranglerToml(): WranglerToml {
  console.log(`Reading wrangler.toml from: ${WRANGLER_TOML_PATH}`);
  const content = readFileSync(WRANGLER_TOML_PATH, 'utf-8');
  return TOML.parse(content) as WranglerToml;
}

function saveWranglerToml(config: WranglerToml): void {
  console.log(`Writing updated wrangler.toml`);
  const content = TOML.stringify(config as TOML.JsonMap);
  writeFileSync(WRANGLER_TOML_PATH, content, 'utf-8');
}

function generateApiWorkerEnv(
  topLevel: WranglerToml,
  outputs: PulumiOutputs,
  stack: string,
  includeTailConsumers: boolean
): WranglerEnvConfig {
  const staticBindings = extractStaticBindings(topLevel);
  const tailWorkerName = DEPLOYMENT_CONFIG.resources.tailWorkerName(stack);

  const envConfig: WranglerEnvConfig = {
    // Worker name derived from config
    name: DEPLOYMENT_CONFIG.resources.workerName(stack),

    // Account ID for authentication
    account_id: outputs.cloudflareAccountId,

    // Custom domain routes
    // IMPORTANT: patterns MUST end with /* to match all paths, not just the root
    //
    // We use a wildcard *.domain/* because Cloudflare route patterns only support
    // wildcards at the BEGINNING of the hostname — patterns like ws-*.domain/* are
    // rejected (error 10022). A leading wildcard is greedy and can match nested
    // subdomains.
    //
    // VM backend communication uses two-level subdomains ({nodeId}.vm.{domain}).
    // These are excluded by the more-specific *.vm.{domain}/* WorkerRoute created
    // in infra/resources/dns.ts so Worker subrequests (from DO alarms) reach the
    // VM directly instead of looping through the wildcard Worker route.
    // See docs/notes/2026-03-12-same-zone-routing-postmortem.md.
    //
    // Health checks additionally use D1 heartbeat queries as defense-in-depth
    // (see task-runner.ts handleNodeAgentReady and verifyNodeAgentHealthy).
    routes: [
      {
        pattern: `api.${outputs.stackSummary.baseDomain}/*`,
        zone_name: outputs.stackSummary.baseDomain,
      },
      {
        pattern: `*.${outputs.stackSummary.baseDomain}/*`,
        zone_name: outputs.stackSummary.baseDomain,
      },
    ],

    // Workers Observability
    observability: {
      enabled: true,
      logs: {
        invocation_logs: true,
        head_sampling_rate: 0.01,
      },
    },

    // Vars: merge top-level defaults with dynamic overrides
    vars: {
      ...(topLevel.vars || {}),
      BASE_DOMAIN: outputs.stackSummary.baseDomain,
      VERSION: DEPLOYMENT_CONFIG.version,
      PAGES_PROJECT_NAME: outputs.pagesName,
      R2_BUCKET_NAME: outputs.r2Name,
      ...(process.env.REQUIRE_APPROVAL ? { REQUIRE_APPROVAL: process.env.REQUIRE_APPROVAL } : {}),
      ...(process.env.HETZNER_BASE_IMAGE
        ? { HETZNER_BASE_IMAGE: process.env.HETZNER_BASE_IMAGE }
        : {}),
      // AI Gateway ID matches the resource prefix (created by configure-ai-gateway.sh)
      AI_GATEWAY_ID: DEPLOYMENT_CONFIG.prefix,
      // Deployment environment — used by trial runner to choose agent type + model
      ENVIRONMENT: DEPLOYMENT_CONFIG.getEnvironmentFromStack(stack),
    },

    // Dynamic bindings from Pulumi outputs
    d1_databases: [
      {
        binding: 'DATABASE',
        database_name: outputs.d1DatabaseName,
        database_id: outputs.d1DatabaseId,
        migrations_dir: 'src/db/migrations',
      },
      {
        binding: 'OBSERVABILITY_DATABASE',
        database_name: outputs.observabilityD1DatabaseName,
        database_id: outputs.observabilityD1DatabaseId,
        migrations_dir: 'src/db/migrations/observability',
      },
    ],
    kv_namespaces: [{ binding: 'KV', id: outputs.kvId }],
    r2_buckets: [{ binding: 'R2', bucket_name: outputs.r2Name }],

    // Static bindings copied from top-level config
    ...(staticBindings.durable_objects ? { durable_objects: staticBindings.durable_objects } : {}),
    ...(staticBindings.ai ? { ai: staticBindings.ai } : {}),
    ...(staticBindings.analytics_engine_datasets
      ? { analytics_engine_datasets: staticBindings.analytics_engine_datasets }
      : {}),
    ...(staticBindings.migrations ? { migrations: staticBindings.migrations } : {}),

    // Tail consumers (conditional — omitted on first deploy when tail worker doesn't exist)
    ...(includeTailConsumers ? { tail_consumers: [{ service: tailWorkerName }] } : {}),
  };

  return envConfig;
}

// ============================================================================
// Tail Worker Config Generation
// ============================================================================

function syncTailWorkerConfig(stack: string, accountId: string, envKey: string): void {
  console.log(`\nSyncing tail worker wrangler.toml`);

  const content = readFileSync(TAIL_WORKER_WRANGLER_TOML_PATH, 'utf-8');
  const config = TOML.parse(content) as TOML.JsonMap;

  const tailWorkerName = DEPLOYMENT_CONFIG.resources.tailWorkerName(stack);
  const apiWorkerName = DEPLOYMENT_CONFIG.resources.workerName(stack);

  if (!config.env) config.env = {};

  (config.env as Record<string, unknown>)[envKey] = {
    name: tailWorkerName,
    account_id: accountId,
    services: [{ binding: 'API_WORKER', service: apiWorkerName }],
  };

  const output = TOML.stringify(config);
  writeFileSync(TAIL_WORKER_WRANGLER_TOML_PATH, output, 'utf-8');

  console.log(`  Tail worker name: ${tailWorkerName}`);
  console.log(`  API worker service binding: ${apiWorkerName}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const stack = process.env.PULUMI_STACK;
  if (!stack) {
    console.error('PULUMI_STACK environment variable is required');
    process.exit(1);
  }

  console.log(`\nSyncing Pulumi outputs to wrangler.toml`);
  console.log(`   Stack: ${stack}`);
  console.log('');

  // Get Pulumi outputs
  const outputs = getPulumiOutputs(stack);
  console.log(`Got Pulumi outputs:`);
  console.log(`   Base Domain: ${outputs.stackSummary.baseDomain}`);
  console.log(`   D1 Database: ${outputs.d1DatabaseName} (${outputs.d1DatabaseId})`);
  console.log(
    `   D1 Observability: ${outputs.observabilityD1DatabaseName} (${outputs.observabilityD1DatabaseId})`
  );
  console.log(`   KV Namespace: ${outputs.kvName} (${outputs.kvId})`);
  console.log(`   R2 Bucket: ${outputs.r2Name}`);
  console.log('');

  // Load API worker config
  const config = loadWranglerToml();
  const envKey = DEPLOYMENT_CONFIG.getEnvironmentFromStack(stack);

  // Check if tail worker already exists (for conditional tail_consumers)
  const tailWorkerName = DEPLOYMENT_CONFIG.resources.tailWorkerName(stack);
  const hasTailWorker = await checkTailWorkerExists(outputs.cloudflareAccountId, tailWorkerName);
  console.log(`  Tail worker "${tailWorkerName}" exists: ${hasTailWorker}`);
  if (!hasTailWorker) {
    console.log(
      `  tail_consumers will be OMITTED (first deploy — will re-add after tail worker is deployed)`
    );
  }

  // Generate complete env section for API worker
  if (!config.env) {
    config.env = {};
  }
  config.env[envKey] = generateApiWorkerEnv(config, outputs, stack, hasTailWorker);
  saveWranglerToml(config);
  console.log(`Updated wrangler.toml [env.${envKey}]`);

  // Generate env section for tail worker
  syncTailWorkerConfig(stack, outputs.cloudflareAccountId, envKey);

  // Write first-deploy marker for the workflow to detect
  if (!hasTailWorker) {
    mkdirSync(DEPLOY_STATE_DIR, { recursive: true });
    writeFileSync(FIRST_DEPLOY_MARKER, 'true', 'utf-8');
    console.log(`\nFirst-deploy marker written to ${FIRST_DEPLOY_MARKER}`);
    console.log('The deploy workflow will re-sync and re-deploy after the tail worker is created.');
  }

  console.log('\nSync complete.');
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('sync-wrangler-config.ts');
if (isDirectExecution) {
  main().catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
