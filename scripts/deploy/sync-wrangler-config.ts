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
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import * as v from 'valibot';

import { DEPLOYMENT_CONFIG } from './config.js';
import type {
  AIBinding,
  AnalyticsEngineDatasetBinding,
  ContainerBinding,
  DurableObjectsConfig,
  MigrationEntry,
  PulumiOutputs,
  WranglerEnvConfig,
  WranglerToml,
} from './types.js';

const INFRA_DIR = resolve(import.meta.dirname, '../../infra');
const WRANGLER_TOML_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const TAIL_WORKER_WRANGLER_TOML_PATH = resolve(
  import.meta.dirname,
  '../../apps/tail-worker/wrangler.toml'
);
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');
const FIRST_DEPLOY_MARKER = resolve(DEPLOY_STATE_DIR, 'tail-worker-first-deploy');
const SETUP_TOKEN_BYTES = 24;

const recordSchema = v.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'Expected an object'
);

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  const result = v.safeParse(recordSchema, value);
  if (!result.success) {
    throw new Error(`${path} must be an object`);
  }
  return result.output;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

export function ensureTomlMap(value: unknown, path: string): TOML.JsonMap {
  const result = v.safeParse(recordSchema, value);
  if (!result.success) {
    throw new Error(`${path} must be a TOML table`);
  }
  return value as TOML.JsonMap;
}

function generateSetupToken(): string {
  return randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
}

function cloudflareWorkerVariablesUrl(
  accountId: string,
  workerName: string,
  environment: string
): string {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/${environment}/settings/variables`;
}

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
    const parsed: unknown = JSON.parse(output);
    validatePulumiOutputs(parsed);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get Pulumi outputs: ${message}`);
  }
}

export function validatePulumiOutputs(outputs: unknown): asserts outputs is PulumiOutputs {
  const record = requireRecord(outputs, 'Pulumi outputs');
  const required: Array<{ key: keyof PulumiOutputs; label: string }> = [
    { key: 'd1DatabaseId', label: 'D1 Database ID' },
    { key: 'd1DatabaseName', label: 'D1 Database Name' },
    { key: 'observabilityD1DatabaseId', label: 'Observability D1 Database ID' },
    { key: 'observabilityD1DatabaseName', label: 'Observability D1 Database Name' },
    { key: 'kvId', label: 'KV Namespace ID' },
    { key: 'r2Name', label: 'R2 Bucket Name' },
    { key: 'sessionSnapshotTtlDays', label: 'Session Snapshot TTL Days' },
    { key: 'cloudflareAccountId', label: 'Cloudflare Account ID' },
    { key: 'pagesName', label: 'Pages Project Name' },
  ];

  const missing = required.filter(({ key }) => {
    const value = record[key];
    if (key === 'sessionSnapshotTtlDays') {
      return typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0;
    }
    return typeof value !== 'string' || value.length === 0;
  });

  if (missing.length > 0) {
    const labels = missing.map(({ label, key }) => `  - ${label} (${key})`).join('\n');
    throw new Error(`Pulumi outputs missing required fields:\n${labels}`);
  }

  const stackSummary = requireRecord(record.stackSummary, 'Pulumi outputs.stackSummary');
  requireString(stackSummary.baseDomain, 'Pulumi outputs.stackSummary.baseDomain');
  requireRecord(stackSummary.resources, 'Pulumi outputs.stackSummary.resources');
  requireRecord(record.dnsIds, 'Pulumi outputs.dnsIds');
  requireRecord(record.hostnames, 'Pulumi outputs.hostnames');

  if (!record.stackSummary || !stackSummary.baseDomain) {
    throw new Error('Pulumi outputs missing required field: stackSummary.baseDomain');
  }
}

// ============================================================================
// Tail Worker Existence Check
// ============================================================================

