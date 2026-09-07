import type {
  CredentialProvider,
  CredentialSource,
  VmAdmissionControlMode,
  VMLocation,
  VMSize,
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
  | 'task_cancelled'
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

export interface VmTaskAdmissionRow {
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

export interface VmProvisioningLeaseRow {
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

export interface VmProviderCapacityRow {
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

export const ACTIVE_ADMISSION_STATES = new Set<VmAdmissionState>([
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

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function truncateDiagnosticMessage(
  message: string | null,
  maxLength: number
): string | null {
  if (!message) return null;
  return message.length > maxLength ? `${message.slice(0, Math.max(0, maxLength - 1))}…` : message;
}

export function changes(result: unknown): number {
  return (
    (result as { meta?: { changes?: number; rows_written?: number } }).meta?.changes ??
    (result as { meta?: { changes?: number; rows_written?: number } }).meta?.rows_written ??
    0
  );
}

export async function first<T>(
  database: D1Database,
  query: string,
  binds: unknown[] = []
): Promise<T | null> {
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
