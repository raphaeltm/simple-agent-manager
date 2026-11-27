#!/usr/bin/env tsx
// FILE SIZE EXCEPTION: Deploy-critical Pulumi output -> wrangler.toml config generator; splitting deferred to tasks/backlog/2026-04-03-split-oversized-files.md to avoid coupling a structural refactor to this staging-gated PR. See .claude/rules/18-file-size-limits.md
/**
 * Sync Pulumi outputs to wrangler.toml
 *
 * Generates complete [env.*] sections for both the API worker and tail worker
 * at deploy time. The checked-in wrangler.toml files contain only top-level
 * config for local dev — all environment sections are generated here.
 *
 * Static bindings (Durable Objects and AI) are copied from the top-level
 * config. Durable Object migrations are resolved against deployed Worker
 * state. Dynamic bindings (D1 IDs, KV IDs, R2 names) come from Pulumi stack
 * outputs. Worker names are derived from DEPLOYMENT_CONFIG.
 *
 * Usage:
 *   PULUMI_STACK=prod pnpm tsx scripts/deploy/sync-wrangler-config.ts
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import * as v from 'valibot';

import { DEPLOYMENT_CONFIG } from './config.js';
import { readAgentEmailMarker } from './configure-agent-email.js';
import {
  getDeployedWorkerMigrationTag,
  resolveDurableObjectMigrations,
} from './durable-object-migrations.js';
import {
  listEnvironmentVarOverrides,
  reportEnvironmentVarOverrides,
} from './environment-var-overrides.js';
import { generateSetupToken } from './setup-token.js';
import type {
  AIBinding,
  AnalyticsEngineDatasetBinding,
  ContainerBinding,
  DurableObjectsConfig,
  MigrationEntry,
  PulumiOutputs,
  WorkerLimitsConfig,
  WranglerEnvConfig,
  WranglerToml,
} from './types.js';
import { OMITTED_WORKER_VAR_DEFAULTS } from './worker-var-defaults.js';
import { WORKER_VAR_OVERRIDE_NAMES } from './worker-var-override-names.js';

const INFRA_DIR = resolve(import.meta.dirname, '../../infra');
const WRANGLER_TOML_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const CONFIGURE_SECRETS_PATH = resolve(import.meta.dirname, './configure-secrets.sh');
const TAIL_WORKER_WRANGLER_TOML_PATH = resolve(
  import.meta.dirname,
  '../../apps/tail-worker/wrangler.toml'
);
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');
/** send_email binding for agent email; mirrors Env.AGENT_EMAIL in apps/api. */
export const AGENT_EMAIL_BINDING_NAME = 'AGENT_EMAIL';
/** The API Worker's own script name, shipped with the binding; mirrors Env in apps/api. */
export const AGENT_EMAIL_WORKER_NAME_VAR = 'AGENT_EMAIL_WORKER_NAME';
const DEFAULT_SANDBOX_CONTAINER_MAX_INSTANCES = 6;
const DEFAULT_VM_AGENT_CONTAINER_MAX_INSTANCES = 3;
const CLOUDFLARE_WORKER_TEXT_BINDING_MAX = 350;
const CLOUDFLARE_WORKER_TEXT_BINDING_HEADROOM = 10;
export const CLOUDFLARE_WORKER_TEXT_BINDING_GUARD_LIMIT =
  CLOUDFLARE_WORKER_TEXT_BINDING_MAX - CLOUDFLARE_WORKER_TEXT_BINDING_HEADROOM;
/**
 * Text-binding limit on an ordinary Workers Paid account. SAM's own accounts run with a raised
 * limit (the guard above); a self-hosted install fails `wrangler secret bulk` with code 10055
 * above this one, so the checked-in configuration must fit it (sync-wrangler-config.test.ts).
 */
export const CLOUDFLARE_STANDARD_WORKER_TEXT_BINDING_MAX = 128;

/** API bootstrap and Tail binding repair have independent deployment requirements. */
export function writeDeploymentMarkers(
  deployedMigrationTag: string | null,
  hasTailWorker: boolean,
  stateDirectory = DEPLOY_STATE_DIR
): void {
  mkdirSync(stateDirectory, { recursive: true });
  for (const [filename, needed] of [
    ['api-worker-first-deploy', deployedMigrationTag === null],
    ['tail-worker-first-deploy', !hasTailWorker],
  ] as const) {
    const path = resolve(stateDirectory, filename);
    if (needed) writeFileSync(path, 'true', 'utf-8');
    else rmSync(path, { force: true });
  }
}

