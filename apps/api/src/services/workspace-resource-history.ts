// FILE SIZE EXCEPTION: cohesive resource-history storage/read service; split after first production hardening pass when the chunk codecs and D1/R2 repository boundaries settle.
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { parseJsonRecord } from '../lib/runtime-validation';
import { AppError, errors } from '../middleware/error';

export const WORKSPACE_RESOURCE_STORAGE_FORMAT = 'resource-history-gzip-json-v1';
const R2_PREFIX = 'resource-history/v1';
const DEFAULT_RAW_RETENTION_DAYS = 90;
const DEFAULT_SUMMARY_RETENTION_DAYS = 180;
const DEFAULT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_UNCOMPRESSED_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_METADATA_MAX_BYTES = 8 * 1024;
const DEFAULT_DETAIL_MAX_POINTS = 720;
const DEFAULT_LIST_LIMIT = 24;
const DEFAULT_CLEANUP_BATCH_SIZE = 50;
const DEFAULT_OBJECT_CLEANUP_LIMIT = 5000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WorkspaceResourceUploadBody {
  workspaceId: string;
  nodeId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  agentProfileId?: string | null;
  skillId?: string | null;
  agentType?: string | null;
  runtime?: string | null;
  sourceVersion: number;
  chunkSequence: number;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  gapCount?: number;
  toolSpanCount?: number;
  compressedBase64: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  storageFormat?: string;
  completeness: Record<string, unknown>;
  summary: WorkspaceResourceSummaryPayload;
}

export interface WorkspaceResourceSummaryPayload {
  cpuMeanMillis?: number | null;
  cpuPeakMillis?: number | null;
  memoryMeanBytes?: number | null;
  memoryPeakBytes?: number | null;
  memoryKernelPeakBytes?: number | null;
  ioReadBytes?: number | null;
  ioWriteBytes?: number | null;
  oomCount?: number | null;
  [key: string]: unknown;
}

export interface WorkspaceResourceChunkPayload {
  samples?: ResourceSamplePoint[];
  toolSpans?: ResourceToolSpan[];
  gaps?: Array<Record<string, unknown>>;
  notes?: string[];
  [key: string]: unknown;
}

export interface ResourceSamplePoint {
  t: number;
  cpuMillis?: number;
  memoryBytes?: number;
  memoryPeakBytes?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  oom?: number;
  gap?: boolean;
  [key: string]: unknown;
}

export interface ResourceToolSpan {
  id?: string;
  toolCallId?: string;
  kind?: string;
  toolName?: string;
  startedAt: number;
  endedAt?: number;
  concurrency?: number;
  sampleCount?: number;
  [key: string]: unknown;
}

export interface WorkspaceResourceHistoryResponse {
  summary: PublicWorkspaceResourceSummary | null;
  chunks: PublicWorkspaceResourceChunk[];
  detail?: {
    chunkId: string;
    samples: ResourceSamplePoint[];
    toolSpans: ResourceToolSpan[];
    gaps: Array<Record<string, unknown>>;
    originalSampleCount: number;
    downsampled: boolean;
    downsampleLimit: number;
  };
}

export interface PublicWorkspaceResourceSummary {
  id: string;
  projectId: string;
  workspaceId: string;
  sessionId: string | null;
  taskId: string | null;
  nodeId: string | null;
  agentProfileId: string | null;
  skillId: string | null;
  agentType: string | null;
  runtime: string;
  sourceVersion: number;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  gapCount: number;
  toolSpanCount: number;
  cpuMeanMillis: number | null;
  cpuPeakMillis: number | null;
  memoryMeanBytes: number | null;
  memoryPeakBytes: number | null;
  memoryKernelPeakBytes: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
  oomCount: number;
  completeness: unknown;
  summary: unknown;
  firstChunkId: string | null;
  latestChunkId: string | null;
}

export interface PublicWorkspaceResourceChunk {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  taskId: string | null;
  nodeId: string | null;
  chunkSequence: number;
  sourceVersion: number;
  storageFormat: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  gapCount: number;
  toolSpanCount: number;
  completeness: unknown;
  summary: unknown;
  expiresAt: number;
}

export interface WorkspaceResourceCleanupStats {
  expiredChunksSelected: number;
  expiredChunksDeleted: number;
  expiredChunkDeleteErrors: number;
  summariesSelected: number;
  summariesDeleted: number;
}

