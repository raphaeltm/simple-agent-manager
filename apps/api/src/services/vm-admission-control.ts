import { ProviderError } from '@simple-agent-manager/providers';
import type {
  CredentialProvider,
  CredentialSource,
  VMLocation,
  VMSize,
  VmAdmissionControlMode,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_VM_ADMISSION_CONTROL_MODE,
  DEFAULT_VM_ADMISSION_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  DEFAULT_VM_ADMISSION_LEASE_TTL_MS,
  DEFAULT_VM_ADMISSION_PROVIDER_COOLDOWN_MS,
  DEFAULT_VM_ADMISSION_RETRY_MAX_MS,
  DEFAULT_VM_ADMISSION_RETRY_MIN_MS,
  DEFAULT_VM_ADMISSION_WAIT_TIMEOUT_MS,
  DEFAULT_VM_ADMISSION_WAKE_BATCH_SIZE,
  VM_ADMISSION_CONTROL_MODES,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveCredentialSource } from './provider-credentials';

export type VmAdmissionState =
  | 'queued'
  | 'waiting'
  | 'provisioning_granted'
  | 'provisioning'
  | 'node_ready'
  | 'placed'
  | 'cancelled'
  | 'failed'
  | 'expired';

export type VmAdmissionReason =
  | 'admission_created'
  | 'admission_shadow'
  | 'compatible_node_provisioning'
  | 'provider_account_capacity'
  | 'provider_transient_capacity'
  | 'user_node_limit'
  | 'lease_expired_recovered'
  | 'provisioning_lease_held'
  | 'provisioning_started'
  | 'node_ready'
  | 'placed'
  | 'cancelled'
  | 'task_failed'
  | 'wait_deadline_expired';

export interface VmAdmissionConfig {
  mode: VmAdmissionControlMode;
  leaseTtlMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  waitTimeoutMs: number;
  providerCooldownMs: number;
  wakeBatchSize: number;
  diagnosticMessageMaxLength: number;
}

export interface VmAdmissionScope {
  provider: CredentialProvider;
  credentialSource: CredentialSource;
  credentialDomainKey: string;
  providerDomainKey: string;
  scopeKey: string;
}

export interface VmTaskAdmissionIdentity extends VmAdmissionScope {
  taskId: string;
  projectId: string;
  userId: string;
  requestedVmSize: VMSize;
  requestedVmLocation: VMLocation;
  preferredNodeId?: string | null;
}

export interface VmProvisioningGrant {
  kind: 'granted';
  scopeKey: string;
  fencingToken: number;
}

export interface VmAdmissionWait {
  kind: 'waiting';
  reason: VmAdmissionReason;
  nextRetryAt: string;
  waitDeadlineAt: string;
}

export interface VmAdmissionExpired {
  kind: 'expired';
  reason: 'wait_deadline_expired';
  waitDeadlineAt: string;
}

export type VmProvisioningLeaseResult = VmProvisioningGrant | VmAdmissionWait | VmAdmissionExpired;

export interface VmProviderCapacityInfo {
  provider: string;
  providerCategory: string | null;
  providerCode: string | null;
  providerStatusCode: number | null;
  providerMessage: string | null;
}

interface VmTaskAdmissionRow {
  task_id: string;
  project_id: string;
  user_id: string;
  provider: string;
  credential_domain_key: string;
  provider_domain_key: string;
  scope_key: string;
  requested_vm_size: string;
  requested_vm_location: string;
  state: VmAdmissionState;
  reason: VmAdmissionReason | null;
  inflight_node_id: string | null;
  fencing_token: number | null;
  attempt_count: number;
  next_retry_at: string | null;
  wait_deadline_at: string | null;
}

interface VmProvisioningLeaseRow {
  scope_key: string;
  owner_task_id: string;
  fencing_token: number;
  provider: string;
  credential_domain_key: string;
  provider_domain_key: string;
  requested_vm_size: string;
  inflight_node_id: string | null;
  expires_at: string;
}

interface VmProviderCapacityRow {
  provider_domain_key: string;
  provider: string;
  credential_domain_key: string;
  state: 'ok' | 'cooldown';
  reason: VmAdmissionReason | null;
  provider_category: string | null;
  provider_code: string | null;
  provider_status_code: number | null;
  provider_message: string | null;
  retry_at: string | null;
}