const CONTAINER_MAX_INSTANCE_CONFIG = {
  SandboxDO: {
    envVar: 'SANDBOX_CONTAINER_MAX_INSTANCES',
    defaultValue: DEFAULT_SANDBOX_CONTAINER_MAX_INSTANCES,
  },
  ComposeBuilderContainer: { envVar: 'DEPLOY_BUILDER_MAX_INSTANCES', defaultValue: 6 },
  VmAgentContainer: {
    envVar: 'VM_AGENT_CONTAINER_MAX_INSTANCES',
    defaultValue: DEFAULT_VM_AGENT_CONTAINER_MAX_INSTANCES,
  },
} as const satisfies Record<string, { envVar: string; defaultValue: number }>;

// Re-exported so tests and callers keep a single import site while the
// migration-state logic lives in its own module (file size rule 18).
export { getDeployedWorkerMigrationTag, resolveDurableObjectMigrations };

const recordSchema = v.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'Expected an object'
);
const positiveSafeIntegerSchema = v.pipe(
  v.number(),
  v.integer('must be an integer'),
  v.minValue(1, 'must be greater than or equal to 1'),
  v.safeInteger('must be a safe integer')
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

const SENSITIVE_PULUMI_SUMMARY_KEY_PATTERN =
  /(secret|token|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token)/i;

function assertNoSensitivePulumiSummary(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitivePulumiSummary(item, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_PULUMI_SUMMARY_KEY_PATTERN.test(key)) {
      throw new Error(`${path}.${key} is not allowed in Pulumi stackSummary`);
    }
    assertNoSensitivePulumiSummary(child, `${path}.${key}`);
  }
}

export function ensureTomlMap(value: unknown, path: string): TOML.JsonMap {
  const result = v.safeParse(recordSchema, value);
  if (!result.success) {
    throw new Error(`${path} must be a TOML table`);
  }
  return value as TOML.JsonMap;
}

function cloudflareWorkerVariablesUrl(
  accountId: string,
  workerName: string,
  environment: string
): string {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/${environment}/settings/variables`;
}

function parseContainerMaxInstances(envVar: string, fallback: number): number {
  const rawValue = process.env[envVar];
  if (!rawValue) {
    return fallback;
  }

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envVar} must be a positive safe integer`);
  }

  const parsed = Number(trimmed);
  const result = v.safeParse(positiveSafeIntegerSchema, parsed);
  if (!result.success) {
    throw new Error(`${envVar} ${result.issues[0]?.message ?? 'must be a positive safe integer'}`);
  }
  return result.output;
}

function getConfiguredContainerMaxInstances(
  className: string,
  currentValue: number | undefined
): number | undefined {
  const config =
    CONTAINER_MAX_INSTANCE_CONFIG[className as keyof typeof CONTAINER_MAX_INSTANCE_CONFIG];
  if (!config) {
    return currentValue;
  }
  return parseContainerMaxInstances(config.envVar, config.defaultValue);
}

const ACCOUNT_IMAGE_REFERENCE =
  /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9][a-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/;

/**
 * Digest-pinned images the installer engine already pushed to the account
 * registry, by container class (`SAM_CONTAINER_IMAGE_OVERRIDES`). Wrangler then
 * deploys them instead of building the Dockerfile. Anything malformed fails the
 * sync rather than silently building something else.
 */
export function containerImageOverrides(
  raw: string | undefined = process.env.SAM_CONTAINER_IMAGE_OVERRIDES
): Record<string, string> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('SAM_CONTAINER_IMAGE_OVERRIDES must be a JSON object');
  for (const [className, reference] of Object.entries(parsed)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(className) || typeof reference !== 'string')
      throw new Error('Invalid container image override');
    if (!ACCOUNT_IMAGE_REFERENCE.test(reference))
      throw new Error(
        `Container image override for ${className} is not a digest-pinned registry image`
      );
  }
  return parsed as Record<string, string>;
}

