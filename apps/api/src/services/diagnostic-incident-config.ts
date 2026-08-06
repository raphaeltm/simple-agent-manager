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
export const MIN_VM_INCIDENT_RECONCILE_BATCH_SIZE = 6;
const RESERVED_R2_TOP_LEVEL_PREFIXES = new Set([
  'agents',
  'cli',
  'compose-image-artifacts',
  'library',
  'session-snapshots',
  'temp-uploads',
  'tts',
]);

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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePrefix(value: string | undefined): string {
  const segments = (value || DEFAULT_VM_INCIDENT_R2_PREFIX)
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => /^[a-zA-Z0-9._-]+$/.test(segment) && segment !== '..');
  const topLevel = segments[0];
  return topLevel && !RESERVED_R2_TOP_LEVEL_PREFIXES.has(topLevel)
    ? segments.join('/')
    : DEFAULT_VM_INCIDENT_R2_PREFIX;
}

export function resolveDiagnosticIncidentConfig(env: Env): IncidentConfig {
  return {
    r2Prefix: normalizePrefix(env.VM_INCIDENT_R2_PREFIX),
    artifactMaxBytes: positiveInteger(
      env.VM_INCIDENT_ARTIFACT_MAX_BYTES,
      DEFAULT_VM_INCIDENT_ARTIFACT_MAX_BYTES
    ),
    registrationMaxBytes: positiveInteger(
      env.VM_INCIDENT_REGISTRATION_MAX_BYTES,
      DEFAULT_VM_INCIDENT_REGISTRATION_MAX_BYTES
    ),
    manifestMaxBytes: positiveInteger(
      env.VM_INCIDENT_MANIFEST_MAX_BYTES,
      DEFAULT_VM_INCIDENT_MANIFEST_MAX_BYTES
    ),
    previewMaxBytes: positiveInteger(
      env.VM_INCIDENT_PREVIEW_MAX_BYTES,
      DEFAULT_VM_INCIDENT_PREVIEW_MAX_BYTES
    ),
    maxArtifactsPerNode: positiveInteger(
      env.VM_INCIDENT_MAX_ARTIFACTS_PER_NODE,
      DEFAULT_VM_INCIDENT_MAX_ARTIFACTS_PER_NODE
    ),
    maxBytesPerNode: positiveInteger(
      env.VM_INCIDENT_MAX_BYTES_PER_NODE,
      DEFAULT_VM_INCIDENT_MAX_BYTES_PER_NODE
    ),
    retentionDays: positiveInteger(
      env.VM_INCIDENT_RETENTION_DAYS,
      DEFAULT_VM_INCIDENT_RETENTION_DAYS
    ),
    metadataRetentionDays: positiveInteger(
      env.VM_INCIDENT_METADATA_RETENTION_DAYS,
      DEFAULT_VM_INCIDENT_METADATA_RETENTION_DAYS
    ),
    pendingTimeoutMinutes: positiveInteger(
      env.VM_INCIDENT_PENDING_TIMEOUT_MINUTES,
      DEFAULT_VM_INCIDENT_PENDING_TIMEOUT_MINUTES
    ),
    reconcileBatchSize: Math.max(
      MIN_VM_INCIDENT_RECONCILE_BATCH_SIZE,
      positiveInteger(
        env.VM_INCIDENT_RECONCILE_BATCH_SIZE,
        DEFAULT_VM_INCIDENT_RECONCILE_BATCH_SIZE
      )
    ),
  };
}