export function getWorkspaceResourceUploadMaxBytes(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_RESOURCE_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES);
}

function uncompressedMaxBytes(env: Env): number {
  return parsePositiveInt(
    env.WORKSPACE_RESOURCE_UNCOMPRESSED_MAX_BYTES,
    DEFAULT_UNCOMPRESSED_MAX_BYTES
  );
}

function metadataMaxBytes(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_RESOURCE_METADATA_MAX_BYTES, DEFAULT_METADATA_MAX_BYTES);
}

function retentionDays(env: Env, key: 'raw' | 'summary'): number {
  return key === 'raw'
    ? parsePositiveInt(env.WORKSPACE_RESOURCE_RAW_RETENTION_DAYS, DEFAULT_RAW_RETENTION_DAYS)
    : parsePositiveInt(
        env.WORKSPACE_RESOURCE_SUMMARY_RETENTION_DAYS,
        DEFAULT_SUMMARY_RETENTION_DAYS
      );
}

function readLimit(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_RESOURCE_LIST_LIMIT, DEFAULT_LIST_LIMIT);
}

function detailMaxPoints(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_RESOURCE_DETAIL_MAX_POINTS, DEFAULT_DETAIL_MAX_POINTS);
}

function cleanupBatchSize(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_RESOURCE_CLEANUP_BATCH_SIZE, DEFAULT_CLEANUP_BATCH_SIZE);
}

