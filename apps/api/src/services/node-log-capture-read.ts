/**
 * Read side of the black box recorder: list a node's captures, read one capture with
 * server-side filtering, and purge expired captures (R2 object first, then the index row).
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parseWithSchema } from '../lib/runtime-validation';
import {
  type CapturedLogEntry,
  NODE_LOG_CAPTURE_SOURCES,
  type NodeLogCaptureSource,
} from './node-log-capture';

const CapturedEntriesSchema = v.optional(
  v.object({
    entries: v.array(v.object({ timestamp: v.string(), level: v.string(), message: v.string() })),
  })
);
const CapturePayloadSchema = v.object({
  sources: v.object({
    agent: CapturedEntriesSchema,
    systemd: CapturedEntriesSchema,
    'cloud-init': CapturedEntriesSchema,
  }),
});

export const DEFAULT_NODE_LOG_CAPTURE_LIST_LIMIT = 10;
export const MAX_NODE_LOG_CAPTURE_LIST_LIMIT = 50;
export const DEFAULT_NODE_LOG_CAPTURE_READ_LIMIT = 200;
export const MAX_NODE_LOG_CAPTURE_READ_LIMIT = 1000;
/** Gunzipped captures are bounded at write time; this guards a corrupt or foreign object. */
export const MAX_NODE_LOG_CAPTURE_DECOMPRESSED_BYTES = 20_000_000;
export const DEFAULT_NODE_LOG_CAPTURE_PURGE_BATCH = 100;

export interface NodeLogCaptureSummary {
  id: string;
  nodeId: string;
  trigger: string;
  status: string;
  sources: Record<string, { entries: number; error: string | null }> | null;
  entryCount: number;
  rawBytes: number;
  storedBytes: number;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  expiresAt: string;
  hasContent: boolean;
}

interface CaptureDbRow {
  id: string;
  node_id: string;
  user_id: string;
  capture_trigger: string;
  status: string;
  r2_key: string | null;
  sources_json: string | null;
  entry_count: number;
  raw_bytes: number;
  stored_bytes: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  expires_at: string;
}

const SELECT_COLUMNS = `id, node_id, user_id, capture_trigger, status, r2_key, sources_json,
  entry_count, raw_bytes, stored_bytes, error, duration_ms, created_at, expires_at`;

function parseSources(value: string | null): NodeLogCaptureSummary['sources'] {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as NodeLogCaptureSummary['sources'])
      : null;
  } catch {
    return null;
  }
}

function toSummary(row: CaptureDbRow): NodeLogCaptureSummary {
  return {
    id: row.id,
    nodeId: row.node_id,
    trigger: row.capture_trigger,
    status: row.status,
    sources: parseSources(row.sources_json),
    entryCount: row.entry_count,
    rawBytes: row.raw_bytes,
    storedBytes: row.stored_bytes,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hasContent: row.r2_key !== null && (row.status === 'captured' || row.status === 'partial'),
  };
}

/** Newest first. */
export async function listNodeLogCaptures(
  db: D1Database,
  nodeId: string,
  limit: number = DEFAULT_NODE_LOG_CAPTURE_LIST_LIMIT
): Promise<NodeLogCaptureSummary[]> {
  const bounded = Math.max(1, Math.min(MAX_NODE_LOG_CAPTURE_LIST_LIMIT, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM node_log_captures
        WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(nodeId, bounded)
    .all<CaptureDbRow>();
  return rows.results.map(toSummary);
}

async function gunzipBounded(body: ReadableStream, maxBytes: number): Promise<string> {
  const reader = body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Node log capture exceeds the decompressed size limit');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export interface NodeLogCaptureReadOptions {
  source?: NodeLogCaptureSource;
  contains?: string;
  limit?: number;
}

export interface NodeLogCaptureRead {
  capture: NodeLogCaptureSummary;
  entries: Array<CapturedLogEntry & { source: NodeLogCaptureSource }>;
  matched: number;
  truncated: boolean;
}

/**
 * Read one capture, filtered server-side so the caller pulls only matching lines. Returns null
 * for an unknown id. A capture without stored content returns its summary and no entries.
 */
export async function readNodeLogCapture(
  env: Env,
  captureId: string,
  options: NodeLogCaptureReadOptions = {}
): Promise<NodeLogCaptureRead | null> {
  const row = await env.DATABASE.prepare(
    `SELECT ${SELECT_COLUMNS} FROM node_log_captures WHERE id = ?`
  )
    .bind(captureId)
    .first<CaptureDbRow>();
  if (!row) return null;
  const capture = toSummary(row);
  if (!capture.hasContent || !row.r2_key) {
    return { capture, entries: [], matched: 0, truncated: false };
  }
  const object = await env.R2.get(row.r2_key);
  if (!object) {
    return {
      capture: { ...capture, hasContent: false },
      entries: [],
      matched: 0,
      truncated: false,
    };
  }
  const parsed = parseWithSchema(
    CapturePayloadSchema,
    JSON.parse(
      await gunzipBounded(object.body, MAX_NODE_LOG_CAPTURE_DECOMPRESSED_BYTES)
    ) as unknown,
    'node log capture'
  );
  const limit = Math.max(
    1,
    Math.min(MAX_NODE_LOG_CAPTURE_READ_LIMIT, options.limit ?? DEFAULT_NODE_LOG_CAPTURE_READ_LIMIT)
  );
  const needle = options.contains?.toLowerCase();
  const sources = options.source ? [options.source] : NODE_LOG_CAPTURE_SOURCES;
  const matches: Array<CapturedLogEntry & { source: NodeLogCaptureSource }> = [];
  for (const source of sources) {
    for (const entry of parsed.sources[source]?.entries ?? []) {
      if (needle && !entry.message.toLowerCase().includes(needle)) continue;
      matches.push({ ...entry, source });
    }
  }
  return {
    capture,
    entries: matches.slice(0, limit),
    matched: matches.length,
    truncated: matches.length > limit,
  };
}

/** Delete one bounded batch of expired captures: R2 objects first, then their index rows. */
export async function purgeExpiredNodeLogCaptures(
  env: Env,
  now: Date = new Date(),
  batchLimit: number = DEFAULT_NODE_LOG_CAPTURE_PURGE_BATCH
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, r2_key FROM node_log_captures WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`
  )
    .bind(now.toISOString(), batchLimit)
    .all<{ id: string; r2_key: string | null }>();
  if (rows.results.length === 0) return 0;
  const keys = rows.results.flatMap((row) => (row.r2_key ? [row.r2_key] : []));
  if (keys.length) await env.R2.delete(keys);
  const ids = rows.results.map((row) => row.id);
  await env.DATABASE.prepare(
    `DELETE FROM node_log_captures WHERE id IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(ids))
    .run();
  log.info('node_log_capture.purged', { count: ids.length, objects: keys.length });
  return ids.length;
}
