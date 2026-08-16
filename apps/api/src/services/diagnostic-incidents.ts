import type {
  DiagnosticArtifactSummary,
  DiagnosticIncidentManifest,
  DiagnosticIncidentStatus,
  DiagnosticIncidentSummary,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import {
  acquireArtifactLease,
  releaseArtifactLease,
  storedObjectMatches,
} from './diagnostic-artifact-lease';
import { type IncidentConfig, resolveDiagnosticIncidentConfig } from './diagnostic-incident-config';
import { redactSensitiveData } from './observability';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ARTIFACT_KIND = 'safe-vm-incident-v1';
const SAFE_CONTENT_TYPE = 'application/gzip';
const textEncoder = new TextEncoder();

// Mirrors DiagnosticIncidentManifest / DiagnosticCollectorOutcome
// (packages/shared/src/types/debug-agent.ts) exactly. The admin UI
// (DiagnosticIncidentCard.tsx) reads `manifest.collectors.length` and maps
// over each collector's name/status/bytes/redactions/truncated/error without
// an array guard — a manifest_json row that doesn't decode to this shape must
// degrade to `null` server-side rather than reach the client and crash on
// `.collectors.length` of `undefined`.
const diagnosticCollectorOutcomeSchema = v.object({
  name: v.string(),
  status: v.picklist(['available', 'failed']),
  bytes: v.number(),
  truncated: v.boolean(),
  redactions: v.number(),
  error: v.optional(v.string()),
});

const diagnosticIncidentManifestSchema = v.object({
  version: v.number(),
  incidentId: v.string(),
  nodeId: v.string(),
  workspaceId: v.optional(v.string()),
  source: v.string(),
  createdAt: v.string(),
  collectors: v.array(diagnosticCollectorOutcomeSchema),
  totalBytes: v.number(),
  redactions: v.number(),
  anyTruncated: v.boolean(),
  unavailable: v.optional(v.boolean()),
});

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
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO diagnostic_incidents
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
    const authoritative = await env.DATABASE.prepare(
      'SELECT node_id, platform_error_id FROM diagnostic_incidents WHERE id = ?'
    )
      .bind(input.incidentId)
      .first<{ node_id: string; platform_error_id: string }>();
    if (
      !authoritative ||
      authoritative.node_id !== input.nodeId ||
      authoritative.platform_error_id !== input.platformErrorId
    ) {
      throw errors.conflict('Incident ID is already bound to another error or node');
    }
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
  const safeInput = {
    ...input,
    manifest: redactSensitiveData(input.manifest),
    preview: redactSensitiveData(input.preview),
  };
  const incident = await env.DATABASE.prepare(
    'SELECT node_id, expires_at FROM diagnostic_incidents WHERE id = ?'
  )
    .bind(incidentId)
    .first<{ node_id: string; expires_at: string }>();
  if (!incident) throw errors.notFound('Diagnostic incident not found');
  if (incident.node_id !== nodeId) throw errors.forbidden('Incident belongs to another node');

  const existing = await env.DATABASE.prepare(
    `SELECT id, node_id, kind, content_type, checksum_sha256, expected_bytes, status, object_key
     FROM diagnostic_artifacts WHERE id = ?`
  )
    .bind(input.artifactId)
    .first<
      Pick<
        ArtifactRow,
        | 'id'
        | 'node_id'
        | 'kind'
        | 'content_type'
        | 'checksum_sha256'
        | 'expected_bytes'
        | 'status'
        | 'object_key'
      >
    >();
  if (existing) {
    if (
      input.status === 'failed' &&
      existing.status === 'pending' &&
      existing.node_id === nodeId &&
      existing.kind === input.kind &&
      existing.content_type === input.contentType
    ) {
      const lease = await acquireArtifactLease(env, existing.id, nodeId, config);
      if (!lease) {
        const winner = await env.DATABASE.prepare(
          'SELECT status FROM diagnostic_artifacts WHERE id = ? AND node_id = ?'
        )
          .bind(existing.id, nodeId)
          .first<{ status: DiagnosticIncidentStatus }>();
        if (winner?.status === 'available' || winner?.status === 'failed') {
          return { artifactId: existing.id, status: winner.status };
        }
        throw errors.internal('Artifact upload is already in progress');
      }
      let recovered: R2Object | null;
      try {
        recovered = await env.R2.head(existing.object_key);
      } catch (cause) {
        await releaseArtifactLease(env, existing.id, lease.id, new Date().toISOString());
        throw cause;
      }
      if (storedObjectMatches(existing.expected_bytes, existing.checksum_sha256, recovered)) {
        const recoveredResults = await env.DATABASE.batch([
          env.DATABASE.prepare(
            `UPDATE diagnostic_artifacts SET status = 'available', actual_bytes = expected_bytes,
             failure_reason = NULL, upload_lease_id = NULL, upload_lease_expires_at = NULL,
             updated_at = ?
             WHERE id = ? AND node_id = ? AND status = 'pending' AND upload_lease_id = ?`
          ).bind(lease.now, existing.id, nodeId, lease.id),
          env.DATABASE.prepare(
            `UPDATE diagnostic_incidents SET status = 'available', total_bytes = ?,
             failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND node_id = ?
               AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                           WHERE id = ? AND incident_id = ? AND status = 'available')`
          ).bind(existing.expected_bytes, incidentId, nodeId, existing.id, incidentId),
        ]);
        if (Number(recoveredResults[0]?.meta?.changes ?? 0) > 0) {
          return { artifactId: existing.id, status: 'available' };
        }
        const winner = await env.DATABASE.prepare(
          'SELECT status FROM diagnostic_artifacts WHERE id = ? AND node_id = ?'
        )
          .bind(existing.id, nodeId)
          .first<{ status: DiagnosticIncidentStatus }>();
        if (winner) return { artifactId: existing.id, status: winner.status };
        throw errors.internal('Artifact state changed during recovery');
      }
      const downgradeResults = await env.DATABASE.batch([
        env.DATABASE.prepare(
          `UPDATE diagnostic_artifacts SET status = 'failed', checksum_sha256 = NULL,
           expected_bytes = 0, actual_bytes = NULL, failure_reason = 'VM evidence collection failed',
           manifest_json = ?, preview_json = ?, upload_lease_id = NULL,
           upload_lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND node_id = ? AND status = 'pending' AND upload_lease_id = ?`
        ).bind(
          JSON.stringify(safeInput.manifest),
          JSON.stringify(safeInput.preview),
          lease.now,
          existing.id,
          nodeId,
          lease.id
        ),
        env.DATABASE.prepare(
          `UPDATE diagnostic_incidents
           SET (status, total_bytes, failure_reason, manifest_json, preview_json, updated_at) =
             (SELECT status, 0, failure_reason, manifest_json, preview_json, CURRENT_TIMESTAMP
              FROM diagnostic_artifacts
              WHERE id = ? AND incident_id = ? AND node_id = ? AND status = 'failed')
           WHERE id = ? AND node_id = ?
             AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                         WHERE id = ? AND incident_id = ? AND node_id = ? AND status = 'failed')`
        ).bind(
          existing.id,
          incidentId,
          nodeId,
          incidentId,
          nodeId,
          existing.id,
          incidentId,
          nodeId
        ),
      ]);
      if (Number(downgradeResults[0]?.meta?.changes ?? 0) > 0) {
        return { artifactId: existing.id, status: 'failed' };
      }
      const winner = await env.DATABASE.prepare(
        'SELECT status FROM diagnostic_artifacts WHERE id = ? AND node_id = ?'
      )
        .bind(existing.id, nodeId)
        .first<{ status: DiagnosticIncidentStatus }>();
      if (winner) return { artifactId: existing.id, status: winner.status };
      throw errors.internal('Artifact state changed during failed registration');
    }
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

  const expectedBytes = safeInput.status === 'ready' ? safeInput.sizeBytes : 0;

  const artifactStatus: DiagnosticIncidentStatus =
    safeInput.status === 'failed' ? 'failed' : 'pending';
  const objectKey = deterministicObjectKey(config, nodeId, incidentId, safeInput.artifactId);
  const manifestJson = JSON.stringify(safeInput.manifest);
  const previewJson = JSON.stringify(safeInput.preview);
  const quotaNow = new Date().toISOString();
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT OR IGNORE INTO diagnostic_artifacts
       (id, incident_id, node_id, kind, status, object_key, content_type,
        checksum_sha256, expected_bytes, manifest_json, preview_json, failure_reason, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM diagnostic_artifacts
              WHERE node_id = ? AND status IN ('pending', 'available') AND expires_at > ?) < ?
         AND (SELECT COALESCE(SUM(expected_bytes), 0) FROM diagnostic_artifacts
              WHERE node_id = ? AND status IN ('pending', 'available') AND expires_at > ?) + ? <= ?`
    ).bind(
      safeInput.artifactId,
      incidentId,
      nodeId,
      safeInput.kind,
      artifactStatus,
      objectKey,
      safeInput.contentType,
      safeInput.status === 'ready' ? safeInput.checksumSha256 : null,
      expectedBytes,
      manifestJson,
      previewJson,
      safeInput.status === 'failed' ? 'VM evidence collection failed' : null,
      incident.expires_at,
      nodeId,
      quotaNow,
      config.maxArtifactsPerNode,
      nodeId,
      quotaNow,
      expectedBytes,
      config.maxBytesPerNode
    ),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents
       SET (status, artifact_count, manifest_json, preview_json, failure_reason, updated_at) =
         (SELECT status, 1, manifest_json, preview_json, failure_reason, CURRENT_TIMESTAMP
          FROM diagnostic_artifacts
          WHERE id = ? AND incident_id = ? AND node_id = ? AND kind = ?
            AND content_type = ? AND checksum_sha256 IS ? AND expected_bytes = ?)
       WHERE id = ? AND node_id = ?
         AND EXISTS (
           SELECT 1 FROM diagnostic_artifacts
           WHERE id = ? AND incident_id = ? AND node_id = ? AND kind = ?
             AND content_type = ? AND checksum_sha256 IS ? AND expected_bytes = ?
         )`
    ).bind(
      safeInput.artifactId,
      incidentId,
      nodeId,
      safeInput.kind,
      safeInput.contentType,
      safeInput.status === 'ready' ? safeInput.checksumSha256 : null,
      expectedBytes,
      incidentId,
      nodeId,
      safeInput.artifactId,
      incidentId,
      nodeId,
      safeInput.kind,
      safeInput.contentType,
      safeInput.status === 'ready' ? safeInput.checksumSha256 : null,
      expectedBytes
    ),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    const concurrent = await env.DATABASE.prepare(
      `SELECT id, node_id, kind, content_type, checksum_sha256, expected_bytes, status
       FROM diagnostic_artifacts WHERE id = ?`
    )
      .bind(safeInput.artifactId)
      .first<
        Pick<
          ArtifactRow,
          | 'id'
          | 'node_id'
          | 'kind'
          | 'content_type'
          | 'checksum_sha256'
          | 'expected_bytes'
          | 'status'
        >
      >();
    if (
      concurrent?.node_id === nodeId &&
      concurrent.kind === safeInput.kind &&
      concurrent.content_type === safeInput.contentType &&
      concurrent.checksum_sha256 ===
        (safeInput.status === 'ready' ? safeInput.checksumSha256 : null) &&
      concurrent.expected_bytes === expectedBytes
    ) {
      return { artifactId: concurrent.id, status: concurrent.status };
    }
    throw errors.conflict('Diagnostic artifact quota exceeded');
  }
  return { artifactId: safeInput.artifactId, status: artifactStatus };
}