function getBuilderInstanceType(): string {
  const value = process.env.DEPLOY_BUILDER_INSTANCE_TYPE?.trim() || 'standard-4';
  if (!['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'].includes(value))
    throw new Error('DEPLOY_BUILDER_INSTANCE_TYPE must name a supported Cloudflare instance type');
  return value;
}

function generateContainerBindings(
  containers: ContainerBinding[] | undefined
): ContainerBinding[] | undefined {
  const overrides = containerImageOverrides();
  return containers?.map((container) => ({
    ...container,
    image: overrides[container.class_name] ?? container.image,
    ...(container.class_name === 'ComposeBuilderContainer'
      ? { instance_type: getBuilderInstanceType() }
      : {}),
    max_instances: getConfiguredContainerMaxInstances(
      container.class_name,
      container.max_instances
    ),
  }));
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
    { key: 'oauthKvId', label: 'OAuth KV Namespace ID' },
    { key: 'r2Name', label: 'R2 Bucket Name' },
    { key: 'sessionSnapshotTtlDays', label: 'Session Snapshot TTL Days' },
    { key: 'diagnosticIncidentPrefix', label: 'Diagnostic Incident R2 Prefix' },
    { key: 'diagnosticIncidentTtlDays', label: 'Diagnostic Incident TTL Days' },
    { key: 'cloudflareAccountId', label: 'Cloudflare Account ID' },
    { key: 'pagesName', label: 'Pages Project Name' },
    { key: 'installationId', label: 'Installation ID' },
  ];

  const missing = required.filter(({ key }) => {
    const value = record[key];
    if (key === 'sessionSnapshotTtlDays' || key === 'diagnosticIncidentTtlDays') {
      return typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0;
    }
    return typeof value !== 'string' || value.length === 0;
  });

  if (missing.length > 0) {
    const labels = missing.map(({ label, key }) => `  - ${label} (${key})`).join('\n');
    throw new Error(`Pulumi outputs missing required fields:\n${labels}`);
  }

  if (!/^[0-9a-f]{32}$/.test(String(record.installationId))) {
    throw new Error(
      'Pulumi output Installation ID (installationId) must be exactly 32 lowercase hex characters'
    );
  }

  const stackSummary = requireRecord(record.stackSummary, 'Pulumi outputs.stackSummary');
  assertNoSensitivePulumiSummary(stackSummary, 'Pulumi outputs.stackSummary');
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
  limits: WorkerLimitsConfig | undefined;
} {
  return {
    durable_objects: topLevel.durable_objects as DurableObjectsConfig | undefined,
    ai: topLevel.ai as AIBinding | undefined,
    analytics_engine_datasets: topLevel.analytics_engine_datasets as
      AnalyticsEngineDatasetBinding[] | undefined,
    containers: topLevel.containers as ContainerBinding[] | undefined,
    migrations: topLevel.migrations as MigrationEntry[] | undefined,
    artifacts: topLevel.artifacts as unknown[] | undefined,
    limits: topLevel.limits as WorkerLimitsConfig | undefined,
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
      pattern: `preview.${baseDomain}/*`,
      zone_name: baseDomain,
    },
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

export type { EnvironmentVarOverride } from './environment-var-overrides.js';
export {
  encodeWorkflowCommandData,
  EXPECTED_ENVIRONMENT_VAR_OVERRIDES,
  listEnvironmentVarOverrides,
  reportEnvironmentVarOverrides,
} from './environment-var-overrides.js';

function getOptionalProcessEnvVars(
  checkedIn: Record<string, unknown> | undefined,
  names: readonly string[]
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      vars[name] = value;
    }
  }
  reportEnvironmentVarOverrides(
    listEnvironmentVarOverrides(checkedIn, vars, OMITTED_WORKER_VAR_DEFAULTS)
  );
  return vars;
}

/**
 * Counts the bindings the generated config will leave on the Worker. This is only the deployed
 * count because `wrangler deploy` runs without `--keep-vars` (and wrangler.toml sets no
 * `keep_vars`): Wrangler then replaces the Worker's vars with exactly this set, so a var dropped
 * from [vars] (see `OMITTED_WORKER_VAR_DEFAULTS`) is deleted from the Worker. Keeping vars across
 * deploys would let removed bindings accumulate unseen by this guard.
 */
