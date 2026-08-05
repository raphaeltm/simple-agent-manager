import type {
  DiagnosticArtifactSummary,
  DiagnosticIncidentManifest,
  DiagnosticIncidentStatus,
  DiagnosticIncidentSummary,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { type IncidentConfig, resolveDiagnosticIncidentConfig } from './diagnostic-incident-config';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ARTIFACT_KIND = 'safe-vm-incident-v1';
const SAFE_CONTENT_TYPE = 'application/gzip';
const textEncoder = new TextEncoder();

function assertULID(value: string, label: string): void {
  if (!ULID_PATTERN.test(value)) throw errors.badRequest(`${label} must be a ULID`);
}

function encodedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function deterministicObjectKey(
  config: IncidentConfig,
  nodeId: string,
  incidentId: string,
  artifactId: string
): string {
  return `${config.r2Prefix}/${nodeId}/${incidentId}/${artifactId}.tar.gz`;
}

export interface PendingIncidentInput {
  incidentId: string;
  platformErrorId: string;
  nodeId: string;
  workspaceId: string | null;
}

export async function ensurePendingIncidents(
  env: Env,
  inputs: PendingIncidentInput[]
): Promise<void> {
  const config = resolveDiagnosticIncidentConfig(env);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.retentionDays * 86_400_000).toISOString();
  const deleteAfter = new Date(
    now.getTime() + (config.retentionDays + config.metadataRetentionDays) * 86_400_000
  ).toISOString();
  for (const input of inputs) {
    assertULID(input.incidentId, 'incidentId');
    const existing = await env.DATABASE.prepare(
      'SELECT node_id, platform_error_id FROM diagnostic_incidents WHERE id = ?'
    )
      .bind(input.incidentId)
      .first<{ node_id: string; platform_error_id: string }>();
    if (existing) {
      if (
        existing.node_id !== input.nodeId ||
        existing.platform_error_id !== input.platformErrorId
      ) {
        throw errors.conflict('Incident ID is already bound to another error or node');
      }
      continue;
    }
    await env.DATABASE.prepare(
      `INSERT INTO diagnostic_incidents
       (id, platform_error_id, node_id, workspace_id, status, expires_at, delete_after)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    )
      .bind(
        input.incidentId,
        input.platformErrorId,
        input.nodeId,
        input.workspaceId,
        expiresAt,
        deleteAfter
      )
      .run();
  }
}

export interface RegisterDiagnosticArtifactInput {
  artifactId: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  manifest: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: 'ready' | 'failed';
}

interface ArtifactRow {
  id: string;
  incident_id: string;
  node_id: string;
  kind: string;
  status: DiagnosticIncidentStatus;
  object_key: string;
  content_type: string;
  checksum_sha256: string | null;
  expected_bytes: number;
  actual_bytes: number | null;
  manifest_json: string | null;
  preview_json: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

function validateRegistration(
  config: IncidentConfig,
  incidentId: string,
  input: RegisterDiagnosticArtifactInput
): void {
  assertULID(incidentId, 'incidentId');
  if (input.artifactId !== `${incidentId}-safe`)
    throw errors.badRequest('artifactId is not deterministic');
  if (input.kind !== SAFE_ARTIFACT_KIND) throw errors.badRequest('Unsupported artifact kind');
  if (input.contentType !== SAFE_CONTENT_TYPE) throw errors.badRequest('Unsupported content type');
  if (input.status !== 'ready' && input.status !== 'failed')
    throw errors.badRequest('Invalid artifact status');
  if (encodedBytes(input) > config.registrationMaxBytes)
    throw errors.badRequest('Registration body is too large');
  if (encodedBytes(input.manifest) > config.manifestMaxBytes)
    throw errors.badRequest('Manifest is too large');
  if (encodedBytes(input.preview) > config.previewMaxBytes)
    throw errors.badRequest('Preview is too large');
  if (input.status === 'ready') {
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > config.artifactMaxBytes
    ) {
      throw errors.badRequest('Artifact size is outside the configured bounds');
    }
    if (!SHA256_PATTERN.test(input.checksumSha256))
      throw errors.badRequest('Invalid SHA-256 checksum');
    if (input.manifest.incidentId !== incidentId || input.manifest.version !== 1) {
      throw errors.badRequest('Manifest identity does not match the incident');
    }
  }
}

export async function registerDiagnosticArtifact(
  env: Env,
  nodeId: string,
  incidentId: string,
  input: RegisterDiagnosticArtifactInput
): Promise<{ artifactId: string; status: DiagnosticIncidentStatus }> {
  const config = resolveDiagnosticIncidentConfig(env);
  validateRegistration(config, incidentId, input);
  const incident = await env.DATABASE.prepare(
    'SELECT node_id, expires_at FROM diagnostic_incidents WHERE id = ?'
  )
    .bind(incidentId)
    .first<{ node_id: string; expires_at: string }>();
  if (!incident) throw errors.notFound('Diagnostic incident not found');
  if (incident.node_id !== nodeId) throw errors.forbidden('Incident belongs to another node');

  const existing = await env.DATABASE.prepare(
    `SELECT id, node_id, kind, content_type, checksum_sha256, expected_bytes, status
     FROM diagnostic_artifacts WHERE id = ?`
  )
    .bind(input.artifactId)
    .first<
      Pick<
        ArtifactRow,
        'id' | 'node_id' | 'kind' | 'content_type' | 'checksum_sha256' | 'expected_bytes' | 'status'
      >
    >();
  if (existing) {
    if (
      existing.node_id !== nodeId ||
      existing.kind !== input.kind ||
      existing.content_type !== input.contentType ||
      existing.checksum_sha256 !== (input.status === 'ready' ? input.checksumSha256 : null) ||
      existing.expected_bytes !== (input.status === 'ready' ? input.sizeBytes : 0)
    ) {
      throw errors.conflict('Artifact ID is already registered with different metadata');
    }
    return { artifactId: existing.id, status: existing.status };
  }

  const quota = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(expected_bytes), 0) AS bytes
     FROM diagnostic_artifacts
     WHERE node_id = ? AND status IN ('pending', 'available') AND expires_at > ?`
  )
    .bind(nodeId, new Date().toISOString())
    .first<{ count: number; bytes: number }>();
  const expectedBytes = input.status === 'ready' ? input.sizeBytes : 0;
  if (
    (quota?.count ?? 0) >= config.maxArtifactsPerNode ||
    (quota?.bytes ?? 0) + expectedBytes > config.maxBytesPerNode
  ) {
    throw errors.conflict('Diagnostic artifact quota exceeded');
  }

  const artifactStatus: DiagnosticIncidentStatus = input.status === 'failed' ? 'failed' : 'pending';
  const objectKey = deterministicObjectKey(config, nodeId, incidentId, input.artifactId);
  const manifestJson = JSON.stringify(input.manifest);
  const previewJson = JSON.stringify(input.preview);
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO diagnostic_artifacts
       (id, incident_id, node_id, kind, status, object_key, content_type,
        checksum_sha256, expected_bytes, manifest_json, preview_json, failure_reason, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      input.artifactId,
      incidentId,
      nodeId,
      input.kind,
      artifactStatus,
      objectKey,
      input.contentType,
      input.status === 'ready' ? input.checksumSha256 : null,
      expectedBytes,
      manifestJson,
      previewJson,
      input.status === 'failed' ? 'VM evidence collection failed' : null,
      incident.expires_at
    ),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = ?, artifact_count = 1,
       manifest_json = ?, preview_json = ?, failure_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND node_id = ?`
    ).bind(
      artifactStatus,
      manifestJson,
      previewJson,
      input.status === 'failed' ? 'VM evidence collection failed' : null,
      incidentId,
      nodeId
    ),
  ]);
  return { artifactId: input.artifactId, status: artifactStatus };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Stream(body: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await new Response(body).arrayBuffer();
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function uploadDiagnosticArtifact(
  env: Env,
  nodeId: string,
  incidentId: string,
  artifactId: string,
  request: Request
): Promise<void> {
  assertULID(incidentId, 'incidentId');
  if (artifactId !== `${incidentId}-safe`)
    throw errors.badRequest('artifactId is not deterministic');
  const row = await env.DATABASE.prepare(
    `SELECT id, incident_id, node_id, status, object_key, content_type, checksum_sha256,
     expected_bytes FROM diagnostic_artifacts WHERE id = ?`
  )
    .bind(artifactId)
    .first<
      Pick<
        ArtifactRow,
        | 'id'
        | 'incident_id'
        | 'node_id'
        | 'status'
        | 'object_key'
        | 'content_type'
        | 'checksum_sha256'
        | 'expected_bytes'
      >
    >();
  if (!row || row.incident_id !== incidentId)
    throw errors.notFound('Diagnostic artifact not found');
  if (row.node_id !== nodeId) throw errors.forbidden('Artifact belongs to another node');
  if (row.status === 'available') return;
  if (row.status !== 'pending') throw errors.conflict('Artifact is not accepting content');
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (!Number.isSafeInteger(contentLength) || contentLength !== row.expected_bytes) {
    throw errors.badRequest('Content-Length does not match registration');
  }
  if (request.headers.get('content-type')?.split(';')[0] !== row.content_type) {
    throw errors.badRequest('Content-Type does not match registration');
  }
  if (request.headers.get('x-content-sha256') !== row.checksum_sha256) {
    throw errors.badRequest('Checksum header does not match registration');
  }
  if (!request.body) throw errors.badRequest('Artifact body is required');

  const [uploadBody, digestBody] = request.body.tee();
  let actualChecksum: string;
  try {
    const [, digest] = await Promise.all([
      env.R2.put(row.object_key, uploadBody, {
        httpMetadata: { contentType: row.content_type },
        customMetadata: { incidentId, nodeId, checksumSha256: row.checksum_sha256 ?? '' },
      }),
      sha256Stream(digestBody),
    ]);
    actualChecksum = digest;
  } catch (cause) {
    await env.R2.delete(row.object_key).catch(() => undefined);
    await env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET upload_attempts = upload_attempts + 1,
       failure_reason = 'Upload failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(artifactId)
      .run();
    throw cause;
  }
  if (actualChecksum !== row.checksum_sha256) {
    await env.R2.delete(row.object_key);
    await env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET upload_attempts = upload_attempts + 1,
       failure_reason = 'Checksum mismatch', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(artifactId)
      .run();
    throw errors.badRequest('Artifact checksum mismatch');
  }

  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'available', actual_bytes = expected_bytes,
       upload_attempts = upload_attempts + 1, failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND node_id = ? AND status = 'pending'`
    ).bind(artifactId, nodeId),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'available', total_bytes = ?,
       failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND node_id = ?`
    ).bind(row.expected_bytes, incidentId, nodeId),
  ]);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

interface IncidentRow {
  id: string;
  platform_error_id: string;
  node_id: string;
  workspace_id: string | null;
  status: DiagnosticIncidentStatus;
  artifact_count: number;
  total_bytes: number;
  manifest_json: string | null;
  preview_json: string | null;
  failure_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function artifactSummary(row: ArtifactRow): DiagnosticArtifactSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    contentType: row.content_type,
    sizeBytes: row.actual_bytes,
    checksumSha256: row.checksum_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDiagnosticIncidentsByErrorIds(
  env: Env,
  errorIds: string[]
): Promise<Map<string, DiagnosticIncidentSummary>> {
  const ids = [...new Set(errorIds)].slice(0, 200);
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const incidents = await env.DATABASE.prepare(
    `SELECT id, platform_error_id, node_id, workspace_id, status, artifact_count,
     total_bytes, manifest_json, preview_json, failure_reason, expires_at, created_at, updated_at
     FROM diagnostic_incidents WHERE platform_error_id IN (${placeholders})`
  )
    .bind(...ids)
    .all<IncidentRow>();
  const incidentIds = incidents.results.map((row) => row.id);
  const artifacts = incidentIds.length
    ? await env.DATABASE.prepare(
        `SELECT id, incident_id, node_id, kind, status, object_key, content_type,
         checksum_sha256, expected_bytes, actual_bytes, manifest_json, preview_json,
         failure_reason, created_at, updated_at
         FROM diagnostic_artifacts WHERE incident_id IN (${incidentIds.map(() => '?').join(',')})
         ORDER BY created_at ASC`
      )
        .bind(...incidentIds)
        .all<ArtifactRow>()
    : { results: [] as ArtifactRow[] };
  const byIncident = new Map<string, DiagnosticArtifactSummary[]>();
  for (const artifact of artifacts.results) {
    const current = byIncident.get(artifact.incident_id) ?? [];
    current.push(artifactSummary(artifact));
    byIncident.set(artifact.incident_id, current);
  }
  return new Map(
    incidents.results.map((row) => [
      row.platform_error_id,
      {
        id: row.id,
        platformErrorId: row.platform_error_id,
        nodeId: row.node_id,
        workspaceId: row.workspace_id,
        status: row.status,
        artifactCount: row.artifact_count,
        totalBytes: row.total_bytes,
        manifest: parseJson<DiagnosticIncidentManifest>(row.manifest_json),
        preview: parseJson<Record<string, unknown>>(row.preview_json),
        failureReason: row.failure_reason,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        artifacts: byIncident.get(row.id) ?? [],
      },
    ])
  );
}

export async function getDiagnosticIncidentByErrorId(
  env: Env,
  errorId: string
): Promise<DiagnosticIncidentSummary | null> {
  return (await getDiagnosticIncidentsByErrorIds(env, [errorId])).get(errorId) ?? null;
}

export async function getDiagnosticArtifactForDownload(
  env: Env,
  errorId: string,
  artifactId: string
): Promise<{ row: ArtifactRow; object: R2ObjectBody }> {
  const row = await env.DATABASE.prepare(
    `SELECT a.id, a.incident_id, a.node_id, a.kind, a.status, a.object_key, a.content_type,
     a.checksum_sha256, a.expected_bytes, a.actual_bytes, a.manifest_json, a.preview_json,
     a.failure_reason, a.created_at, a.updated_at
     FROM diagnostic_artifacts a
     JOIN diagnostic_incidents i ON i.id = a.incident_id
     WHERE i.platform_error_id = ? AND a.id = ?`
  )
    .bind(errorId, artifactId)
    .first<ArtifactRow>();
  if (!row || row.status !== 'available')
    throw errors.notFound('Diagnostic artifact is unavailable');
  const object = await env.R2.get(row.object_key);
  if (!object) throw errors.notFound('Diagnostic artifact content is unavailable');
  return { row, object };
}