function objectCleanupLimit(env: Env): number {
  return parsePositiveInt(
    env.WORKSPACE_RESOURCE_OBJECT_CLEANUP_LIMIT,
    DEFAULT_OBJECT_CLEANUP_LIMIT
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedJsonStringify(value: unknown, field: string, maxBytes: number): string {
  const json = JSON.stringify(value ?? {});
  if (utf8ByteLength(json) > maxBytes) {
    throw errors.badRequest(`${field} exceeds configured metadata byte limit`);
  }
  return json;
}

function jsonParseOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function assertFiniteInteger(value: number, field: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw errors.badRequest(`${field} must be a safe integer >= ${min}`);
  }
}

function assertFiniteMetric(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw errors.badRequest(`${field} must be a finite non-negative number`);
  }
  return value;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
    return bytes;
  } catch {
    throw errors.badRequest('compressedBase64 must be valid base64');
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
async function readBoundedGzipJson(
  bytes: Uint8Array,
  maxBytes: number
): Promise<{ value: WorkspaceResourceChunkPayload; byteLength: number }> {
  let total = 0;
  const chunks: Uint8Array[] = [];
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw errors.badRequest('Resource history chunk exceeds configured uncompressed limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw errors.badRequest('Resource history chunk must contain gzip-compressed JSON');
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const record = parseJsonRecord(
      new TextDecoder().decode(merged),
      'workspace_resource_history.chunk'
    );
    return {
      value: normalizeChunkPayload(record),
      byteLength: total,
    };
  } catch {
    throw errors.badRequest('Resource history chunk must contain gzip-compressed JSON');
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResourceSamplePoint(value: unknown): value is ResourceSamplePoint {
  if (!isJsonObject(value)) return false;
  return typeof value.t === 'number' && Number.isFinite(value.t);
}

function isResourceToolSpan(value: unknown): value is ResourceToolSpan {
  if (!isJsonObject(value)) return false;
  return typeof value.startedAt === 'number' && Number.isFinite(value.startedAt);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeChunkPayload(record: Record<string, unknown>): WorkspaceResourceChunkPayload {
  const payload: WorkspaceResourceChunkPayload = { ...record };
  payload.samples = Array.isArray(record.samples)
    ? record.samples.filter(isResourceSamplePoint)
    : undefined;
  payload.toolSpans = Array.isArray(record.toolSpans)
    ? record.toolSpans.filter(isResourceToolSpan)
    : undefined;
  payload.gaps = Array.isArray(record.gaps) ? record.gaps.filter(isJsonObject) : undefined;
  payload.notes = stringArray(record.notes);
  return payload;
}

function resourceScopeKey(input: { sessionId?: string | null; taskId?: string | null }): string {
  const sessionId = normalizeNullable(input.sessionId);
  if (sessionId) return `session/${encodeURIComponent(sessionId)}`;

  const taskId = normalizeNullable(input.taskId);
  if (taskId) return `task/${encodeURIComponent(taskId)}`;

  return 'workspace';
}

function buildR2Key(input: {
  projectId: string;
  workspaceId: string;
  scopeKey: string;
  sourceVersion: number;
  chunkSequence: number;
}): string {
  return `${R2_PREFIX}/projects/${input.projectId}/workspaces/${input.workspaceId}/${input.scopeKey}/v${input.sourceVersion}/${input.chunkSequence}.json.gz`;
}

function summaryIdFor(input: {
  projectId: string;
  workspaceId: string;
  sessionId?: string | null;
  taskId?: string | null;
}): string {
  const sessionId = normalizeNullable(input.sessionId);
  if (sessionId) return `workspace:${input.projectId}:${input.workspaceId}:session:${sessionId}`;

  const taskId = normalizeNullable(input.taskId);
  if (taskId) return `workspace:${input.projectId}:${input.workspaceId}:task:${taskId}`;

  return `workspace:${input.projectId}:${input.workspaceId}:workspace`;
}

interface WorkspaceUploadRow {
  id: string;
  project_id: string | null;
  node_id: string | null;
  chat_session_id: string | null;
  agent_profile_hint: string | null;
}

async function loadWorkspaceForUpload(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<WorkspaceUploadRow> {
  const row = await env.DATABASE.prepare(
    `SELECT id, project_id, node_id, chat_session_id, agent_profile_hint
       FROM workspaces
      WHERE id = ? AND project_id = ?
      LIMIT 1`
  )
    .bind(workspaceId, projectId)
    .first<WorkspaceUploadRow>();
  if (!row) {
    throw errors.notFound('Workspace');
  }
  if (row.id !== workspaceId || row.project_id !== projectId) {
    throw errors.notFound('Workspace');
  }
  return row;
}

function validateWorkspaceUploadIdentity(
  workspace: WorkspaceUploadRow,
  body: WorkspaceResourceUploadBody,
  uploadedByNodeId: string | null
): string | null {
  const requestedNodeId = normalizeNullable(body.nodeId);
  const nodeId = requestedNodeId ?? workspace.node_id;
  if (requestedNodeId && requestedNodeId !== workspace.node_id) {
    throw errors.forbidden('Node identity does not match workspace');
  }
  if (uploadedByNodeId && nodeId && uploadedByNodeId !== nodeId) {
    throw errors.forbidden('Callback token is not authorized for this workspace node');
  }

  const requestedSessionId = normalizeNullable(body.sessionId);
  if (
    requestedSessionId &&
    workspace.chat_session_id &&
    requestedSessionId !== workspace.chat_session_id
  ) {
    throw errors.forbidden('Session identity does not match workspace');
  }

  return nodeId;
}

function assertWorkspaceResourceUploadMetadata(body: WorkspaceResourceUploadBody): void {
  assertFiniteInteger(body.sourceVersion, 'sourceVersion', 1);
  assertFiniteInteger(body.chunkSequence, 'chunkSequence', 0);
  assertFiniteInteger(body.startedAt, 'startedAt', 1);
  assertFiniteInteger(body.endedAt, 'endedAt', body.startedAt);
  assertFiniteInteger(body.sampleCount, 'sampleCount', 0);
  assertFiniteInteger(body.gapCount ?? 0, 'gapCount', 0);
  assertFiniteInteger(body.toolSpanCount ?? 0, 'toolSpanCount', 0);
  assertFiniteInteger(body.compressedBytes, 'compressedBytes', 1);
  assertFiniteInteger(body.uncompressedBytes, 'uncompressedBytes', 1);
  if (
    (body.storageFormat ?? WORKSPACE_RESOURCE_STORAGE_FORMAT) !== WORKSPACE_RESOURCE_STORAGE_FORMAT
  ) {
    throw errors.badRequest(`storageFormat must be ${WORKSPACE_RESOURCE_STORAGE_FORMAT}`);
  }
}

async function validateWorkspaceResourceChunkBytes(
  env: Env,
  body: WorkspaceResourceUploadBody
): Promise<{ bytes: Uint8Array; actualSha: string }> {
  const bytes = decodeBase64(body.compressedBase64);
  if (bytes.byteLength !== body.compressedBytes) {
    throw errors.badRequest('compressedBytes does not match decoded payload size');
  }
  if (bytes.byteLength > getWorkspaceResourceUploadMaxBytes(env)) {
    throw errors.badRequest('Resource history chunk exceeds configured upload limit');
  }

  const actualSha = await sha256Hex(bytes);
  if (actualSha !== body.sha256.toLowerCase()) {
    throw errors.badRequest('Resource history chunk checksum mismatch');
  }
  if (body.uncompressedBytes > uncompressedMaxBytes(env)) {
    throw errors.badRequest('Resource history chunk exceeds configured uncompressed limit');
  }

  const decodedChunk = await readBoundedGzipJson(bytes, uncompressedMaxBytes(env));
  if (decodedChunk.byteLength !== body.uncompressedBytes) {
    throw errors.badRequest('uncompressedBytes does not match decoded payload size');
  }

  return { bytes, actualSha };
}

export async function storeWorkspaceResourceChunk(
  env: Env,
  projectId: string,
  body: WorkspaceResourceUploadBody,
  uploadedByNodeId: string | null
): Promise<{ summaryId: string; chunkId: string; idempotent: boolean }> {
  const workspaceId = body.workspaceId.trim();
  if (!workspaceId) throw errors.badRequest('workspaceId is required');

  const workspace = await loadWorkspaceForUpload(env, projectId, workspaceId);
  const nodeId = validateWorkspaceUploadIdentity(workspace, body, uploadedByNodeId);
  assertWorkspaceResourceUploadMetadata(body);
  const { bytes, actualSha } = await validateWorkspaceResourceChunkBytes(env, body);

  const db = drizzle(env.DATABASE, { schema });
  const now = Date.now();
  const expiresAt = now + retentionDays(env, 'raw') * MS_PER_DAY;
  const sessionId = normalizeNullable(body.sessionId) ?? workspace.chat_session_id;
  const taskId = normalizeNullable(body.taskId);
  const scopeKey = resourceScopeKey({ sessionId, taskId });
  const summaryId = summaryIdFor({ projectId, workspaceId, sessionId, taskId });
  const chunkScope = scopeKey.replaceAll('/', ':');
  const chunkId = `wrchunk:${projectId}:${workspaceId}:${chunkScope}:${body.sourceVersion}:${body.chunkSequence}`;
  const r2Key = buildR2Key({
    projectId,
    workspaceId,
    scopeKey,
    sourceVersion: body.sourceVersion,
    chunkSequence: body.chunkSequence,
  });
  const existing = await db
    .select({
      id: schema.workspaceResourceChunks.id,
      sha256: schema.workspaceResourceChunks.sha256,
      summaryId: schema.workspaceResourceChunks.summaryId,
    })
    .from(schema.workspaceResourceChunks)
    .where(eq(schema.workspaceResourceChunks.id, chunkId))
    .get();
  if (existing) {
    if (existing.sha256 !== actualSha) {
      throw errors.conflict(
        'Resource history chunk identity already exists with a different checksum'
      );
    }
    return {
      summaryId: existing.summaryId ?? summaryId,
      chunkId: existing.id,
      idempotent: true,
    };
  }

  await env.PROJECT_DATA_ARCHIVE_R2.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: {
      projectId,
      workspaceId,
      sha256: actualSha,
      storageFormat: WORKSPACE_RESOURCE_STORAGE_FORMAT,
    },
  });

  let r2ObjectIndexed = false;
  try {
    const maxMetadataBytes = metadataMaxBytes(env);
    const completenessJson = boundedJsonStringify(
      body.completeness ?? {},
      'completeness',
      maxMetadataBytes
    );
    const summaryJson = boundedJsonStringify(body.summary ?? {}, 'summary', maxMetadataBytes);
    const agentProfileId = normalizeNullable(body.agentProfileId) ?? workspace.agent_profile_hint;
    const skillId = normalizeNullable(body.skillId);
    const agentType = normalizeNullable(body.agentType);
    const runtime = normalizeNullable(body.runtime) ?? 'vm';
    const values = {
      id: summaryId,
      projectId,
      workspaceId,
      sessionId,
      taskId,
      nodeId,
      agentProfileId,
      skillId,
      agentType,
      runtime,
      sourceVersion: body.sourceVersion,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      sampleCount: body.sampleCount,
      gapCount: body.gapCount ?? 0,
      cpuMeanMillis: assertFiniteMetric(body.summary.cpuMeanMillis, 'summary.cpuMeanMillis'),
      cpuPeakMillis: assertFiniteMetric(body.summary.cpuPeakMillis, 'summary.cpuPeakMillis'),
      memoryMeanBytes: assertFiniteMetric(body.summary.memoryMeanBytes, 'summary.memoryMeanBytes'),
      memoryPeakBytes: assertFiniteMetric(body.summary.memoryPeakBytes, 'summary.memoryPeakBytes'),
      memoryKernelPeakBytes: assertFiniteMetric(
        body.summary.memoryKernelPeakBytes,
        'summary.memoryKernelPeakBytes'
      ),
      ioReadBytes: assertFiniteMetric(body.summary.ioReadBytes, 'summary.ioReadBytes'),
      ioWriteBytes: assertFiniteMetric(body.summary.ioWriteBytes, 'summary.ioWriteBytes'),
      oomCount: Math.trunc(assertFiniteMetric(body.summary.oomCount, 'summary.oomCount') ?? 0),
      toolSpanCount: body.toolSpanCount ?? 0,
      completenessJson,
      summaryJson,
      firstChunkId: chunkId,
      latestChunkId: chunkId,
      createdAt: now,
      updatedAt: now,
    };

    await db
      .insert(schema.workspaceResourceSummaries)
      .values(values)
      .onConflictDoUpdate({
        target: schema.workspaceResourceSummaries.id,
        set: {
          sessionId,
          taskId,
          nodeId,
          agentProfileId,
          skillId,
          agentType,
          runtime,
          sourceVersion: body.sourceVersion,
          startedAt: sql`MIN(${schema.workspaceResourceSummaries.startedAt}, ${body.startedAt})`,
          endedAt: body.endedAt,
          sampleCount: sql`${schema.workspaceResourceSummaries.sampleCount} + ${body.sampleCount}`,
          gapCount: sql`${schema.workspaceResourceSummaries.gapCount} + ${body.gapCount ?? 0}`,
          cpuMeanMillis:
            values.cpuMeanMillis == null
              ? schema.workspaceResourceSummaries.cpuMeanMillis
              : sql`CASE
                WHEN ${schema.workspaceResourceSummaries.cpuMeanMillis} IS NULL THEN ${values.cpuMeanMillis}
                ELSE (
                  (${schema.workspaceResourceSummaries.cpuMeanMillis} * ${schema.workspaceResourceSummaries.sampleCount}) +
                  (${values.cpuMeanMillis} * ${body.sampleCount})
                ) / (${schema.workspaceResourceSummaries.sampleCount} + ${body.sampleCount})
              END`,
          cpuPeakMillis: sql`MAX(COALESCE(${schema.workspaceResourceSummaries.cpuPeakMillis}, 0), ${values.cpuPeakMillis ?? 0})`,
          memoryMeanBytes:
            values.memoryMeanBytes == null
              ? schema.workspaceResourceSummaries.memoryMeanBytes
              : sql`CASE
                WHEN ${schema.workspaceResourceSummaries.memoryMeanBytes} IS NULL THEN ${values.memoryMeanBytes}
                ELSE CAST((
                  (${schema.workspaceResourceSummaries.memoryMeanBytes} * ${schema.workspaceResourceSummaries.sampleCount}) +
                  (${values.memoryMeanBytes} * ${body.sampleCount})
                ) / (${schema.workspaceResourceSummaries.sampleCount} + ${body.sampleCount}) AS INTEGER)
              END`,
          memoryPeakBytes: sql`MAX(COALESCE(${schema.workspaceResourceSummaries.memoryPeakBytes}, 0), ${values.memoryPeakBytes ?? 0})`,
          memoryKernelPeakBytes: sql`MAX(COALESCE(${schema.workspaceResourceSummaries.memoryKernelPeakBytes}, 0), ${values.memoryKernelPeakBytes ?? 0})`,
          ioReadBytes: sql`COALESCE(${schema.workspaceResourceSummaries.ioReadBytes}, 0) + ${values.ioReadBytes ?? 0}`,
          ioWriteBytes: sql`COALESCE(${schema.workspaceResourceSummaries.ioWriteBytes}, 0) + ${values.ioWriteBytes ?? 0}`,
          oomCount: sql`${schema.workspaceResourceSummaries.oomCount} + ${values.oomCount}`,
          toolSpanCount: sql`${schema.workspaceResourceSummaries.toolSpanCount} + ${body.toolSpanCount ?? 0}`,
          completenessJson,
          summaryJson,
          latestChunkId: chunkId,
          updatedAt: now,
        },
      });

    await db.insert(schema.workspaceResourceChunks).values({
      id: chunkId,
      projectId,
      workspaceId,
      summaryId,
      sessionId,
      taskId,
      nodeId,
      chunkSequence: body.chunkSequence,
      sourceVersion: body.sourceVersion,
      r2Key,
      storageFormat: WORKSPACE_RESOURCE_STORAGE_FORMAT,
      compressedBytes: body.compressedBytes,
      uncompressedBytes: body.uncompressedBytes,
      sha256: actualSha,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      sampleCount: body.sampleCount,
      gapCount: body.gapCount ?? 0,
      toolSpanCount: body.toolSpanCount ?? 0,
      completenessJson,
      summaryJson,
      createdAt: now,
      expiresAt,
      uploadedByNodeId,
    });

    r2ObjectIndexed = true;
    return { summaryId, chunkId, idempotent: false };
  } finally {
    if (!r2ObjectIndexed) {
      try {
        await env.PROJECT_DATA_ARCHIVE_R2.delete(r2Key);
      } catch (deleteError) {
        log.warn('workspace_resource_history.orphan_cleanup_failed', {
          projectId,
          workspaceId,
          r2Key,
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
        });
      }
    }
  }
}

function publicSummary(row: schema.WorkspaceResourceSummaryRow): PublicWorkspaceResourceSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    taskId: row.taskId,
    nodeId: row.nodeId,
    agentProfileId: row.agentProfileId,
    skillId: row.skillId,
    agentType: row.agentType,
    runtime: row.runtime,
    sourceVersion: row.sourceVersion,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    sampleCount: row.sampleCount,
    gapCount: row.gapCount,
    toolSpanCount: row.toolSpanCount,
    cpuMeanMillis: row.cpuMeanMillis,
    cpuPeakMillis: row.cpuPeakMillis,
    memoryMeanBytes: row.memoryMeanBytes,
    memoryPeakBytes: row.memoryPeakBytes,
    memoryKernelPeakBytes: row.memoryKernelPeakBytes,
    ioReadBytes: row.ioReadBytes,
    ioWriteBytes: row.ioWriteBytes,
    oomCount: row.oomCount,
    completeness: jsonParseOrNull(row.completenessJson),
    summary: jsonParseOrNull(row.summaryJson),
    firstChunkId: row.firstChunkId,
    latestChunkId: row.latestChunkId,
  };
}

function publicChunk(row: schema.WorkspaceResourceChunkRow): PublicWorkspaceResourceChunk {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    taskId: row.taskId,
    nodeId: row.nodeId,
    chunkSequence: row.chunkSequence,
    sourceVersion: row.sourceVersion,
    storageFormat: row.storageFormat,
    compressedBytes: row.compressedBytes,
    uncompressedBytes: row.uncompressedBytes,
    sha256: row.sha256,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    sampleCount: row.sampleCount,
    gapCount: row.gapCount,
    toolSpanCount: row.toolSpanCount,
    completeness: jsonParseOrNull(row.completenessJson),
    summary: jsonParseOrNull(row.summaryJson),
    expiresAt: row.expiresAt,
  };
}