export function countWorkerTextBindings(envConfig: Pick<WranglerEnvConfig, 'vars'>): number {
  const variableCount = Object.keys(envConfig.vars ?? {}).length;
  const configuredSecrets = Array.from(
    new Set(
      Array.from(
        readFileSync(CONFIGURE_SECRETS_PATH, 'utf-8').matchAll(
          /set_worker_secret\s+"([A-Z0-9_]+)"/g
        ),
        (match) => match[1]
      )
    )
  );
  return variableCount + configuredSecrets.length;
}

export function assertWorkerTextBindingLimit(envConfig: Pick<WranglerEnvConfig, 'vars'>): void {
  const count = countWorkerTextBindings(envConfig);
  if (count <= CLOUDFLARE_WORKER_TEXT_BINDING_GUARD_LIMIT) return;

  throw new Error(
    `Generated Cloudflare Worker text bindings (${count}) exceed the ` +
      `${CLOUDFLARE_WORKER_TEXT_BINDING_GUARD_LIMIT} guard limit ` +
      `(${CLOUDFLARE_WORKER_TEXT_BINDING_MAX} Cloudflare max with ` +
      `${CLOUDFLARE_WORKER_TEXT_BINDING_HEADROOM} headroom). Remove redundant ` +
      `checked-in [vars] defaults or unused Worker secrets before deploying.`
  );
}