export async function checkTailWorkerExists(
  accountId: string,
  tailWorkerName: string
): Promise<boolean> {
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new Error('CF_API_TOKEN or CLOUDFLARE_API_TOKEN is required to check tail worker status');
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${tailWorkerName}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );

    if (response.ok) {
      return true;
    }

    if (response.status === 404) {
      return false;
    }

    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to check tail worker "${tailWorkerName}" (HTTP ${response.status})${body ? `: ${body}` : ''}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Failed to check tail worker')) {
      throw error;
    }
    throw new Error(`Failed to check tail worker "${tailWorkerName}": ${message}`);
  }
}

// ============================================================================
// Static Binding Extraction
// ============================================================================

function extractStaticBindings(topLevel: WranglerToml): {
  durable_objects: DurableObjectsConfig | undefined;
  ai: AIBinding | undefined;
  analytics_engine_datasets: AnalyticsEngineDatasetBinding[] | undefined;
  containers: ContainerBinding[] | undefined;
  migrations: MigrationEntry[] | undefined;
  artifacts: unknown[] | undefined;
} {
  return {
    durable_objects: topLevel.durable_objects as DurableObjectsConfig | undefined,
    ai: topLevel.ai as AIBinding | undefined,
    analytics_engine_datasets: topLevel.analytics_engine_datasets as
      | AnalyticsEngineDatasetBinding[]
      | undefined,
    containers: topLevel.containers as ContainerBinding[] | undefined,
    migrations: topLevel.migrations as MigrationEntry[] | undefined,
    artifacts: topLevel.artifacts as unknown[] | undefined,
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

/**
 * Read-only probe of the Cloudflare Artifacts control-plane REST API to detect
 * whether this deployment's account+token can actually use Artifacts. Returns
 * true only on a 200 from the list-repos endpoint. Fail-closed (returns false)
 * on any auth/permission error, missing token, or network failure — a broken or
 * under-scoped probe must never silently deploy an [[artifacts]] binding the
 * account can't support.
 *
 * Requires the deploy token to carry the "Artifacts > Read" permission.
 */
export async function detectArtifactsAvailable(
  accountId: string,
  namespace: string
): Promise<boolean> {
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    console.warn(
      '  Artifacts auto-detect: CF_API_TOKEN/CLOUDFLARE_API_TOKEN not set — treating Artifacts as unavailable'
    );
    return false;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}/repos?limit=1`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (response.ok) {
      return true;
    }
    const hint =
      response.status === 401 || response.status === 403
        ? ' — the deploy token is missing the "Artifacts > Read" permission (or the account has no Artifacts access)'
        : '';
    console.warn(
      `  Artifacts auto-detect: probe returned HTTP ${response.status}${hint}. Treating Artifacts as unavailable.`
    );
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `  Artifacts auto-detect: probe failed (${message}). Treating Artifacts as unavailable.`
    );
    return false;
  }
}

/**
 * Resolves whether the Artifacts binding should be included for this deploy.
 *
 * `ARTIFACTS_BINDING_ENABLED` is an optional explicit override: set it to
 * "true"/"false" to force a value (escape hatch). When unset/"auto", the value
 * is auto-detected from the live Artifacts REST probe. The probe always runs so
 * the deploy log records real availability even when an override is in effect.
 */
export async function resolveArtifactsBindingEnabled(
  accountId: string,
  namespace: string
): Promise<boolean> {
  const override = process.env.ARTIFACTS_BINDING_ENABLED?.trim().toLowerCase();
  const probeAvailable = await detectArtifactsAvailable(accountId, namespace);

  if (override === 'true' || override === 'false') {
    const enabled = override === 'true';
    console.log(
      `  Artifacts: ARTIFACTS_BINDING_ENABLED=${override} override in effect (auto-detect probe returned ${probeAvailable})`
    );
    return enabled;
  }
  console.log(
    `  Artifacts: auto-detected availability = ${probeAvailable} (namespace "${namespace}")`
  );
  return probeAvailable;
}

type StaticBindings = ReturnType<typeof extractStaticBindings>;

function getApiWorkerRoutes(baseDomain: string): NonNullable<WranglerEnvConfig['routes']> {
  return [
    {
      pattern: `api.${baseDomain}/*`,
      zone_name: baseDomain,
    },
    {
      pattern: `*.${baseDomain}/*`,
      zone_name: baseDomain,
    },
  ];
}

function getOptionalProcessEnvVars(names: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      vars[name] = value;
    }
  }
  return vars;
}

function getApiWorkerVars(
  topLevel: WranglerToml,
  outputs: PulumiOutputs,
  stack: string,
  analyticsDataset: string,
  includeArtifactsBinding: boolean
): Record<string, string> {
  return {
    CF_CONTAINER_ENABLED: 'true',
    ...(topLevel.vars || {}),
    BASE_DOMAIN: outputs.stackSummary.baseDomain,
    VERSION: DEPLOYMENT_CONFIG.version,
    PAGES_PROJECT_NAME: outputs.pagesName,
    R2_BUCKET_NAME: outputs.r2Name,
    SESSION_SNAPSHOT_TTL_DAYS: String(outputs.sessionSnapshotTtlDays),
    ...getOptionalProcessEnvVars([
      'REQUIRE_APPROVAL',
      'HETZNER_BASE_IMAGE',
      'CF_CONTAINER_ENABLED',
      'CF_CONTAINER_SLEEP_AFTER',
      'CF_CONTAINER_ACTIVE_WORK_MAX_MS',
      'CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS',
      'CF_CONTAINER_PORT_READY_TIMEOUT_MS',
      'CF_CONTAINER_WAKE_TIMEOUT_MS',
      'CF_CONTAINER_RECOVERY_MAX_ATTEMPTS',
      'CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS',
      'CF_CONTAINER_CLONE_FILTER',
      'CF_CONTAINER_VM_AGENT_PORT',
      'SANDBOX_ENABLED',
      'SANDBOX_EXEC_TIMEOUT_MS',
      'SANDBOX_VM_AGENT_PORT',
    ]),
    // AI Gateway ID matches the resource prefix (created by configure-ai-gateway.sh)
    AI_GATEWAY_ID: DEPLOYMENT_CONFIG.prefix,
    // Analytics Engine dataset — derived from prefix so forks don't co-mingle data
    ANALYTICS_DATASET: analyticsDataset,
    // Marketing Pages project — used when the wildcard Worker route intercepts www.*
    WWW_PAGES_PROJECT_NAME: `${DEPLOYMENT_CONFIG.prefix}-www`,
    // Deployment environment — used by trial runner to choose agent type + model
    ENVIRONMENT: DEPLOYMENT_CONFIG.getEnvironmentFromStack(stack),
    // Artifacts is disabled by default and enabled only with the generated binding.
    ARTIFACTS_ENABLED: includeArtifactsBinding ? 'true' : 'false',
    // Plaintext by design: first-run admins read this once from the CF dashboard.
    // Do not print the value in workflow logs; setup.completed gates it after use.
    SETUP_TOKEN: generateSetupToken(),
    ...(process.env.SETUP_FORCE === 'true' ? { SETUP_FORCE: 'true' } : {}),
  };
}

function getAnalyticsEngineDatasets(
  staticBindings: StaticBindings,
  analyticsDataset: string
): AnalyticsEngineDatasetBinding[] | undefined {
  return staticBindings.analytics_engine_datasets?.map((dataset) =>
    dataset.binding === 'ANALYTICS' ? { ...dataset, dataset: analyticsDataset } : dataset
  );
}

function getStaticApiWorkerBindings(
  staticBindings: StaticBindings,
  analyticsEngineDatasets: AnalyticsEngineDatasetBinding[] | undefined,
  includeArtifactsBinding: boolean
): Partial<WranglerEnvConfig> {
  return {
    ...(staticBindings.durable_objects ? { durable_objects: staticBindings.durable_objects } : {}),
    ...(staticBindings.ai ? { ai: staticBindings.ai } : {}),
    ...(analyticsEngineDatasets ? { analytics_engine_datasets: analyticsEngineDatasets } : {}),
    ...(staticBindings.migrations ? { migrations: staticBindings.migrations } : {}),
    ...(staticBindings.containers ? { containers: staticBindings.containers } : {}),
    ...(includeArtifactsBinding ? { artifacts: staticBindings.artifacts } : {}),
  };
}

function getTailConsumers(
  includeTailConsumers: boolean,
  tailWorkerName: string
): Partial<WranglerEnvConfig> {
  return includeTailConsumers ? { tail_consumers: [{ service: tailWorkerName }] } : {};
}

export function generateApiWorkerEnv(
  topLevel: WranglerToml,
  outputs: PulumiOutputs,
  stack: string,
  includeTailConsumers: boolean,
  artifactsBindingEnabled: boolean
): WranglerEnvConfig {
  const staticBindings = extractStaticBindings(topLevel);
  if (artifactsBindingEnabled && !staticBindings.artifacts) {
    throw new Error(
      'Artifacts is enabled but no top-level [[artifacts]] binding exists in wrangler.toml'
    );
  }
  const includeArtifactsBinding = artifactsBindingEnabled && !!staticBindings.artifacts;
  const workerName = DEPLOYMENT_CONFIG.resources.workerName(stack);
  const tailWorkerName = DEPLOYMENT_CONFIG.resources.tailWorkerName(stack);
  const analyticsDataset = `${DEPLOYMENT_CONFIG.prefix}_analytics`;
  const analyticsEngineDatasets = getAnalyticsEngineDatasets(staticBindings, analyticsDataset);

  const envConfig: WranglerEnvConfig = {
    // Worker name derived from config
    name: workerName,

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
    routes: getApiWorkerRoutes(outputs.stackSummary.baseDomain),

    // Workers Observability
    observability: {
      enabled: true,
      logs: {
        invocation_logs: true,
        head_sampling_rate: 0.01,
      },
    },

    // Vars: merge top-level defaults with dynamic overrides
    vars: getApiWorkerVars(topLevel, outputs, stack, analyticsDataset, includeArtifactsBinding),

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
    ...getStaticApiWorkerBindings(staticBindings, analyticsEngineDatasets, includeArtifactsBinding),

    // Tail consumers (conditional — omitted on first deploy when tail worker doesn't exist)
    ...getTailConsumers(includeTailConsumers, tailWorkerName),
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

  // Propagate top-level [vars] (e.g. TAIL_SUBSCRIBER_CACHE_MS) into the
  // generated env section — wrangler does not inherit them automatically.
  const topLevelVars =
    config.vars && typeof config.vars === 'object' && !Array.isArray(config.vars)
      ? (config.vars as TOML.JsonMap)
      : {};

  const envConfig = ensureTomlMap(config.env, 'tail worker env config');
  envConfig[envKey] = {
    name: tailWorkerName,
    account_id: accountId,
    services: [{ binding: 'API_WORKER', service: apiWorkerName }],
    ...(Object.keys(topLevelVars).length > 0 ? { vars: { ...topLevelVars } } : {}),
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

  // Auto-detect whether this deployment can use Cloudflare Artifacts (probes the
  // Artifacts REST API with the deploy token). ARTIFACTS_BINDING_ENABLED forces a
  // value when set explicitly. The probe namespace is derived from the actual
  // [[artifacts]] binding so the probe and the runtime binding can never diverge.
  const artifactsBindingConfig = (
    config.artifacts as Array<{ namespace?: string }> | undefined
  )?.[0];
  const artifactsNamespace = artifactsBindingConfig?.namespace || 'default';
  const artifactsBindingEnabled = await resolveArtifactsBindingEnabled(
    outputs.cloudflareAccountId,
    artifactsNamespace
  );

  // Generate complete env section for API worker
  if (!config.env) {
    config.env = {};
  }
  config.env[envKey] = generateApiWorkerEnv(
    config,
    outputs,
    stack,
    hasTailWorker,
    artifactsBindingEnabled
  );
  saveWranglerToml(config);
  console.log(`Updated wrangler.toml [env.${envKey}]`);
  console.log(
    `Setup token is available in Cloudflare dashboard variables: ${cloudflareWorkerVariablesUrl(
      outputs.cloudflareAccountId,
      DEPLOYMENT_CONFIG.resources.workerName(stack),
      envKey
    )}`
  );
  console.log('Setup token value was intentionally not printed.');

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