function sampleScore(sample: ResourceSamplePoint): number {
  return Math.max(
    Number(sample.cpuMillis ?? 0),
    Number(sample.memoryBytes ?? 0) / (1024 * 1024),
    Number(sample.memoryPeakBytes ?? 0) / (1024 * 1024),
    sample.gap ? Number.MAX_SAFE_INTEGER : 0
  );
}

export function downsamplePreservingSpikes(
  samples: ResourceSamplePoint[],
  maxPoints: number
): { samples: ResourceSamplePoint[]; downsampled: boolean } {
  if (samples.length <= maxPoints) return { samples, downsampled: false };
  if (maxPoints < 3) return { samples: samples.slice(0, maxPoints), downsampled: true };
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return { samples: [], downsampled: false };
  const buckets = maxPoints - 2;
  const middle = samples.slice(1, -1);
  const bucketSize = Math.ceil(middle.length / buckets);
  const selected: ResourceSamplePoint[] = [first];
  for (let i = 0; i < middle.length; i += bucketSize) {
    const bucket = middle.slice(i, i + bucketSize);
    const bucketFirst = bucket[0];
    if (!bucketFirst) continue;
    selected.push(
      bucket.reduce(
        (best, sample) => (sampleScore(sample) > sampleScore(best) ? sample : best),
        bucketFirst
      )
    );
  }
  selected.push(last);
  return { samples: selected, downsampled: true };
}

