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
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import * as v from 'valibot';

import { DEPLOYMENT_CONFIG } from './config.js';
import {
  getDeployedWorkerMigrationTag,
  resolveDurableObjectMigrations,
} from './durable-object-migrations.js';
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

const INFRA_DIR = resolve(import.meta.dirname, '../../infra');
const WRANGLER_TOML_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');
const TAIL_WORKER_WRANGLER_TOML_PATH = resolve(
  import.meta.dirname,
  '../../apps/tail-worker/wrangler.toml'
);
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');
const FIRST_DEPLOY_MARKER = resolve(DEPLOY_STATE_DIR, 'tail-worker-first-deploy');
const SETUP_TOKEN_BYTES = 24;
const DEFAULT_SANDBOX_CONTAINER_MAX_INSTANCES = 6;
const DEFAULT_VM_AGENT_CONTAINER_MAX_INSTANCES = 3;

const CONTAINER_MAX_INSTANCE_CONFIG = {
  SandboxDO: {
    envVar: 'SANDBOX_CONTAINER_MAX_INSTANCES',
    defaultValue: DEFAULT_SANDBOX_CONTAINER_MAX_INSTANCES,
  },
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

function generateContainerBindings(
  containers: ContainerBinding[] | undefined
): ContainerBinding[] | undefined {
  return containers?.map((container) => ({
    ...container,
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
      | AnalyticsEngineDatasetBinding[]
      | undefined,
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
    PREVIEW_BASE_DOMAIN:
      process.env.PREVIEW_BASE_DOMAIN || `preview.${outputs.stackSummary.baseDomain}`,
    ...(process.env.PREVIEW_URL_TTL_SECONDS
      ? { PREVIEW_URL_TTL_SECONDS: process.env.PREVIEW_URL_TTL_SECONDS }
      : {}),
    VERSION: DEPLOYMENT_CONFIG.version,
    PAGES_PROJECT_NAME: outputs.pagesName,
    SAM_INSTALLATION_ID: outputs.installationId,
    R2_BUCKET_NAME: outputs.r2Name,
    SESSION_SNAPSHOT_TTL_DAYS: String(outputs.sessionSnapshotTtlDays),
    VM_INCIDENT_R2_PREFIX: outputs.diagnosticIncidentPrefix,
    VM_INCIDENT_RETENTION_DAYS: String(outputs.diagnosticIncidentTtlDays),
    ...getOptionalProcessEnvVars([
      'REQUIRE_APPROVAL',
      'CRON_SWEEPS_ENABLED_KV_KEY',
      'DO_ALARMS_ENABLED_KV_KEY',
      'CONTROL_LOOP_KILL_SWITCH_CACHE_MS',
      'CONTROL_LOOP_DISABLED_ALARM_RETRY_MS',
      'CRON_FAILURE_NOTIFICATION_THROTTLE_MS',
      'CRON_FAILURE_NOTIFICATION_KV_PREFIX',
      'WEB_PUSH_TTL_SECONDS',
      'WEB_PUSH_VAPID_TTL_SECONDS',
      'WEB_PUSH_DELIVERY_TIMEOUT_MS',
      'WEB_PUSH_DELIVERY_BUDGET_MS',
      'WEB_PUSH_FANOUT_CONCURRENCY',
      'WEB_PUSH_MAX_ATTEMPTS',
      'WEB_PUSH_MAX_RETRY_AFTER_SECONDS',
      'WEB_PUSH_MAX_PAYLOAD_BYTES',
      'WEB_PUSH_FAILURE_THRESHOLD',
      'WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER',
      'WEB_PUSH_USER_AGENT_MAX_LENGTH',
      'RATE_LIMIT_PUSH_SUBSCRIPTION',
      'HUMAN_INPUT_TIMEOUT_MS',
      'HUMAN_INPUT_ESCALATION_FRACTIONS',
      'HUMAN_INPUT_UNDELIVERED_GRACE_MS',
      'HUMAN_INPUT_MAX_WAIT_MS',
      'DURABLE_PROMPT_DELIVERY_ENABLED',
      'PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED',
      'PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM',
      'PROMPT_DELIVERY_MAX_ATTEMPTS',
      'PROMPT_DELIVERY_RETRY_BASE_MS',
      'PROMPT_DELIVERY_RETRY_MAX_MS',
      'PROMPT_DELIVERY_TTL_MS',
      'PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS',
      'PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS',
      'PROMPT_DELIVERY_MIN_ALARM_DELAY_MS',
      'ACP_LONG_TURN_SUPERVISOR_ENABLED',
      'ACP_LONG_TURN_CHECKPOINT_MS',
      'ACP_CHECKPOINT_PREEMPT_GRACE_MS',
      'NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS',
      'NODE_CLEANUP_FAILURE_BACKOFF_MS',
      'DIAGNOSIS_COMPLETED_STEP_MIN_DELAY_MS',
      'ORCHESTRATOR_ZERO_TASK_GRACE_MS',
      'ORCHESTRATOR_MAX_MISSION_LIFETIME_MS',
      'ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS',
      'ORCHESTRATOR_WAIT_MAX_CHILDREN',
      'ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT',
      'ORCHESTRATOR_WAIT_MAX_DURATION_MS',
      'ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM',
      'HETZNER_BASE_IMAGE',
      'DEPLOYMENT_RELEASE_RETENTION_ENABLED',
      'DEPLOYMENT_RELEASE_RETENTION_COUNT',
      'DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE',
      'DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS',
      'DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY',
      'DEPLOYMENT_RELEASE_RECONCILIATION_ENABLED',
      'DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE',
      'DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS',
      'DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS',
      'DEPLOYMENT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS',
      'DEPLOYMENT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS',
      'DEPLOYMENT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS',
      'DEPLOYMENT_IMAGE_RESOLVE_MAX_REDIRECTS',
      'DEPLOYMENT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES',
      'DEPLOYMENT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES',
      'DEPLOYMENT_IMAGE_RESOLVE_MAX_SERVICES',
      'SESSION_SNAPSHOT_PURGE_ENABLED',
      'SESSION_SNAPSHOT_PURGE_BATCH_SIZE',
      'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS',
      'SESSION_SNAPSHOT_R2_PREFIX',
      'SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES',
      'SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES',
      'SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS',
      'SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS',
      'SESSION_SNAPSHOT_POLL_INTERVAL_MS',
      'SESSION_SNAPSHOT_OPERATION_TIMEOUT',
      'SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM',
      'PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS',
      'PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS',
      'PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS',
      'PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX',
      'PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS',
      'PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS',
      'SESSION_SLEEP_AFTER_MS',
      'SESSION_SLEEP_SWEEP_BATCH_SIZE',
      'SESSION_SLEEP_SWEEP_WALL_BUDGET_MS',
      'SESSION_SLEEP_RETRY_DELAY_MS',
      'SESSION_SLEEP_MAX_ATTEMPTS',
      'SESSION_SLEEP_CLAIM_LEASE_MS',
      'HARNESS_BACKGROUND_WORK_LEASE_MS',
      'HARNESS_BACKGROUND_WORK_MAX_DURATION_MS',
      'SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS',
      'SESSION_LIFECYCLE_ERROR_MAX_LENGTH',
      'LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE',
      'MAX_VM_AGENT_ERROR_BODY_BYTES',
      'MAX_VM_AGENT_ERROR_BATCH_SIZE',
      'MAX_VM_AGENT_ERROR_SOURCE_LENGTH',
      'OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH',
      'OBSERVABILITY_ERROR_STACK_MAX_LENGTH',
      'OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH',
      'DEBUG_AGENT_MODEL',
      'DEBUG_AGENT_MAX_TURNS',
      'DEBUG_AGENT_RUN_TOKEN_LIMIT',
      'DEBUG_AGENT_MODEL_OUTPUT_TOKENS',
      'DEBUG_AGENT_DAILY_TOKEN_LIMIT',
      'DEBUG_AGENT_TOOL_RESULT_LIMIT',
      'DEBUG_AGENT_TOOL_RESULT_BYTES',
      'DEBUG_AGENT_MAX_WINDOW_HOURS',
      'DEBUG_AGENT_TIMEOUT_MS',
      'DEBUG_AGENT_HARD_DEADLINE_MS',
      'DEBUG_AGENT_STALE_HEARTBEAT_MS',
      'DEBUG_AGENT_RETRY_BASE_DELAY_MS',
      'DEBUG_AGENT_RETRY_MAX_DELAY_MS',
      'DEBUG_AGENT_STEP_MAX_RETRIES',
      'VM_INCIDENT_ARTIFACT_MAX_BYTES',
      'VM_INCIDENT_REGISTRATION_MAX_BYTES',
      'VM_INCIDENT_MANIFEST_MAX_BYTES',
      'VM_INCIDENT_PREVIEW_MAX_BYTES',
      'VM_INCIDENT_MAX_ARTIFACTS_PER_NODE',
      'VM_INCIDENT_MAX_BYTES_PER_NODE',
      'VM_INCIDENT_METADATA_RETENTION_DAYS',
      'VM_INCIDENT_PENDING_TIMEOUT_MINUTES',
      'VM_INCIDENT_RECONCILE_BATCH_SIZE',
      'ERROR_REPORT_FLUSH_INTERVAL',
      'ERROR_REPORT_MAX_BATCH_SIZE',
      'ERROR_REPORT_MAX_BATCH_BYTES',
      'ERROR_REPORT_MAX_QUEUE_SIZE',
      'ERROR_REPORT_HTTP_TIMEOUT',
      'ERROR_REPORT_RETRY_INITIAL',
      'ERROR_REPORT_RETRY_MAX',
      'ERROR_REPORT_MAX_ATTEMPTS',
      'ERROR_REPORT_DB_PATH',
      'ERROR_REPORT_DB_BUSY_TIMEOUT',
      'ERROR_REPORT_SPOOL_DIR',
      'ERROR_REPORT_ARTIFACT_MAX_BYTES',
      'ERROR_REPORT_SPOOL_MAX_BYTES',
      'ERROR_REPORT_RETENTION',
      'ERROR_REPORT_COLLECTOR_TIMEOUT',
      'ERROR_REPORT_MAX_COLLECTOR_DOCS',
      'ERROR_REPORT_MAX_DOCUMENT_BYTES',
      'ERROR_REPORT_MAX_VALUE_DEPTH',
      'ERROR_REPORT_MAX_VALUE_ITEMS',
      'ERROR_REPORT_MAX_STRING_BYTES',
      'ERROR_REPORT_EVENT_LIMIT',
      'ERROR_REPORT_RESPONSE_MAX_BYTES',
      'ERROR_REPORT_STORED_ERROR_MAX_BYTES',
      'ERROR_REPORT_COLLECTOR_CONCURRENCY',
      'PLATFORM_FEEDBACK_PROJECT_ID',
      'REPORT_ISSUE_TITLE_MAX_LENGTH',
      'REPORT_ISSUE_DESCRIPTION_MAX_LENGTH',
      'REPORT_ISSUE_CONTENT_MAX_LENGTH',
      'RATE_LIMIT_REPORT_ISSUE_POST',
      'CF_CONTAINER_ENABLED',
      'PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES',
      'PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS',
      'PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES',
      'PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH',
      'PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS',
      'PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS',
      'PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS',
      'PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS',
      'PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS',
      'PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS',
      'PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS',
      'PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE',
      'PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY',
      'PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE',
      'PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS',
      'PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS',
      'PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW',
      'PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES',
      'PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH',
      'PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED',
      'PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME',
      'PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE',
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
      // Guided Codex credential-setup tuning.
      'MAX_CONCURRENT_SETUP_SESSIONS',
      'SETUP_SESSION_TTL_MS',
      'SETUP_SESSION_CAPTURE_POLL_MS',
      'CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS',
      'SETUP_SESSION_SWEEP_MAX_CANDIDATES',
      'POOL_LEASE_BUFFER_MS',
      'VM_AGENT_REQUIRED_VERSION',
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
  deployedMigrationTag: string | null
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

    // Workers Observability
    observability: {
      enabled: true,
      logs: {
        invocation_logs: true,
        head_sampling_rate: 1,
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
    artifactsBindingEnabled,
    deployedMigrationTag
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