function exactLengthStream(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number
): { readable: ReadableStream<Uint8Array>; completion: Promise<void> } {
  if (typeof FixedLengthStream !== 'undefined') {
    const fixed = new FixedLengthStream(expectedBytes);
    return {
      readable: fixed.readable,
      completion: body.pipeTo(fixed.writable),
    };
  }
  let actualBytes = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      actualBytes += chunk.byteLength;
      if (actualBytes > expectedBytes) {
        throw errors.badRequest('Artifact body exceeds registered size');
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (actualBytes !== expectedBytes) {
        throw errors.badRequest('Artifact body does not match registered size');
      }
    },
  });
  return { readable: transform.readable, completion: body.pipeTo(transform.writable) };
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
  const config = resolveDiagnosticIncidentConfig(env);
  const lease = await acquireArtifactLease(env, artifactId, nodeId, config);
  if (!lease) {
    const winner = await env.DATABASE.prepare(
      'SELECT status FROM diagnostic_artifacts WHERE id = ? AND node_id = ?'
    )
      .bind(artifactId, nodeId)
      .first<{ status: DiagnosticIncidentStatus }>();
    if (winner?.status === 'available') return;
    throw errors.internal('Artifact upload is already in progress');
  }

  try {
    const bounded = exactLengthStream(request.body, row.expected_bytes);
    await Promise.all([
      env.R2.put(row.object_key, bounded.readable, {
        httpMetadata: { contentType: row.content_type },
        customMetadata: { incidentId, nodeId },
        sha256: row.checksum_sha256 ?? undefined,
      }),
      bounded.completion,
    ]);
  } catch (cause) {
    const recovered = await env.R2.head(row.object_key).catch(() => null);
    if (!storedObjectMatches(row.expected_bytes, row.checksum_sha256, recovered)) {
      await env.DATABASE.prepare(
        `UPDATE diagnostic_artifacts SET upload_attempts = upload_attempts + 1,
         failure_reason = 'Upload failed', upload_lease_id = NULL,
         upload_lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending' AND upload_lease_id = ?`
      )
        .bind(new Date().toISOString(), artifactId, lease.id)
        .run();
      throw cause;
    }
  }

  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'available', actual_bytes = expected_bytes,
       upload_attempts = upload_attempts + 1, failure_reason = NULL,
       upload_lease_id = NULL, upload_lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND node_id = ? AND status = 'pending' AND upload_lease_id = ?`
    ).bind(lease.now, artifactId, nodeId, lease.id),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'available', total_bytes = ?,
       failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND node_id = ?
         AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                     WHERE id = ? AND incident_id = ? AND status = 'available')`
    ).bind(row.expected_bytes, incidentId, nodeId, artifactId, incidentId),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    const winner = await env.DATABASE.prepare(
      'SELECT status FROM diagnostic_artifacts WHERE id = ? AND node_id = ?'
    )
      .bind(artifactId, nodeId)
      .first<{ status: DiagnosticIncidentStatus }>();
    if (winner?.status === 'available') return;
    throw errors.internal('Artifact state changed while content was uploading');
  }
}