async function readChunkPayload(env: Env, chunk: schema.WorkspaceResourceChunkRow) {
  const object = await env.PROJECT_DATA_ARCHIVE_R2.get(chunk.r2Key);
  if (!object) throw errors.notFound('Resource history chunk');
  const compressedBytes = new Uint8Array(await object.arrayBuffer());
  if (compressedBytes.byteLength !== chunk.compressedBytes) {
    throw errors.internal('Resource history chunk failed size verification');
  }
  const actualSha = await sha256Hex(compressedBytes);
  if (actualSha !== chunk.sha256) {
    log.warn('workspace_resource_history.chunk_checksum_mismatch', {
      chunkId: chunk.id,
      projectId: chunk.projectId,
      workspaceId: chunk.workspaceId,
    });
    throw errors.internal('Resource history chunk failed integrity verification');
  }
  if (chunk.uncompressedBytes > uncompressedMaxBytes(env)) {
    throw errors.internal('Resource history chunk exceeds configured uncompressed limit');
  }
  const decoded = await readBoundedGzipJson(compressedBytes, uncompressedMaxBytes(env));
  if (decoded.byteLength !== chunk.uncompressedBytes) {
    throw errors.internal('Resource history chunk failed decoded size verification');
  }
  const parsed = decoded.value;
  const samples = Array.isArray(parsed.samples) ? parsed.samples : [];
  const toolSpans = Array.isArray(parsed.toolSpans) ? parsed.toolSpans : [];
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : [];
  const maxPoints = detailMaxPoints(env);
  const downsampled = downsamplePreservingSpikes(samples, maxPoints);
  return {
    chunkId: chunk.id,
    samples: downsampled.samples,
    toolSpans,
    gaps,
    originalSampleCount: samples.length,
    downsampled: downsampled.downsampled,
    downsampleLimit: maxPoints,
  };
}

