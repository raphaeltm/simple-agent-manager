/**
 * Black box recorder: a bounded, best-effort capture of a node's vm-agent, systemd and
 * cloud-init log tails, taken just before teardown and when a node turns unhealthy, so a
 * post-mortem still has evidence after the VM is gone.
 *
 * Hard guarantees:
 * - Never throws and never blocks the caller longer than `nodeLogCaptureTimeoutMs` (plus one
 *   D1 insert). A slow or unreachable node simply produces a `timed_out`/`unreachable` row.
 * - Size, line count and retention are admin settings. The gzipped JSON lives in R2 under
 *   `node-log-captures/<nodeId>/<captureId>.json.gz`; the D1 row is the index the daily
 *   purge uses to delete both.
 * - Uses the existing VM `/logs` endpoint through the node-agent client; no new VM endpoint.
 *
 * Raw logs are unredacted (policy a35180d5): they are readable only through the superadmin
 * Operations tools and are never auto-ingested or sent upstream.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getNodeLogsFromNode } from './node-agent-diagnostics';
import { resolveOperationsTelemetrySetting } from './operations-telemetry-settings';

export const NODE_LOG_CAPTURE_R2_PREFIX = 'node-log-captures';
export const NODE_LOG_CAPTURE_SOURCES = ['agent', 'systemd', 'cloud-init'] as const;
export type NodeLogCaptureSource = (typeof NODE_LOG_CAPTURE_SOURCES)[number];
export type NodeLogCaptureTrigger = 'teardown' | 'unhealthy';
export type NodeLogCaptureStatus =
  'captured' | 'partial' | 'unreachable' | 'timed_out' | 'skipped_stale_heartbeat' | 'failed';

/** One log line can be arbitrarily long; keep each bounded so the capture holds many lines. */
export const NODE_LOG_CAPTURE_MESSAGE_MAX_CHARS = 4000;
export const NODE_LOG_CAPTURE_ERROR_MAX_CHARS = 500;

export interface CapturedLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface NodeLogCapturePayload {
  version: 1;
  nodeId: string;
  trigger: NodeLogCaptureTrigger;
  capturedAt: string;
  sources: Record<NodeLogCaptureSource, { entries: CapturedLogEntry[]; error: string | null }>;
}