export function getApiWorkerVars(
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
    PREVIEW_BASE_DOMAIN:
      process.env.PREVIEW_BASE_DOMAIN || `preview.${outputs.stackSummary.baseDomain}`,
    ...(process.env.PREVIEW_URL_TTL_SECONDS
      ? { PREVIEW_URL_TTL_SECONDS: process.env.PREVIEW_URL_TTL_SECONDS }
      : {}),
    DEPLOY_BUILDER_CLASS_MAX_INSTANCES: String(
      parseContainerMaxInstances('DEPLOY_BUILDER_MAX_INSTANCES', 6)
    ),
    VERSION: DEPLOYMENT_CONFIG.version,
    PAGES_PROJECT_NAME: outputs.pagesName,
    SAM_INSTALLATION_ID: outputs.installationId,
    R2_BUCKET_NAME: outputs.r2Name,
    SESSION_SNAPSHOT_TTL_DAYS: String(outputs.sessionSnapshotTtlDays),
    VM_INCIDENT_R2_PREFIX: outputs.diagnosticIncidentPrefix,
    VM_INCIDENT_RETENTION_DAYS: String(outputs.diagnosticIncidentTtlDays),
    ...getOptionalProcessEnvVars(topLevel.vars, WORKER_VAR_OVERRIDE_NAMES),
    // AI Gateway ID matches the resource prefix (created by configure-ai-gateway.sh)
    AI_GATEWAY_ID: DEPLOYMENT_CONFIG.prefix,
    // Analytics Engine dataset — derived from prefix so forks don't co-mingle data
    ANALYTICS_DATASET: analyticsDataset,
    // Marketing Pages project — used when the wildcard Worker route intercepts www.*
    WWW_PAGES_PROJECT_NAME: `${DEPLOYMENT_CONFIG.prefix}-www`,
    // Deployment environment name (staging | production); used for diagnostics and node labels
    ENVIRONMENT: DEPLOYMENT_CONFIG.getEnvironmentFromStack(stack),
    // Artifacts is disabled by default and enabled only with the generated binding.
    ARTIFACTS_ENABLED: includeArtifactsBinding ? 'true' : 'false',
    // Plaintext by design: first-run admins read this once from the CF dashboard. Inside
    // GitHub Actions generateSetupToken masks it, because wrangler prints plain-text vars.
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
  includeArtifactsBinding: boolean,
  durableObjectMigrations: MigrationEntry[] | undefined
): Partial<WranglerEnvConfig> {
  const containers = generateContainerBindings(staticBindings.containers);
  return {
    ...(staticBindings.durable_objects ? { durable_objects: staticBindings.durable_objects } : {}),
    ...(staticBindings.ai ? { ai: staticBindings.ai } : {}),
    ...(analyticsEngineDatasets ? { analytics_engine_datasets: analyticsEngineDatasets } : {}),
    ...(durableObjectMigrations ? { migrations: durableObjectMigrations } : {}),
    ...(containers ? { containers } : {}),
    ...(includeArtifactsBinding ? { artifacts: staticBindings.artifacts } : {}),
    ...(staticBindings.limits ? { limits: staticBindings.limits } : {}),
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
  artifactsBindingEnabled: boolean,
  deployedMigrationTag: string | null,
  agentEmailBindingEnabled = false
): WranglerEnvConfig {
  const staticBindings = extractStaticBindings(topLevel);
  const durableObjectMigrations = resolveDurableObjectMigrations(
    staticBindings.migrations,
    deployedMigrationTag
  );
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

    // Workers Observability: native traces provide dependency timings without an SDK.
    observability: {
      enabled: true,
      // Callback and terminal URLs can carry credentials in query parameters.
      redact_query_string: true,
      traces: {
        enabled: true,
        head_sampling_rate: 1,
        persist: true,
        ...topLevel.observability?.traces,
      },
      logs: {
        invocation_logs: true,
        head_sampling_rate: 1,
      },
    },

    // Vars: merge top-level defaults with dynamic overrides. With the agent email binding, the
    // Worker also learns its own script name: the admin setup points the `agent@` routing rule
    // at it (packages/agent-email/src/setup.ts).
    vars: {
      ...getApiWorkerVars(topLevel, outputs, stack, analyticsDataset, includeArtifactsBinding),
      ...(agentEmailBindingEnabled ? { [AGENT_EMAIL_WORKER_NAME_VAR]: workerName } : {}),
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
    kv_namespaces: [
      { binding: 'KV', id: outputs.kvId },
      { binding: 'OAUTH_KV', id: outputs.oauthKvId },
    ],
    r2_buckets: [
      { binding: 'R2', bucket_name: outputs.r2Name },
      { binding: 'PROJECT_DATA_ARCHIVE_R2', bucket_name: outputs.r2Name },
    ],

    // Static bindings copied from top-level config
    ...getStaticApiWorkerBindings(
      staticBindings,
      analyticsEngineDatasets,
      includeArtifactsBinding,
      durableObjectMigrations
    ),

    // Agent email (preview). Generated here rather than declared at the top level of
    // wrangler.toml: it exists only after configure-agent-email.ts prepared Email Sending for
    // this deploy. It does not turn agent email on: an admin does that from the admin panel.
    ...(agentEmailBindingEnabled ? { send_email: [{ name: AGENT_EMAIL_BINDING_NAME }] } : {}),

    // Tail consumers (conditional — omitted on first deploy when tail worker doesn't exist)
    ...getTailConsumers(includeTailConsumers, tailWorkerName),
  };

  assertWorkerTextBindingLimit(envConfig);

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

  const apiWorkerName = DEPLOYMENT_CONFIG.resources.workerName(stack);
  const deployedMigrationTag = await getDeployedWorkerMigrationTag(
    outputs.cloudflareAccountId,
    apiWorkerName
  );
  console.log(
    `  API worker "${apiWorkerName}" migration state: ${deployedMigrationTag ?? 'clean install'}`
  );

  // Check if tail worker already exists (for conditional tail_consumers)
  const tailWorkerName = DEPLOYMENT_CONFIG.resources.tailWorkerName(stack);
  const hasTailWorker = await checkTailWorkerExists(outputs.cloudflareAccountId, tailWorkerName);
  console.log(`  Tail worker "${tailWorkerName}" exists: ${hasTailWorker}`);
  if (!hasTailWorker) {
    console.log(`  tail_consumers will be OMITTED until the tail worker is deployed`);
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

  // Agent email binding ships only when configure-agent-email.ts prepared this deploy.
  const agentEmailDomain = readAgentEmailMarker();
  console.log(`  Agent email: ${agentEmailDomain ? `prepared for ${agentEmailDomain}` : 'off'}`);

  // Generate complete env section for API worker
  if (!config.env) {
    config.env = {};
  }
  config.env[envKey] = generateApiWorkerEnv(
    config,
    outputs,
    stack,
    hasTailWorker,
    artifactsBindingEnabled,
    deployedMigrationTag,
    agentEmailDomain !== null
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

  // The migration probe returns null only for a confirmed absent API Worker.
  // A missing Tail Worker must never trigger extra code revisions on a live API.
  writeDeploymentMarkers(deployedMigrationTag, hasTailWorker);

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