export async function getWorkspaceResourceHistory(
  env: Env,
  input: {
    projectId: string;
    sessionId?: string | null;
    taskId?: string | null;
    workspaceId?: string | null;
    detailChunkId?: string | null;
  }
): Promise<WorkspaceResourceHistoryResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const limit = readLimit(env);
  const filters = [eq(schema.workspaceResourceChunks.projectId, input.projectId)];
  if (input.sessionId) filters.push(eq(schema.workspaceResourceChunks.sessionId, input.sessionId));
  if (input.taskId) filters.push(eq(schema.workspaceResourceChunks.taskId, input.taskId));
  if (input.workspaceId)
    filters.push(eq(schema.workspaceResourceChunks.workspaceId, input.workspaceId));

  const chunks = await db
    .select()
    .from(schema.workspaceResourceChunks)
    .where(and(...filters))
    .orderBy(desc(schema.workspaceResourceChunks.startedAt))
    .limit(limit);

  const summaryFilters = [eq(schema.workspaceResourceSummaries.projectId, input.projectId)];
  if (input.sessionId)
    summaryFilters.push(eq(schema.workspaceResourceSummaries.sessionId, input.sessionId));
  if (input.taskId) summaryFilters.push(eq(schema.workspaceResourceSummaries.taskId, input.taskId));
  if (input.workspaceId)
    summaryFilters.push(eq(schema.workspaceResourceSummaries.workspaceId, input.workspaceId));
  const summary = await db
    .select()
    .from(schema.workspaceResourceSummaries)
    .where(and(...summaryFilters))
    .orderBy(desc(schema.workspaceResourceSummaries.endedAt))
    .get();

  const selectedChunk = input.detailChunkId
    ? (chunks.find((chunk) => chunk.id === input.detailChunkId) ??
      (await db
        .select()
        .from(schema.workspaceResourceChunks)
        .where(and(...filters, eq(schema.workspaceResourceChunks.id, input.detailChunkId)))
        .get()))
    : null;

  return {
    summary: summary ? publicSummary(summary) : null,
    chunks: chunks.map(publicChunk),
    ...(selectedChunk ? { detail: await readChunkPayload(env, selectedChunk) } : {}),
  };
}

