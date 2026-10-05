/** Delivered check-ins have a durable budget independent of liveness probe retries. */
import * as v from 'valibot';

import { createAttentionMarker, resolveAttentionMarkersByKind } from './attention';
import { persistMessage } from './messages';
import { clearReconciliationCandidateGate } from './reconciliation-candidate-state';
import type { Env } from './types';

export const RECONCILIATION_EPISODE_PREFIX = 'taskReconciliationEpisode:';
const EpisodeSchema = v.object({
  generation: v.string(),
  attempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lastDeliveryId: v.nullable(v.string()),
  lastToolCallId: v.nullable(v.string()),
  paused: v.boolean(),
});
export type ReconciliationEpisode = v.InferOutput<typeof EpisodeSchema>;
type Broadcast = (type: string, payload: Record<string, unknown>, sessionId?: string) => void;

export function readReconciliationEpisode(
  sql: SqlStorage,
  sessionId: string
): ReconciliationEpisode | null {
  const row = sql
    .exec('SELECT value FROM do_meta WHERE key = ?', RECONCILIATION_EPISODE_PREFIX + sessionId)
    .toArray()[0];
  if (typeof row?.value !== 'string') return null;
  try {
    const result = v.safeParse(EpisodeSchema, JSON.parse(row.value));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

export function writeReconciliationEpisode(
  sql: SqlStorage,
  sessionId: string,
  episode: ReconciliationEpisode
): void {
  sql.exec(
    `INSERT INTO do_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    RECONCILIATION_EPISODE_PREFIX + sessionId,
    JSON.stringify(episode)
  );
}

export function ensureReconciliationEpisode(
  sql: SqlStorage,
  sessionId: string
): ReconciliationEpisode {
  const existing = readReconciliationEpisode(sql, sessionId);
  if (existing) return existing;
  const episode = {
    generation: crypto.randomUUID(),
    attempts: 0,
    lastDeliveryId: null,
    lastToolCallId: null,
    paused: false,
  };
  writeReconciliationEpisode(sql, sessionId, episode);
  return episode;
}

export function resetReconciliationEpisode(
  sql: SqlStorage,
  sessionId: string,
  toolCallId: string | null = null
): void {
  const old = readReconciliationEpisode(sql, sessionId);
  if (!old || (toolCallId && old.lastToolCallId === toolCallId)) return;
  writeReconciliationEpisode(sql, sessionId, {
    generation: crypto.randomUUID(),
    attempts: 0,
    lastDeliveryId: null,
    lastToolCallId: toolCallId ?? old.lastToolCallId,
    paused: false,
  });
  clearReconciliationCandidateGate(sql, sessionId);
  if (toolCallId)
    resolveAttentionMarkersByKind(
      sql,
      sessionId,
      'reconciliation_checkin',
      null,
      'agent',
      'tool_progress'
    );
  // Only our pause marker is cleared by machine progress. Human input still
  // resolves other attention through the existing human-message path.
  sql.exec(
    `UPDATE session_attention_markers SET resolved_at = ?, resolved_by_actor_type = ?, resolved_reason = ?
    WHERE session_id = ? AND kind = 'needs_input' AND source = 'reconciliation_loop' AND resolved_at IS NULL`,
    Date.now(),
    toolCallId ? 'agent' : 'human',
    toolCallId ? 'tool_progress' : 'human_message',
    sessionId
  );
}

/** Recognize exact runtime error text/envelopes, never prose quoting an error. */
export function isPermanentRuntimeError(content: string): boolean {
  const normalized = content.trim().replace(/^Warning: Model metadata[^\n]*\n\s*/, '');
  const unsupportedModel =
    /^The '[^'\n]+' model is not supported when using Codex with a ChatGPT account\.$/;
  // Current Codex emits the message directly; older versions used the JSON
  // envelope below. Warning and error can also arrive as separate messages.
  if (unsupportedModel.test(normalized)) return true;
  try {
    const envelope = v.safeParse(
      v.object({
        type: v.literal('error'),
        status: v.literal(400),
        error: v.object({ type: v.literal('invalid_request_error'), message: v.string() }),
      }),
      JSON.parse(normalized)
    );
    return envelope.success && unsupportedModel.test(envelope.output.error.message);
  } catch {
    return false;
  }
}

export function pauseReconciliationEpisode(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  episode: ReconciliationEpisode,
  reason: 'unsupported_model' | 'attempt_limit',
  broadcast: Broadcast
): boolean {
  const current = readReconciliationEpisode(sql, sessionId);
  if (!current || current.generation !== episode.generation || current.paused) return false;
  const session = sql
    .exec('SELECT task_id, workspace_id FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (!session) return false;
  writeReconciliationEpisode(sql, sessionId, { ...current, paused: true });
  clearReconciliationCandidateGate(sql, sessionId);
  resolveAttentionMarkersByKind(
    sql,
    sessionId,
    'reconciliation_checkin',
    null,
    'system',
    'reconciliation_paused'
  );
  const content =
    reason === 'unsupported_model'
      ? 'SAM paused automatic check-ins because the runtime rejected the selected model. Fix the model/runtime compatibility, then send a message to retry. Your session and work are preserved.'
      : 'SAM paused automatic check-ins after repeated attempts without confirmed progress. Your session and work are preserved. Check the last error or pending operation, then send a message to continue.';
  const metadata = { source: 'sam_orchestrator', kind: 'reconciliation_paused', reason };
  const message = persistMessage(sql, env, sessionId, 'system', content, JSON.stringify(metadata));
  const marker = createAttentionMarker(sql, {
    sessionId,
    taskId: typeof session.task_id === 'string' ? session.task_id : null,
    workspaceId: typeof session.workspace_id === 'string' ? session.workspace_id : null,
    kind: 'needs_input',
    source: 'reconciliation_loop',
    sourceMessageId: message.id,
    reason: content,
  });
  broadcast(
    'message.new',
    {
      sessionId,
      messageId: message.id,
      role: 'system',
      content,
      toolMetadata: metadata,
      createdAt: message.now,
      sequence: message.sequence,
    },
    sessionId
  );
  broadcast(
    'attention.created',
    { sessionId, markerId: marker.id, kind: 'needs_input', reason: content },
    sessionId
  );
  return true;
}

/** Called only for newly persisted messages, before the first asynchronous hook. */
export function observeReconciliationMessage(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  message: {
    id: string;
    role: string;
    content: string;
    toolMetadata: unknown;
    origin?: string | null;
  },
  broadcast: Broadcast
): void {
  const permanent = message.role === 'assistant' && isPermanentRuntimeError(message.content);
  const episode = permanent
    ? ensureReconciliationEpisode(sql, sessionId)
    : readReconciliationEpisode(sql, sessionId);
  if (!episode) return;
  let metadata: unknown = message.toolMetadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }
  const tool = v.safeParse(
    v.object({ status: v.literal('completed'), toolCallId: v.string() }),
    metadata
  );
  if (message.role === 'tool' && tool.success && tool.output.toolCallId) {
    if (episode.attempts === 0 && !episode.paused) return;
    // The persisted transcript is the completion ledger: unlike remembering
    // only the last ID, it also rejects A/B/A replays across restarts. This
    // lookup runs only after a check-in, not on every ordinary tool update.
    const first = sql
      .exec(
        `SELECT id FROM chat_messages
      WHERE session_id = ? AND role = 'tool' AND json_valid(tool_metadata)
        AND json_extract(tool_metadata, '$.toolCallId') = ?
        AND json_extract(tool_metadata, '$.status') = 'completed'
      ORDER BY rowid ASC LIMIT 1`,
        sessionId,
        tool.output.toolCallId
      )
      .toArray()[0];
    if (first?.id === message.id)
      resetReconciliationEpisode(sql, sessionId, tool.output.toolCallId);
  } else if (
    message.role === 'user' &&
    message.origin !== 'system' &&
    metadata === null &&
    !message.content.startsWith('[SAM ')
  ) {
    resetReconciliationEpisode(sql, sessionId);
  } else if (permanent) {
    pauseReconciliationEpisode(sql, env, sessionId, episode, 'unsupported_model', broadcast);
  }
}