export interface NodeLogCaptureResult {
  id: string;
  status: NodeLogCaptureStatus;
  r2Key: string | null;
  entryCount: number;
  durationMs: number;
  error: string | null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function errorText(error: unknown): string {
  return truncate(
    error instanceof Error ? error.message : String(error),
    NODE_LOG_CAPTURE_ERROR_MAX_CHARS
  );
}

function toEntries(response: unknown): CapturedLogEntry[] {
  if (!response || typeof response !== 'object' || !('entries' in response)) return [];
  const entries = (response as { entries: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const result: CapturedLogEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.message !== 'string') continue;
    result.push({
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
      level: typeof record.level === 'string' ? record.level : '',
      message: truncate(record.message, NODE_LOG_CAPTURE_MESSAGE_MAX_CHARS),
    });
  }
  return result;
}

/**
 * Trim the oldest lines (entries arrive newest first) from whichever source currently holds the
 * most lines until the serialized payload fits, so one chatty source cannot evict the others.
 */
export function boundCapturePayload(payload: NodeLogCapturePayload, maxBytes: number): string {
  const size = (text: string) => new TextEncoder().encode(text).byteLength;
  let json = JSON.stringify(payload);
  while (size(json) > maxBytes) {
    let largest = payload.sources[NODE_LOG_CAPTURE_SOURCES[0]];
    for (const source of NODE_LOG_CAPTURE_SOURCES) {
      if (payload.sources[source].entries.length > largest.entries.length) {
        largest = payload.sources[source];
      }
    }
    if (largest.entries.length === 0) break;
    // Drop about enough of the oldest lines in one step (at least one) so the loop stays short.
    const averageLineBytes = Math.max(1, Math.floor(size(json) / countEntries(payload)));
    const drop = Math.max(1, Math.ceil((size(json) - maxBytes) / averageLineBytes));
    largest.entries.splice(Math.max(0, largest.entries.length - drop));
    json = JSON.stringify(payload);
  }
  return json;
}

function countEntries(payload: NodeLogCapturePayload): number {
  return NODE_LOG_CAPTURE_SOURCES.reduce(
    (sum, source) => sum + payload.sources[source].entries.length,
    0
  );
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CaptureOutcome {
  status: NodeLogCaptureStatus;
  r2Key: string | null;
  sources: Record<string, { entries: number; error: string | null }>;
  entryCount: number;
  rawBytes: number;
  storedBytes: number;
  error: string | null;
}

async function collectAndStore(
  env: Env,
  input: { id: string; nodeId: string; userId: string; trigger: NodeLogCaptureTrigger },
  settings: { timeoutMs: number; lines: number; maxBytes: number },
  r2Key: string,
  capturedAt: string
): Promise<CaptureOutcome> {
  const results = await Promise.allSettled(
    NODE_LOG_CAPTURE_SOURCES.map((source) =>
      getNodeLogsFromNode(
        input.nodeId,
        env,
        input.userId,
        new URLSearchParams({ source, limit: String(settings.lines) }).toString(),
        { requestTimeoutMs: settings.timeoutMs }
      )
    )
  );
  const payload: NodeLogCapturePayload = {
    version: 1,
    nodeId: input.nodeId,
    trigger: input.trigger,
    capturedAt,
    sources: {
      agent: { entries: [], error: null },
      systemd: { entries: [], error: null },
      'cloud-init': { entries: [], error: null },
    },
  };
  NODE_LOG_CAPTURE_SOURCES.forEach((source, index) => {
    const result = results[index];
    if (!result) return;
    if (result.status === 'fulfilled') payload.sources[source].entries = toEntries(result.value);
    else payload.sources[source].error = errorText(result.reason);
  });
  const failed = NODE_LOG_CAPTURE_SOURCES.filter((source) => payload.sources[source].error);
  const sources = Object.fromEntries(
    NODE_LOG_CAPTURE_SOURCES.map((source) => [
      source,
      { entries: payload.sources[source].entries.length, error: payload.sources[source].error },
    ])
  );
  if (failed.length === NODE_LOG_CAPTURE_SOURCES.length) {
    return {
      status: 'unreachable',
      r2Key: null,
      sources,
      entryCount: 0,
      rawBytes: 0,
      storedBytes: 0,
      error: payload.sources.agent.error,
    };
  }
  const json = boundCapturePayload(payload, settings.maxBytes);
  const bytes = await gzip(json);
  await env.R2.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { nodeId: input.nodeId, captureId: input.id, trigger: input.trigger },
  });
  return {
    status: failed.length ? 'partial' : 'captured',
    r2Key,
    sources: Object.fromEntries(
      NODE_LOG_CAPTURE_SOURCES.map((source) => [
        source,
        { entries: payload.sources[source].entries.length, error: payload.sources[source].error },
      ])
    ),
    entryCount: countEntries(payload),
    rawBytes: new TextEncoder().encode(json).byteLength,
    storedBytes: bytes.byteLength,
    error: failed.length ? `${failed.join(', ')} unavailable` : null,
  };
}

async function insertCaptureRow(
  env: Env,
  row: {
    id: string;
    nodeId: string;
    userId: string;
    trigger: NodeLogCaptureTrigger;
    outcome: CaptureOutcome;
    durationMs: number;
    createdAt: string;
    expiresAt: string;
  }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO node_log_captures
       (id, node_id, user_id, capture_trigger, status, r2_key, sources_json, entry_count,
        raw_bytes, stored_bytes, error, duration_ms, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      row.nodeId,
      row.userId,
      row.trigger,
      row.outcome.status,
      row.outcome.r2Key,
      JSON.stringify(row.outcome.sources),
      row.outcome.entryCount,
      row.outcome.rawBytes,
      row.outcome.storedBytes,
      row.outcome.error,
      row.durationMs,
      row.createdAt,
      row.expiresAt
    )
    .run();
}

function emptyOutcome(
  status: NodeLogCaptureStatus,
  error: string | null,
  r2Key: string | null = null
): CaptureOutcome {
  return { status, r2Key, sources: {}, entryCount: 0, rawBytes: 0, storedBytes: 0, error };
}

/**
 * Capture once. Bounded by the configured timeout: on timeout the row still records the
 * deterministic R2 key, so a put that lands late is still reached by the retention purge.
 */