/** Parses a D1 text column to `unknown`. Never throws — malformed JSON degrades to `null`. */
function parseJsonColumn(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Validates a parsed manifest_json value against the shape the admin UI
 * relies on. A row that doesn't decode to a well-formed manifest degrades to
 * `null` (and is logged) instead of reaching callers with a blindly-cast,
 * possibly-missing `collectors` array.
 */
function parseDiagnosticManifest(
  value: string | null,
  incidentId: string
): DiagnosticIncidentManifest | null {
  const parsed = parseJsonColumn(value);
  if (parsed === null) return null;
  const result = v.safeParse(diagnosticIncidentManifestSchema, parsed);
  if (!result.success) {
    log.warn('diagnostic_incidents.manifest_parse_skipped', { incidentId });
    return null;
  }
  return result.output;
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

async function summarizeIncidentRows(
  env: Env,
  incidentRows: IncidentRow[]
): Promise<DiagnosticIncidentSummary[]> {
  const incidentIds = incidentRows.map((row) => row.id);
  const artifactRows: ArtifactRow[] = [];
  for (let offset = 0; offset < incidentIds.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const chunk = incidentIds.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    const artifacts = await env.DATABASE.prepare(
      `SELECT id, incident_id, node_id, kind, status, object_key, content_type,
         checksum_sha256, expected_bytes, actual_bytes, manifest_json, preview_json,
         failure_reason, created_at, updated_at
         FROM diagnostic_artifacts WHERE incident_id IN (${chunk.map(() => '?').join(',')})
         ORDER BY created_at ASC`
    )
      .bind(...chunk)
      .all<ArtifactRow>();
    artifactRows.push(...artifacts.results);
  }
  const byIncident = new Map<string, DiagnosticArtifactSummary[]>();
  for (const artifact of artifactRows) {
    const current = byIncident.get(artifact.incident_id) ?? [];
    current.push(artifactSummary(artifact));
    byIncident.set(artifact.incident_id, current);
  }
  return incidentRows.map((row) => ({
    id: row.id,
    platformErrorId: row.platform_error_id,
    nodeId: row.node_id,
    workspaceId: row.workspace_id,
    status: row.status,
    artifactCount: row.artifact_count,
    totalBytes: row.total_bytes,
    manifest: parseDiagnosticManifest(row.manifest_json, row.id),
    preview: maybeJsonRecord(parseJsonColumn(row.preview_json)),
    failureReason: row.failure_reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    artifacts: byIncident.get(row.id) ?? [],
  }));
}

export async function getDiagnosticIncidentsByErrorIds(
  env: Env,
  errorIds: string[]
): Promise<Map<string, DiagnosticIncidentSummary>> {
  const ids = [...new Set(errorIds)].slice(0, 200);
  if (ids.length === 0) return new Map();
  const incidentRows: IncidentRow[] = [];
  for (let offset = 0; offset < ids.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const chunk = ids.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    const incidents = await env.DATABASE.prepare(
      `SELECT id, platform_error_id, node_id, workspace_id, status, artifact_count,
       total_bytes, manifest_json, preview_json, failure_reason, expires_at, created_at, updated_at
       FROM diagnostic_incidents WHERE platform_error_id IN (${chunk.map(() => '?').join(',')})`
    )
      .bind(...chunk)
      .all<IncidentRow>();
    incidentRows.push(...incidents.results);
  }
  const summaries = await summarizeIncidentRows(env, incidentRows);
  return new Map(summaries.map((summary) => [summary.platformErrorId, summary]));
}

/** List recent incident evidence by node without requiring the node row to still exist. */
export async function getDiagnosticIncidentsByNodeId(
  env: Env,
  nodeId: string,
  limit: number
): Promise<DiagnosticIncidentSummary[]> {
  const incidents = await env.DATABASE.prepare(
    `SELECT id, platform_error_id, node_id, workspace_id, status, artifact_count,
       total_bytes, manifest_json, preview_json, failure_reason, expires_at, created_at, updated_at
       FROM diagnostic_incidents
       WHERE node_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
  )
    .bind(nodeId, limit)
    .all<IncidentRow>();
  return summarizeIncidentRows(env, incidents.results);
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
