import type { Env } from '../env';

export const DEFAULT_VM_INCIDENT_R2_PREFIX = 'diagnostic-incidents';
export const DEFAULT_VM_INCIDENT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_VM_INCIDENT_REGISTRATION_MAX_BYTES = 256 * 1024;
export const DEFAULT_VM_INCIDENT_MANIFEST_MAX_BYTES = 128 * 1024;
export const DEFAULT_VM_INCIDENT_PREVIEW_MAX_BYTES = 128 * 1024;
export const DEFAULT_VM_INCIDENT_MAX_ARTIFACTS_PER_NODE = 50;
export const DEFAULT_VM_INCIDENT_MAX_BYTES_PER_NODE = 100 * 1024 * 1024;
export const DEFAULT_VM_INCIDENT_RETENTION_DAYS = 7;
export const DEFAULT_VM_INCIDENT_METADATA_RETENTION_DAYS = 30;
export const DEFAULT_VM_INCIDENT_PENDING_TIMEOUT_MINUTES = 30;
export const DEFAULT_VM_INCIDENT_RECONCILE_BATCH_SIZE = 50;
export const MIN_VM_INCIDENT_RECONCILE_BATCH_SIZE = 5;

export interface IncidentConfig {
  r2Prefix: string;
  artifactMaxBytes: number;
  registrationMaxBytes: number;
  manifestMaxBytes: number;
  previewMaxBytes: number;
  maxArtifactsPerNode: number;
  maxBytesPerNode: number;
  retentionDays: number;
  metadataRetentionDays: number;
  pendingTimeoutMinutes: number;
  reconcileBatchSize: number;
}

function positiveBounded(value: string | undefined, fallback: number, hardMax: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, hardMax) : fallback;
}

function normalizePrefix(value: string | undefined): string {
  const segments = (value || DEFAULT_VM_INCIDENT_R2_PREFIX)
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => /^[a-zA-Z0-9._-]+$/.test(segment) && segment !== '..');
  return segments.length > 0 ? segments.join('/') : DEFAULT_VM_INCIDENT_R2_PREFIX;
}

export function resolveDiagnosticIncidentConfig(env: Env): IncidentConfig {
  return {
    r2Prefix: normalizePrefix(env.VM_INCIDENT_R2_PREFIX),
    artifactMaxBytes: positiveBounded(
      env.VM_INCIDENT_ARTIFACT_MAX_BYTES,
      DEFAULT_VM_INCIDENT_ARTIFACT_MAX_BYTES,
      10 * 1024 * 1024
    ),
    registrationMaxBytes: positiveBounded(
      env.VM_INCIDENT_REGISTRATION_MAX_BYTES,
      DEFAULT_VM_INCIDENT_REGISTRATION_MAX_BYTES,
      1024 * 1024
    ),
    manifestMaxBytes: positiveBounded(
      env.VM_INCIDENT_MANIFEST_MAX_BYTES,
      DEFAULT_VM_INCIDENT_MANIFEST_MAX_BYTES,
      512 * 1024
    ),
    previewMaxBytes: positiveBounded(
      env.VM_INCIDENT_PREVIEW_MAX_BYTES,
      DEFAULT_VM_INCIDENT_PREVIEW_MAX_BYTES,
      512 * 1024
    ),
    maxArtifactsPerNode: positiveBounded(
      env.VM_INCIDENT_MAX_ARTIFACTS_PER_NODE,
      DEFAULT_VM_INCIDENT_MAX_ARTIFACTS_PER_NODE,
      500
    ),
    maxBytesPerNode: positiveBounded(
      env.VM_INCIDENT_MAX_BYTES_PER_NODE,
      DEFAULT_VM_INCIDENT_MAX_BYTES_PER_NODE,
      1024 * 1024 * 1024
    ),
    retentionDays: positiveBounded(
      env.VM_INCIDENT_RETENTION_DAYS,
      DEFAULT_VM_INCIDENT_RETENTION_DAYS,
      30
    ),
    metadataRetentionDays: positiveBounded(
      env.VM_INCIDENT_METADATA_RETENTION_DAYS,
      DEFAULT_VM_INCIDENT_METADATA_RETENTION_DAYS,
      365
    ),
    pendingTimeoutMinutes: positiveBounded(
      env.VM_INCIDENT_PENDING_TIMEOUT_MINUTES,
      DEFAULT_VM_INCIDENT_PENDING_TIMEOUT_MINUTES,
      24 * 60
    ),
    reconcileBatchSize: Math.max(
      MIN_VM_INCIDENT_RECONCILE_BATCH_SIZE,
      positiveBounded(
        env.VM_INCIDENT_RECONCILE_BATCH_SIZE,
        DEFAULT_VM_INCIDENT_RECONCILE_BATCH_SIZE,
        200
      )
    ),
  };
}