const ACTIVE_ADMISSION_STATES = new Set<VmAdmissionState>([
  'queued',
  'waiting',
  'provisioning_granted',
  'provisioning',
  'node_ready',
]);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAdmissionMode(value: string | undefined): VmAdmissionControlMode {
  const candidate = value?.trim();
  if (candidate && (VM_ADMISSION_CONTROL_MODES as readonly string[]).includes(candidate)) {
    return candidate as VmAdmissionControlMode;
  }
  return DEFAULT_VM_ADMISSION_CONTROL_MODE;
}

export function getVmAdmissionConfig(env: Env): VmAdmissionConfig {
  const retryMinMs = parsePositiveInt(
    env.VM_ADMISSION_RETRY_MIN_MS,
    DEFAULT_VM_ADMISSION_RETRY_MIN_MS
  );
  const retryMaxMs = Math.max(
    retryMinMs,
    parsePositiveInt(env.VM_ADMISSION_RETRY_MAX_MS, DEFAULT_VM_ADMISSION_RETRY_MAX_MS)
  );
  return {
    mode: parseAdmissionMode(env.VM_ADMISSION_CONTROL_MODE),
    leaseTtlMs: parsePositiveInt(
      env.VM_ADMISSION_LEASE_TTL_MS,
      DEFAULT_VM_ADMISSION_LEASE_TTL_MS
    ),
    retryMinMs,
    retryMaxMs,
    waitTimeoutMs: parsePositiveInt(
      env.VM_ADMISSION_WAIT_TIMEOUT_MS,
      DEFAULT_VM_ADMISSION_WAIT_TIMEOUT_MS
    ),
    providerCooldownMs: parsePositiveInt(
      env.VM_ADMISSION_PROVIDER_COOLDOWN_MS,
      DEFAULT_VM_ADMISSION_PROVIDER_COOLDOWN_MS
    ),
    wakeBatchSize: parsePositiveInt(
      env.VM_ADMISSION_WAKE_BATCH_SIZE,
      DEFAULT_VM_ADMISSION_WAKE_BATCH_SIZE
    ),
    diagnosticMessageMaxLength: parsePositiveInt(
      env.VM_ADMISSION_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
      DEFAULT_VM_ADMISSION_DIAGNOSTIC_MESSAGE_MAX_LENGTH
    ),
  };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truncateDiagnosticMessage(message: string | null, maxLength: number): string | null {
  if (!message) return null;
  return message.length > maxLength ? `${message.slice(0, Math.max(0, maxLength - 1))}…` : message;
}

function changes(result: unknown): number {
  return (
    (result as { meta?: { changes?: number; rows_written?: number } }).meta?.changes ??
    (result as { meta?: { changes?: number; rows_written?: number } }).meta?.rows_written ??
    0
  );
}

async function first<T>(database: D1Database, query: string, binds: unknown[] = []): Promise<T | null> {
  const row = await database.prepare(query).bind(...binds).first<T>();
  return row ?? null;
}

function buildCredentialDomainKey(input: {
  credentialSource: CredentialSource;
  provider: CredentialProvider;
  attributionUserId: string;
  attributionProjectId: string | null;
  projectId: string;
}): string {
  switch (input.credentialSource) {
    case 'platform':
      return `platform:${input.provider}`;
    case 'project':
      return `project:${input.attributionProjectId ?? input.projectId}:${input.attributionUserId}:${input.provider}`;
    case 'user':
    default:
      return `user:${input.attributionUserId}:${input.provider}`;
  }
}

export async function resolveVmAdmissionScope(
  env: Env,
  input: {
    userId: string;
    projectId: string;
    targetProvider?: CredentialProvider | null;
    credentialAttributionUserId?: string | null;
    credentialAttributionProjectId?: string | null;
    credentialAttributionSource?: CredentialSource | null;
  }
): Promise<VmAdmissionScope | null> {
  const db = drizzle(env.DATABASE, { schema });
  const attributionUserId = input.credentialAttributionUserId ?? input.userId;
  const attributionProjectId =
    input.credentialAttributionSource === 'project'
      ? (input.credentialAttributionProjectId ?? input.projectId)
      : null;
  const resolved = await resolveCredentialSource(
    db,
    attributionUserId,
    input.targetProvider ?? undefined,
    attributionProjectId
  );
  if (!resolved) return null;

  const credentialDomainKey = buildCredentialDomainKey({
    credentialSource: resolved.credentialSource,
    provider: resolved.providerName,
    attributionUserId,
    attributionProjectId,
    projectId: input.projectId,
  });
  const providerDomainKey = `${resolved.providerName}:${credentialDomainKey}`;
  return {
    provider: resolved.providerName,
    credentialSource: resolved.credentialSource,
    credentialDomainKey,
    providerDomainKey,
    scopeKey: `user:${input.userId}:workspace-vm:${providerDomainKey}`,
  };
}

export async function ensureVmTaskAdmission(
  env: Env,
  input: VmTaskAdmissionIdentity,
  reason: VmAdmissionReason = 'admission_created'
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `
      INSERT INTO vm_task_admissions (
        task_id, project_id, user_id, provider, credential_domain_key, provider_domain_key,
        scope_key, requested_vm_size, requested_vm_location, preferred_node_id,
        state, reason, enqueued_at, last_evaluated_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_id = excluded.project_id,
        user_id = excluded.user_id,
        provider = excluded.provider,
        credential_domain_key = excluded.credential_domain_key,
        provider_domain_key = excluded.provider_domain_key,
        scope_key = excluded.scope_key,
        requested_vm_size = excluded.requested_vm_size,
        requested_vm_location = excluded.requested_vm_location,
        preferred_node_id = excluded.preferred_node_id,
        last_evaluated_at = excluded.last_evaluated_at,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      input.taskId,
      input.projectId,
      input.userId,
      input.provider,
      input.credentialDomainKey,
      input.providerDomainKey,
      input.scopeKey,
      input.requestedVmSize,
      input.requestedVmLocation,
      input.preferredNodeId ?? null,
      reason,
      now,
      now,
      now
    )
    .run();
}

async function getAdmission(env: Env, taskId: string): Promise<VmTaskAdmissionRow | null> {
  return first<VmTaskAdmissionRow>(
    env.DATABASE,
    `
      SELECT task_id, project_id, user_id, provider, credential_domain_key, provider_domain_key,
        scope_key, requested_vm_size, requested_vm_location, state, reason, inflight_node_id,
        fencing_token, attempt_count, next_retry_at, wait_deadline_at
      FROM vm_task_admissions
      WHERE task_id = ?
      LIMIT 1
    `,
    [taskId]
  );
}

async function getLease(env: Env, scopeKey: string): Promise<VmProvisioningLeaseRow | null> {
  return first<VmProvisioningLeaseRow>(
    env.DATABASE,
    `
      SELECT scope_key, owner_task_id, fencing_token, provider, credential_domain_key,
        provider_domain_key, requested_vm_size, inflight_node_id, expires_at
      FROM vm_provisioning_leases
      WHERE scope_key = ?
      LIMIT 1
    `,
    [scopeKey]
  );
}

async function setTaskAdmissionMirror(
  env: Env,
  taskId: string,
  state: VmAdmissionState | null,
  reason: VmAdmissionReason | string | null,
  nextRetryAt: string | null
): Promise<void> {
  await env.DATABASE.prepare(
    `
      UPDATE tasks
      SET admission_state = ?, admission_reason = ?, admission_next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `
  )
    .bind(state, reason, nextRetryAt, new Date().toISOString(), taskId)
    .run();
}

function computeRetryAt(
  config: VmAdmissionConfig,
  nowMs: number,
  attemptCount: number,
  suggestedRetryAt?: string | null
): string {
  const delayMs = Math.min(config.retryMinMs * Math.max(1, attemptCount + 1), config.retryMaxMs);
  let retryMs = nowMs + delayMs;
  const suggestedMs = parseIsoMs(suggestedRetryAt);
  if (suggestedMs && suggestedMs > retryMs) retryMs = suggestedMs;
  return toIso(retryMs);
}

export async function waitForVmAdmissionCapacity(
  env: Env,
  input: VmTaskAdmissionIdentity,
  reason: VmAdmissionReason,
  suggestedRetryAt?: string | null,
  providerInfo?: VmProviderCapacityInfo | null
): Promise<VmAdmissionWait | VmAdmissionExpired> {
  await ensureVmTaskAdmission(env, input);
  const config = getVmAdmissionConfig(env);
  const existing = await getAdmission(env, input.taskId);
  const nowMs = Date.now();
  const now = toIso(nowMs);
  const deadlineAt = existing?.wait_deadline_at ?? toIso(nowMs + config.waitTimeoutMs);
  const deadlineMs = parseIsoMs(deadlineAt) ?? nowMs;

  if (deadlineMs <= nowMs) {
    await env.DATABASE.prepare(
      `
        UPDATE vm_task_admissions
        SET state = 'expired', reason = 'wait_deadline_expired', next_retry_at = NULL,
          completed_at = ?, updated_at = ?
        WHERE task_id = ?
      `
    )
      .bind(now, now, input.taskId)
      .run();
    await setTaskAdmissionMirror(env, input.taskId, 'expired', 'wait_deadline_expired', null);
    return { kind: 'expired', reason: 'wait_deadline_expired', waitDeadlineAt: deadlineAt };
  }

  const attemptCount = existing?.attempt_count ?? 0;
  const retryAt = computeRetryAt(config, nowMs, attemptCount, suggestedRetryAt);
  const retryMs = parseIsoMs(retryAt) ?? nowMs;
  const boundedRetryAt = toIso(Math.min(retryMs, deadlineMs));
  const providerMessage = truncateDiagnosticMessage(
    providerInfo?.providerMessage ?? null,
    config.diagnosticMessageMaxLength
  );

  await env.DATABASE.prepare(
    `
      UPDATE vm_task_admissions
      SET state = 'waiting',
        reason = ?,
        attempt_count = attempt_count + 1,
        next_retry_at = ?,
        wait_deadline_at = ?,
        provider_category = ?,
        provider_code = ?,
        provider_status_code = ?,
        provider_message = ?,
        last_evaluated_at = ?,
        updated_at = ?
      WHERE task_id = ?
    `
  )
    .bind(
      reason,
      boundedRetryAt,
      deadlineAt,
      providerInfo?.providerCategory ?? null,
      providerInfo?.providerCode ?? null,
      providerInfo?.providerStatusCode ?? null,
      providerMessage,
      now,
      now,
      input.taskId
    )
    .run();
  await env.DATABASE.prepare(
    `
      UPDATE tasks
      SET execution_step = 'waiting_for_node_capacity',
        admission_state = 'waiting',
        admission_reason = ?,
        admission_next_retry_at = ?,
        updated_at = ?
      WHERE id = ?
    `
  )
    .bind(reason, boundedRetryAt, now, input.taskId)
    .run();

  return {
    kind: 'waiting',
    reason,
    nextRetryAt: boundedRetryAt,
    waitDeadlineAt: deadlineAt,
  };
}

async function markProvisioningGranted(
  env: Env,
  input: VmTaskAdmissionIdentity,
  fencingToken: number,
  reason: VmAdmissionReason
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `
      UPDATE vm_task_admissions
      SET state = 'provisioning_granted',
        reason = ?,
        fencing_token = ?,
        next_retry_at = NULL,
        claimed_at = COALESCE(claimed_at, ?),
        last_evaluated_at = ?,
        updated_at = ?
      WHERE task_id = ?
    `
  )
    .bind(reason, fencingToken, now, now, now, input.taskId)
    .run();
  await setTaskAdmissionMirror(env, input.taskId, 'provisioning_granted', reason, null);
}

async function activeProviderCapacityCooldown(
  env: Env,
  providerDomainKey: string
): Promise<VmProviderCapacityRow | null> {
  const row = await first<VmProviderCapacityRow>(
    env.DATABASE,
    `
      SELECT provider_domain_key, provider, credential_domain_key, state, reason,
        provider_category, provider_code, provider_status_code, provider_message, retry_at
      FROM vm_provider_capacity_state
      WHERE provider_domain_key = ?
      LIMIT 1
    `,
    [providerDomainKey]
  );
  if (!row || row.state !== 'cooldown') return null;
  const retryMs = parseIsoMs(row.retry_at);
  return retryMs && retryMs > Date.now() ? row : null;
}

async function isLiveInflightNode(env: Env, nodeId: string | null): Promise<boolean> {
  if (!nodeId) return false;
  const row = await first<{ id: string }>(
    env.DATABASE,
    `
      SELECT id
      FROM nodes
      WHERE id = ?
        AND status IN ('creating', 'running', 'recovery')
      LIMIT 1
    `,
    [nodeId]
  );
  return !!row;
}

export async function tryAcquireVmProvisioningLease(
  env: Env,
  input: VmTaskAdmissionIdentity
): Promise<VmProvisioningLeaseResult> {
  await ensureVmTaskAdmission(env, input);
  const config = getVmAdmissionConfig(env);
  if (config.mode === 'off' || config.mode === 'shadow') {
    await markProvisioningGranted(env, input, 0, config.mode === 'shadow' ? 'admission_shadow' : 'admission_created');
    return { kind: 'granted', scopeKey: input.scopeKey, fencingToken: 0 };
  }

  const capacityCooldown = await activeProviderCapacityCooldown(env, input.providerDomainKey);
  if (capacityCooldown) {
    return waitForVmAdmissionCapacity(
      env,
      input,
      'provider_account_capacity',
      capacityCooldown.retry_at,
      {
        provider: capacityCooldown.provider,
        providerCategory: capacityCooldown.provider_category,
        providerCode: capacityCooldown.provider_code,
        providerStatusCode: capacityCooldown.provider_status_code,
        providerMessage: capacityCooldown.provider_message,
      }
    );
  }

  const nowMs = Date.now();
  const now = toIso(nowMs);
  const expiresAt = toIso(nowMs + config.leaseTtlMs);
  const inserted = await env.DATABASE.prepare(
    `
      INSERT INTO vm_provisioning_leases (
        scope_key, owner_task_id, fencing_token, provider, credential_domain_key,
        provider_domain_key, requested_vm_size, acquired_at, heartbeat_at, expires_at, updated_at
      )
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO NOTHING
    `
  )
    .bind(
      input.scopeKey,
      input.taskId,
      input.provider,
      input.credentialDomainKey,
      input.providerDomainKey,
      input.requestedVmSize,
      now,
      now,
      expiresAt,
      now
    )
    .run();

  if (changes(inserted) > 0) {
    await markProvisioningGranted(env, input, 1, 'provisioning_lease_held');
    return { kind: 'granted', scopeKey: input.scopeKey, fencingToken: 1 };
  }

  const existing = await getLease(env, input.scopeKey);
  if (!existing) {
    return waitForVmAdmissionCapacity(env, input, 'compatible_node_provisioning');
  }

  const existingExpiresMs = parseIsoMs(existing.expires_at) ?? 0;
  if (existing.owner_task_id === input.taskId && existingExpiresMs > nowMs) {
    await renewVmProvisioningLease(env, input.scopeKey, input.taskId, existing.fencing_token);
    await markProvisioningGranted(env, input, existing.fencing_token, 'provisioning_lease_held');
    return {
      kind: 'granted',
      scopeKey: input.scopeKey,
      fencingToken: existing.fencing_token,
    };
  }

  if (existingExpiresMs > nowMs) {
    return waitForVmAdmissionCapacity(
      env,
      input,
      'compatible_node_provisioning',
      existing.expires_at
    );
  }

  if (await isLiveInflightNode(env, existing.inflight_node_id)) {
    const recoveryExpiresAt = toIso(nowMs + config.leaseTtlMs);
    await env.DATABASE.prepare(
      `
        UPDATE vm_provisioning_leases
        SET heartbeat_at = ?, expires_at = ?, updated_at = ?
        WHERE scope_key = ? AND owner_task_id = ? AND fencing_token = ?
      `
    )
      .bind(
        now,
        recoveryExpiresAt,
        now,
        existing.scope_key,
        existing.owner_task_id,
        existing.fencing_token
      )
      .run();
    return waitForVmAdmissionCapacity(
      env,
      input,
      'compatible_node_provisioning',
      recoveryExpiresAt
    );
  }

  const stolen = await env.DATABASE.prepare(
    `
      UPDATE vm_provisioning_leases
      SET owner_task_id = ?,
        fencing_token = fencing_token + 1,
        provider = ?,
        credential_domain_key = ?,
        provider_domain_key = ?,
        requested_vm_size = ?,
        inflight_node_id = NULL,
        acquired_at = ?,
        heartbeat_at = ?,
        expires_at = ?,
        updated_at = ?
      WHERE scope_key = ?
        AND expires_at <= ?
        AND (
          inflight_node_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM nodes
            WHERE nodes.id = vm_provisioning_leases.inflight_node_id
              AND nodes.status IN ('creating', 'running', 'recovery')
          )
        )
    `
  )
    .bind(
      input.taskId,
      input.provider,
      input.credentialDomainKey,
      input.providerDomainKey,
      input.requestedVmSize,
      now,
      now,
      expiresAt,
      now,
      input.scopeKey,
      now
    )
    .run();

  if (changes(stolen) > 0) {
    const updated = await getLease(env, input.scopeKey);
    if (updated?.owner_task_id === input.taskId) {
      await markProvisioningGranted(env, input, updated.fencing_token, 'lease_expired_recovered');
      return {
        kind: 'granted',
        scopeKey: input.scopeKey,
        fencingToken: updated.fencing_token,
      };
    }
  }

  const current = await getLease(env, input.scopeKey);
  return waitForVmAdmissionCapacity(
    env,
    input,
    'compatible_node_provisioning',
    current?.expires_at ?? null
  );
}

export async function renewVmProvisioningLease(
  env: Env,
  scopeKey: string | null | undefined,
  ownerTaskId: string,
  fencingToken: number | null | undefined
): Promise<boolean> {
  if (!scopeKey || !fencingToken) return false;
  const config = getVmAdmissionConfig(env);
  const nowMs = Date.now();
  const now = toIso(nowMs);
  const result = await env.DATABASE.prepare(
    `
      UPDATE vm_provisioning_leases
      SET heartbeat_at = ?, expires_at = ?, updated_at = ?
      WHERE scope_key = ? AND owner_task_id = ? AND fencing_token = ?
    `
  )
    .bind(now, toIso(nowMs + config.leaseTtlMs), now, scopeKey, ownerTaskId, fencingToken)
    .run();
  return changes(result) > 0;
}

export async function assertVmProvisioningLease(
  env: Env,
  scopeKey: string | null | undefined,
  ownerTaskId: string,
  fencingToken: number | null | undefined
): Promise<void> {
  const config = getVmAdmissionConfig(env);
  if (config.mode === 'off' || config.mode === 'shadow') return;
  if (!scopeKey && !fencingToken) return;
  if (!scopeKey || !fencingToken) {
    throw Object.assign(new Error('VM provisioning lease missing'), { permanent: true });
  }
  const lease = await getLease(env, scopeKey);
  const expiresMs = parseIsoMs(lease?.expires_at);
  if (
    !lease ||
    lease.owner_task_id !== ownerTaskId ||
    lease.fencing_token !== fencingToken ||
    !expiresMs ||
    expiresMs <= Date.now()
  ) {
    throw Object.assign(new Error('VM provisioning lease lost'), { permanent: true });
  }
}

export async function markVmProvisioningLeaseInflightNode(
  env: Env,
  scopeKey: string | null | undefined,
  ownerTaskId: string,
  fencingToken: number | null | undefined,
  nodeId: string
): Promise<boolean> {
  if (!scopeKey || !fencingToken) return false;
  const now = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `
      UPDATE vm_provisioning_leases
      SET inflight_node_id = ?, heartbeat_at = ?, updated_at = ?
      WHERE scope_key = ? AND owner_task_id = ? AND fencing_token = ?
    `
  )
    .bind(nodeId, now, now, scopeKey, ownerTaskId, fencingToken)
    .run();
  if (changes(result) <= 0) return false;
  await env.DATABASE.prepare(
    `
      UPDATE vm_task_admissions
      SET state = 'provisioning',
        reason = 'provisioning_started',
        inflight_node_id = ?,
        fencing_token = ?,
        updated_at = ?
      WHERE task_id = ?
    `
  )
    .bind(nodeId, fencingToken, now, ownerTaskId)
    .run();
  await setTaskAdmissionMirror(env, ownerTaskId, 'provisioning', 'provisioning_started', null);
  return true;
}

export async function releaseVmProvisioningLease(
  env: Env,
  scopeKey: string | null | undefined,
  ownerTaskId: string,
  fencingToken?: number | null,
  wakeReason = 'lease_released'
): Promise<boolean> {
  if (!scopeKey) return false;
  const result =
    fencingToken && fencingToken > 0
      ? await env.DATABASE.prepare(
          `
            DELETE FROM vm_provisioning_leases
            WHERE scope_key = ? AND owner_task_id = ? AND fencing_token = ?
          `
        )
          .bind(scopeKey, ownerTaskId, fencingToken)
          .run()
      : await env.DATABASE.prepare(
          `
            DELETE FROM vm_provisioning_leases
            WHERE scope_key = ? AND owner_task_id = ?
          `
        )
          .bind(scopeKey, ownerTaskId)
          .run();
  const released = changes(result) > 0;
  if (released) {
    await wakeVmAdmissionWaiters(env, { scopeKey, reason: wakeReason });
  }
  return released;
}

export async function markVmAdmissionNodeReady(
  env: Env,
  input: {
    taskId: string;
    nodeId: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `
      UPDATE vm_task_admissions
      SET state = 'node_ready', reason = 'node_ready', selected_node_id = ?, updated_at = ?
      WHERE task_id = ?
    `
  )
    .bind(input.nodeId, now, input.taskId)
    .run();
  await setTaskAdmissionMirror(env, input.taskId, 'node_ready', 'node_ready', null);
}

export async function markVmAdmissionPlaced(
  env: Env,
  input: {
    taskId: string;
    nodeId: string;
    scopeKey?: string | null;
    fencingToken?: number | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const admission = await getAdmission(env, input.taskId);
  await env.DATABASE.prepare(
    `
      UPDATE vm_task_admissions
      SET state = 'placed',
        reason = 'placed',
        selected_node_id = ?,
        next_retry_at = NULL,
        completed_at = ?,
        updated_at = ?
      WHERE task_id = ?
    `
  )
    .bind(input.nodeId, now, now, input.taskId)
    .run();
  await setTaskAdmissionMirror(env, input.taskId, 'placed', 'placed', null);
  await releaseVmProvisioningLease(
    env,
    input.scopeKey ?? admission?.scope_key,
    input.taskId,
    input.fencingToken ?? admission?.fencing_token,
    'admission_placed'
  );
}

export async function cancelVmTaskAdmission(
  env: Env,
  taskId: string,
  reason: VmAdmissionReason | string = 'cancelled'
): Promise<void> {
  const admission = await getAdmission(env, taskId);
  const now = new Date().toISOString();
  const terminalized = await env.DATABASE.prepare(
    `
      UPDATE vm_task_admissions
      SET state = ?,
        reason = ?,
        next_retry_at = NULL,
        completed_at = COALESCE(completed_at, ?),
        updated_at = ?
      WHERE task_id = ?
        AND state IN ('queued', 'waiting', 'provisioning_granted', 'provisioning', 'node_ready')
    `
  )
    .bind(reason === 'task_failed' ? 'failed' : 'cancelled', reason, now, now, taskId)
    .run();
  await env.DATABASE.prepare(`DELETE FROM vm_provisioning_leases WHERE owner_task_id = ?`)
    .bind(taskId)
    .run();
  if (changes(terminalized) > 0) {
    await setTaskAdmissionMirror(
      env,
      taskId,
      reason === 'task_failed' ? 'failed' : 'cancelled',
      reason,
      null
    );
  }
  if (admission?.scope_key) {
    await wakeVmAdmissionWaiters(env, { scopeKey: admission.scope_key, reason: 'admission_cancelled' });
  }
}

export function classifyVmProviderCapacityError(err: unknown): VmProviderCapacityInfo | null {
  if (!(err instanceof ProviderError)) return null;
  if (
    err.providerName === 'hetzner' &&
    err.statusCode === 403 &&
    (err.providerCode === 'server_limit_exceeded' ||
      err.message.toLowerCase().includes('server_limit_exceeded') ||
      err.message.toLowerCase().includes('server limit'))
  ) {
    return {
      provider: err.providerName,
      providerCategory: err.category,
      providerCode: err.providerCode ?? 'server_limit_exceeded',
      providerStatusCode: err.statusCode,
      providerMessage: err.message,
    };
  }
  return null;
}

export function isProviderAccountCapacityError(err: unknown): boolean {
  return classifyVmProviderCapacityError(err) !== null;
}

export async function recordVmProviderCapacityFailure(
  env: Env,
  input: {
    scope: VmAdmissionScope;
    error: unknown;
  }
): Promise<VmProviderCapacityInfo | null> {
  const info = classifyVmProviderCapacityError(input.error);
  if (!info) return null;
  const config = getVmAdmissionConfig(env);
  const nowMs = Date.now();
  const now = toIso(nowMs);
  const retryAt = toIso(nowMs + config.providerCooldownMs);
  const providerMessage = truncateDiagnosticMessage(
    info.providerMessage,
    config.diagnosticMessageMaxLength
  );
  await env.DATABASE.prepare(
    `
      INSERT INTO vm_provider_capacity_state (
        provider_domain_key, provider, credential_domain_key, state, reason,
        provider_category, provider_code, provider_status_code, provider_message,
        failure_count, retry_at, last_failure_at, updated_at
      )
      VALUES (?, ?, ?, 'cooldown', 'provider_account_capacity', ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(provider_domain_key) DO UPDATE SET
        state = 'cooldown',
        reason = 'provider_account_capacity',
        provider_category = excluded.provider_category,
        provider_code = excluded.provider_code,
        provider_status_code = excluded.provider_status_code,
        provider_message = excluded.provider_message,
        failure_count = failure_count + 1,
        retry_at = excluded.retry_at,
        last_failure_at = excluded.last_failure_at,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      input.scope.providerDomainKey,
      input.scope.provider,
      input.scope.credentialDomainKey,
      info.providerCategory,
      info.providerCode,
      info.providerStatusCode,
      providerMessage,
      retryAt,
      now,
      now
    )
    .run();
  return { ...info, providerMessage };
}