export async function captureNodeLogs(
  env: Env,
  input: { nodeId: string; userId: string; trigger: NodeLogCaptureTrigger; now?: Date }
): Promise<NodeLogCaptureResult> {
  const id = ulid();
  const started = Date.now();
  const createdAt = (input.now ?? new Date()).toISOString();
  const r2Key = `${NODE_LOG_CAPTURE_R2_PREFIX}/${input.nodeId}/${id}.json.gz`;
  let outcome: CaptureOutcome;
  let expiresAt = createdAt;
  try {
    const [timeoutMs, lines, maxBytes, retentionDays] = await Promise.all([
      resolveOperationsTelemetrySetting(env, 'nodeLogCaptureTimeoutMs'),
      resolveOperationsTelemetrySetting(env, 'nodeLogCaptureLinesPerSource'),
      resolveOperationsTelemetrySetting(env, 'nodeLogCaptureMaxBytes'),
      resolveOperationsTelemetrySetting(env, 'nodeLogCaptureRetentionDays'),
    ]);
    expiresAt = new Date(Date.parse(createdAt) + retentionDays * 86_400_000).toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<CaptureOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve(emptyOutcome('timed_out', `capture exceeded ${timeoutMs}ms`, r2Key)),
        timeoutMs
      );
    });
    try {
      outcome = await Promise.race([
        collectAndStore(env, { id, ...input }, { timeoutMs, lines, maxBytes }, r2Key, createdAt),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    outcome = emptyOutcome('failed', errorText(error), r2Key);
  }
  const durationMs = Date.now() - started;
  try {
    await insertCaptureRow(env, {
      id,
      nodeId: input.nodeId,
      userId: input.userId,
      trigger: input.trigger,
      outcome,
      durationMs,
      createdAt,
      expiresAt,
    });
  } catch (error) {
    log.warn('node_log_capture.index_write_failed', {
      nodeId: input.nodeId,
      captureId: id,
      error: errorText(error),
    });
  }
  log.info('node_log_capture.completed', {
    nodeId: input.nodeId,
    captureId: id,
    trigger: input.trigger,
    status: outcome.status,
    entryCount: outcome.entryCount,
    durationMs,
  });
  return {
    id,
    status: outcome.status,
    r2Key: outcome.r2Key,
    entryCount: outcome.entryCount,
    durationMs,
    error: outcome.error,
  };
}

/**
 * Capture before teardown, gated so a sequential cleanup sweep never waits on a node that is
 * already silent (rule 47): a fresh heartbeat is the reachability pre-check. Heartbeats here
 * mean "can we reach the VM", never "is it idle" (rule 53). Teardown retries of the same node
 * reuse a recent capture instead of capturing again.
 */
export async function captureNodeLogsBeforeTeardown(
  env: Env,
  node: { id: string; userId: string; runtime: string; lastHeartbeatAt: string | null },
  now: Date = new Date()
): Promise<NodeLogCaptureResult | null> {
  try {
    if (node.runtime !== 'vm') return null;
    const freshnessMs = await resolveOperationsTelemetrySetting(
      env,
      'nodeLogCaptureHeartbeatFreshnessMs'
    );
    const since = new Date(now.getTime() - freshnessMs).toISOString();
    const recent = await env.DATABASE.prepare(
      `SELECT 1 AS found FROM node_log_captures
        WHERE node_id = ? AND capture_trigger = 'teardown' AND created_at > ? LIMIT 1`
    )
      .bind(node.id, since)
      .first<{ found: number }>();
    if (recent) return null;
    const heartbeat = node.lastHeartbeatAt ? Date.parse(node.lastHeartbeatAt) : Number.NaN;
    if (!Number.isFinite(heartbeat) || heartbeat < now.getTime() - freshnessMs) {
      const id = ulid();
      await insertCaptureRow(env, {
        id,
        nodeId: node.id,
        userId: node.userId,
        trigger: 'teardown',
        outcome: emptyOutcome(
          'skipped_stale_heartbeat',
          `last heartbeat ${node.lastHeartbeatAt ?? 'never'}; not reachable for capture`
        ),
        durationMs: 0,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() +
            (await resolveOperationsTelemetrySetting(env, 'nodeLogCaptureRetentionDays')) *
              86_400_000
        ).toISOString(),
      });
      return null;
    }
    return await captureNodeLogs(env, {
      nodeId: node.id,
      userId: node.userId,
      trigger: 'teardown',
      now,
    });
  } catch (error) {
    log.warn('node_log_capture.teardown_gate_failed', { nodeId: node.id, error: errorText(error) });
    return null;
  }
}

/** Unhealthy transitions are captured together so the sweep waits one timeout, not N. */
export async function captureNodeLogsOnUnhealthy(
  env: Env,
  nodes: ReadonlyArray<{ id: string; userId: string }>
): Promise<void> {
  await Promise.allSettled(
    nodes.map((node) =>
      captureNodeLogs(env, { nodeId: node.id, userId: node.userId, trigger: 'unhealthy' })
    )
  );
}
