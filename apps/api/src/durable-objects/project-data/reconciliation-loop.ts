import type { Env as WorkerEnv } from '../../env';
import {
  classifyReconciliationLoop,
  getStalledTaskClassifierConfig,
} from '../../scheduled/stalled-task-classifier';
import { recordActivityEventInternal } from './activity';
import type { ReconciliationCandidate } from './reconciliation-candidates';
import {
  ensureReconciliationEpisode,
  isPermanentRuntimeError,
  pauseReconciliationEpisode,
  readReconciliationEpisode,
  writeReconciliationEpisode,
} from './reconciliation-episode';
import { reconciliationMaxCheckins } from './reconciliation-thresholds';
import type { Env } from './types';

type Broadcast = (type: string, payload: Record<string, unknown>, sessionId?: string) => void;

/** Stop before another prompt crosses the runtime boundary. */
export async function guardReconciliationLoop(
  sql: SqlStorage,
  env: Env,
  candidate: ReconciliationCandidate,
  broadcast: Broadcast
): Promise<boolean> {
  const episode = ensureReconciliationEpisode(sql, candidate.sessionId);
  if (episode.paused) return false;
  const config = getStalledTaskClassifierConfig(env as unknown as WorkerEnv);
  const messages = sql
    .exec(
      `SELECT role, substr(content, 1, ?) AS content, created_at FROM chat_messages
     WHERE session_id = ? ORDER BY sequence DESC LIMIT ?`,
      config.transcriptMaxChars,
      candidate.sessionId,
      config.messageLimit
    )
    .toArray()
    .reverse();
  // Bound the legacy fallback to the last assistant response, stopping at real
  // tool work or user input; a historical rejection must not poison a retry.
  let lastAssistant = '';
  for (const message of messages) {
    if (message.role === 'assistant') lastAssistant += String(message.content ?? '');
    else if (message.role !== 'thinking') lastAssistant = '';
  }
  if (isPermanentRuntimeError(lastAssistant)) {
    pauseReconciliationEpisode(
      sql,
      env,
      candidate.sessionId,
      episode,
      'unsupported_model',
      broadcast
    );
    return false;
  }
  if (episode.attempts < reconciliationMaxCheckins(env)) return true;

  // Persist the stop and user-visible notice BEFORE awaiting Clef. A restart,
  // timeout or overlapping alarm cannot call it twice or grant a fourth nudge.
  if (
    !pauseReconciliationEpisode(sql, env, candidate.sessionId, episode, 'attempt_limit', broadcast)
  )
    return false;
  const result = await classifyReconciliationLoop(env as unknown as WorkerEnv, messages);
  const current = readReconciliationEpisode(sql, candidate.sessionId);
  if (current?.generation !== episode.generation || !current.paused) return false;
  const decision = result?.decision ?? 'unavailable';
  // Advisory only: even still_working waits for actual progress to replenish the
  // budget. It never cancels a tool, marks the task failed, or changes the model.
  const detail =
    decision === 'still_working'
      ? 'An operation may still be running; SAM has left it running and paused further check-ins.'
      : decision === 'stalled'
        ? 'The repeated attempts appear stuck. Review the last error and send a message after fixing it.'
        : 'SAM could not confirm progress. Review the last operation before retrying.';
  sql.exec(
    `UPDATE session_attention_markers SET reason = ?, metadata = ?
    WHERE session_id = ? AND source = 'reconciliation_loop' AND resolved_at IS NULL`,
    detail,
    JSON.stringify({ decision, confidence: result?.confidence ?? null }),
    candidate.sessionId
  );
  recordActivityEventInternal(
    sql,
    'reconciliation.loop_paused',
    'system',
    null,
    candidate.workspaceId,
    candidate.sessionId,
    candidate.taskId,
    JSON.stringify({ attempts: episode.attempts, decision, confidence: result?.confidence ?? null })
  );
  return false;
}

/** Reserve once per receipt identity, before delivery can race message callbacks. */
export function reserveReconciliationCheckin(
  sql: SqlStorage,
  sessionId: string,
  deliveryId: string
): void {
  const episode = ensureReconciliationEpisode(sql, sessionId);
  if (episode.lastDeliveryId === deliveryId) return;
  writeReconciliationEpisode(sql, sessionId, {
    ...episode,
    attempts: episode.attempts + 1,
    lastDeliveryId: deliveryId,
  });
}