export interface WorkspaceResourceObjectCleanupStats {
  prefix: string;
  listedObjects: number;
  deletedObjects: number;
  truncated: boolean;
}

async function deleteWorkspaceResourceHistoryObjectsByPrefix(
  env: Env,
  prefix: string,
  limit: number
): Promise<WorkspaceResourceObjectCleanupStats> {
  let listedObjects = 0;
  let deletedObjects = 0;
  let truncated = false;

  while (listedObjects < limit) {
    const pageLimit = Math.min(1000, limit - listedObjects);
    const page = await env.PROJECT_DATA_ARCHIVE_R2.list({ prefix, limit: pageLimit });
    if (page.objects.length === 0) {
      truncated = Boolean(page.truncated);
      break;
    }
    for (const object of page.objects) {
      listedObjects += 1;
      await env.PROJECT_DATA_ARCHIVE_R2.delete(object.key);
      deletedObjects += 1;
      if (listedObjects >= limit) break;
    }
    if (listedObjects >= limit) {
      truncated = Boolean(page.truncated);
      break;
    }
  }

  return { prefix, listedObjects, deletedObjects, truncated };
}

export async function deleteWorkspaceResourceHistoryObjectsForProject(
  env: Env,
  projectId: string
): Promise<WorkspaceResourceObjectCleanupStats> {
  return deleteWorkspaceResourceHistoryObjectsByPrefix(
    env,
    `${R2_PREFIX}/projects/${projectId}/`,
    objectCleanupLimit(env)
  );
}

