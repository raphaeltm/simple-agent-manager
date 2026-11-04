/**
 * Sleep/wake step traces: which snapshot/restore phases ran, how long each took, which one
 * failed and a bounded, redacted tail of its error output, so "snapshot failed" says where.
 *
 * Rows come from the VM agent's one best-effort `/lifecycle-timings` callback per operation.
 * Rollout compatibility (rule 54): an older agent sends only phase timings, which still make a
 * useful trace; it never sends `failedPhase`/`errorTail`, and nothing here requires them.
 * The chat identity is the workspace's server-recorded `chat_session_id`, never the body's.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { LIFECYCLE_PHASES, type LifecycleTiming } from './lifecycle-timings';
import { resolveOperationsTelemetrySetting } from './operations-telemetry-settings';
import { redactSecretPatterns } from './secret-redaction';

/** Keep the END of the error output: the failure reason is on the last lines (rule 53 §5c). */
export const SNAPSHOT_TRACE_ERROR_TAIL_MAX_CHARS = 2000;
export const DEFAULT_SNAPSHOT_TRACE_LIST_LIMIT = 10;
export const MAX_SNAPSHOT_TRACE_LIST_LIMIT = 50;
export const DEFAULT_SNAPSHOT_TRACE_PURGE_BATCH = 500;

const phaseNames = new Set<string>(LIFECYCLE_PHASES);

export interface SessionSnapshotTraceInput {
  chatSessionId: string;
  projectId: string | null;
  workspaceId: string;
  nodeId: string | null;
  operation: 'sleep' | 'wake';
  outcome: 'success' | 'error';
  phases: LifecycleTiming[];
  failedPhase?: unknown;
  errorTail?: unknown;
}

export interface SessionSnapshotTrace {
  id: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string | null;
  operation: string;
  outcome: string;
  failedPhase: string | null;
  phases: LifecycleTiming[];
  errorTail: string | null;
  totalMs: number;
  createdAt: string;
}

/** Strip control characters, redact secret-like strings, and keep only the tail. */
export function boundedErrorTail(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && character !== '\n') || code === 0x7f ? ' ' : character;
  }).join('');
  const redacted = redactSecretPatterns(printable);
  return redacted.length <= SNAPSHOT_TRACE_ERROR_TAIL_MAX_CHARS
    ? redacted
    : `…${redacted.slice(redacted.length - (SNAPSHOT_TRACE_ERROR_TAIL_MAX_CHARS - 1))}`;
}

/** Best-effort; never throws. Prunes the chat's traces to the configured count. */
export async function recordSessionSnapshotTrace(
  env: Env,
  input: SessionSnapshotTraceInput,
  now: Date = new Date()
): Promise<string | null> {
  try {
    const failedPhase =
      typeof input.failedPhase === 'string' && phaseNames.has(input.failedPhase)
        ? input.failedPhase
        : null;
    const id = ulid();
    const keep = await resolveOperationsTelemetrySetting(env, 'snapshotTracesPerSession');
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO session_snapshot_traces
           (id, chat_session_id, project_id, workspace_id, node_id, operation, outcome,
            failed_phase, phases_json, error_tail, total_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        input.chatSessionId,
        input.projectId,
        input.workspaceId,
        input.nodeId,
        input.operation,
        input.outcome,
        failedPhase,
        JSON.stringify(input.phases),
        input.outcome === 'error' ? boundedErrorTail(input.errorTail) : null,
        input.phases.reduce((sum, phase) => sum + phase.durationMs, 0),
        now.toISOString()
      ),
      env.DATABASE.prepare(
        `DELETE FROM session_snapshot_traces
          WHERE chat_session_id = ?
            AND id NOT IN (
              SELECT id FROM session_snapshot_traces WHERE chat_session_id = ?
               ORDER BY created_at DESC, id DESC LIMIT ?
            )`
      ).bind(input.chatSessionId, input.chatSessionId, keep),
    ]);
    return id;
  } catch (error) {
    log.warn('session_snapshot_trace.write_failed', {
      workspaceId: input.workspaceId,
      chatSessionId: input.chatSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parsePhases(value: string): LifecycleTiming[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const { phase, durationMs } = item as Record<string, unknown>;
      return typeof phase === 'string' && typeof durationMs === 'number'
        ? [{ phase, durationMs }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Newest first. */
export async function listSessionSnapshotTraces(
  db: D1Database,
  chatSessionId: string,
  limit: number = DEFAULT_SNAPSHOT_TRACE_LIST_LIMIT
): Promise<SessionSnapshotTrace[]> {
  const bounded = Math.max(1, Math.min(MAX_SNAPSHOT_TRACE_LIST_LIMIT, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT id, chat_session_id, workspace_id, node_id, operation, outcome, failed_phase,
              phases_json, error_tail, total_ms, created_at
         FROM session_snapshot_traces WHERE chat_session_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(chatSessionId, bounded)
    .all<{
      id: string;
      chat_session_id: string;
      workspace_id: string;
      node_id: string | null;
      operation: string;
      outcome: string;
      failed_phase: string | null;
      phases_json: string;
      error_tail: string | null;
      total_ms: number;
      created_at: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    chatSessionId: row.chat_session_id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    operation: row.operation,
    outcome: row.outcome,
    failedPhase: row.failed_phase,
    phases: parsePhases(row.phases_json),
    errorTail: row.error_tail,
    totalMs: row.total_ms,
    createdAt: row.created_at,
  }));
}

/** Deletes one bounded batch of traces older than the retention window. */
export async function purgeSessionSnapshotTraces(
  db: D1Database,
  retentionDays: number,
  now: Date = new Date(),
  batchLimit: number = DEFAULT_SNAPSHOT_TRACE_PURGE_BATCH
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const result = await db
    .prepare(
      `DELETE FROM session_snapshot_traces WHERE id IN (
         SELECT id FROM session_snapshot_traces WHERE created_at < ? ORDER BY created_at LIMIT ?
       )`
    )
    .bind(cutoff, batchLimit)
    .run();
  return result.meta.changes ?? 0;
}