export async function recordVmProviderCapacitySuccess(
  env: Env,
  scope: VmAdmissionScope
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `
      INSERT INTO vm_provider_capacity_state (
        provider_domain_key, provider, credential_domain_key, state,
        failure_count, last_success_at, updated_at
      )
      VALUES (?, ?, ?, 'ok', 0, ?, ?)
      ON CONFLICT(provider_domain_key) DO UPDATE SET
        state = 'ok',
        reason = NULL,
        retry_at = NULL,
        provider_category = NULL,
        provider_code = NULL,
        provider_status_code = NULL,
        provider_message = NULL,
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at
    `
  )
    .bind(scope.providerDomainKey, scope.provider, scope.credentialDomainKey, now, now)
    .run();
}

async function nudgeTaskRunner(env: Env, taskId: string, reason: string): Promise<boolean> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  const stub = env.TASK_RUNNER.get(id) as DurableObjectStub<{
    nudge(reason?: string): Promise<boolean>;
  }>;
  return stub.nudge(reason);
}

export async function wakeVmAdmissionWaiters(
  env: Env,
  input: {
    scopeKey?: string | null;
    providerDomainKey?: string | null;
    userId?: string | null;
    reason: string;
  }
): Promise<number> {
  const config = getVmAdmissionConfig(env);
  const binds: unknown[] = [];
  const filters = [`state IN ('queued', 'waiting')`];
  if (input.scopeKey) {
    filters.push('scope_key = ?');
    binds.push(input.scopeKey);
  } else if (input.providerDomainKey) {
    filters.push('provider_domain_key = ?');
    binds.push(input.providerDomainKey);
  } else if (input.userId) {
    filters.push('user_id = ?');
    binds.push(input.userId);
  }
  binds.push(config.wakeBatchSize);
  const rows = await env.DATABASE.prepare(
    `
      SELECT task_id
      FROM vm_task_admissions
      WHERE ${filters.join(' AND ')}
      ORDER BY enqueued_at ASC
      LIMIT ?
    `
  )
    .bind(...binds)
    .all<{ task_id: string }>();

  let nudged = 0;
  for (const row of rows.results ?? []) {
    try {
      if (await nudgeTaskRunner(env, row.task_id, input.reason)) nudged++;
    } catch (err) {
      log.warn('vm_admission.wake_waiter_failed', {
        taskId: row.task_id,
        reason: input.reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return nudged;
}

export async function getVmAdmissionDiagnostics(
  env: Env,
  taskId: string
): Promise<{
  admission: Record<string, unknown> | null;
  lease: Record<string, unknown> | null;
  providerCapacity: Record<string, unknown> | null;
}> {
  const admission = await first<Record<string, unknown>>(
    env.DATABASE,
    `SELECT * FROM vm_task_admissions WHERE task_id = ? LIMIT 1`,
    [taskId]
  );
  const lease = admission?.scope_key
    ? await first<Record<string, unknown>>(
        env.DATABASE,
        `SELECT * FROM vm_provisioning_leases WHERE scope_key = ? LIMIT 1`,
        [admission.scope_key]
      )
    : null;
  const providerCapacity = admission?.provider_domain_key
    ? await first<Record<string, unknown>>(
        env.DATABASE,
        `SELECT * FROM vm_provider_capacity_state WHERE provider_domain_key = ? LIMIT 1`,
        [admission.provider_domain_key]
      )
    : null;
  return { admission, lease, providerCapacity };
}

export function isActiveVmAdmissionState(state: string | null | undefined): boolean {
  return !!state && ACTIVE_ADMISSION_STATES.has(state as VmAdmissionState);
}