export async function deleteWorkspaceResourceHistoryObjectsForWorkspace(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<WorkspaceResourceObjectCleanupStats> {
  return deleteWorkspaceResourceHistoryObjectsByPrefix(
    env,
    `${R2_PREFIX}/projects/${projectId}/workspaces/${workspaceId}/`,
    objectCleanupLimit(env)
  );
}

export async function runWorkspaceResourceHistoryCleanup(
  env: Env,
  now = Date.now()
): Promise<WorkspaceResourceCleanupStats> {
  const db = drizzle(env.DATABASE, { schema });
  const limit = cleanupBatchSize(env);
  const stats: WorkspaceResourceCleanupStats = {
    expiredChunksSelected: 0,
    expiredChunksDeleted: 0,
    expiredChunkDeleteErrors: 0,
    summariesSelected: 0,
    summariesDeleted: 0,
  };

  const expiredChunks = await db
    .select({
      id: schema.workspaceResourceChunks.id,
      r2Key: schema.workspaceResourceChunks.r2Key,
    })
    .from(schema.workspaceResourceChunks)
    .where(lte(schema.workspaceResourceChunks.expiresAt, now))
    .orderBy(schema.workspaceResourceChunks.expiresAt)
    .limit(limit);
  stats.expiredChunksSelected = expiredChunks.length;

  for (const chunk of expiredChunks) {
    try {
      await env.PROJECT_DATA_ARCHIVE_R2.delete(chunk.r2Key);
      await db
        .delete(schema.workspaceResourceChunks)
        .where(eq(schema.workspaceResourceChunks.id, chunk.id));
      stats.expiredChunksDeleted += 1;
    } catch (error) {
      stats.expiredChunkDeleteErrors += 1;
      log.warn('workspace_resource_history.cleanup_chunk_failed', {
        chunkId: chunk.id,
        r2Key: chunk.r2Key,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summaryCutoff = now - retentionDays(env, 'summary') * MS_PER_DAY;
  const oldSummaries = await db
    .select({ id: schema.workspaceResourceSummaries.id })
    .from(schema.workspaceResourceSummaries)
    .where(lte(schema.workspaceResourceSummaries.updatedAt, summaryCutoff))
    .orderBy(schema.workspaceResourceSummaries.updatedAt)
    .limit(limit);
  stats.summariesSelected = oldSummaries.length;

  const summaryIds = oldSummaries.map((row) => row.id);
  if (summaryIds.length > 0) {
    const deleted = await db
      .delete(schema.workspaceResourceSummaries)
      .where(inArray(schema.workspaceResourceSummaries.id, summaryIds))
      .returning({ id: schema.workspaceResourceSummaries.id });
    stats.summariesDeleted = deleted.length;
  }

  return stats;
}
