import {
  CHECKPOINT_EPISODE_TRANSITIONS,
  type CheckpointEpisode,
  type CheckpointEpisodeTransitionInput,
  type CreateCheckpointEpisodeInput,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import {
  parseCheckpointEpisodeRow,
  parseCheckpointProgressEnvelope,
} from './row-schemas';

const log = createModuleLogger('project_data.checkpoint_episodes');
const MAX_CHECKPOINT_REASON_LENGTH = 512;
const MAX_CHECKPOINT_ERROR_LENGTH = 2048;

function requireIdentifier(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function bounded(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function createCheckpointEpisode(
  sql: SqlStorage,
  input: CreateCheckpointEpisodeInput,
  now = Date.now(),
): { episode: CheckpointEpisode; created: boolean } {
  const sessionId = requireIdentifier(input.sessionId, 'sessionId');
  const acpSessionId = requireIdentifier(input.acpSessionId, 'acpSessionId');
  if (!Number.isSafeInteger(input.promptEpoch) || input.promptEpoch <= 0) {
    throw new Error('promptEpoch must be a positive safe integer');
  }
  const reason = bounded(input.reason, MAX_CHECKPOINT_REASON_LENGTH);
  if (!reason) throw new Error('reason is required');
  const envelope = input.progressEnvelope
    ? parseCheckpointProgressEnvelope(input.progressEnvelope)
    : null;
  const id = ulid();

  const result = sql.exec(
    `INSERT INTO checkpoint_episodes
      (id, session_id, task_id, workspace_id, acp_session_id, prompt_epoch,
       reason, state, progress_envelope_json, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, 0, ?, ?)
     ON CONFLICT(acp_session_id, prompt_epoch) DO NOTHING`,
    id,
    sessionId,
    input.taskId ?? null,
    input.workspaceId ?? null,
    acpSessionId,
    input.promptEpoch,
    reason,
    envelope ? JSON.stringify(envelope) : null,
    now,
    now,
  );

  const row = sql.exec(
    `SELECT * FROM checkpoint_episodes
     WHERE acp_session_id = ? AND prompt_epoch = ?`,
    acpSessionId,
    input.promptEpoch,
  ).toArray()[0];
  if (!row) throw new Error('checkpoint episode insert did not produce a row');

  return {
    episode: parseCheckpointEpisodeRow(row),
    created: result.rowsWritten > 0,
  };
}

export function getCheckpointEpisode(
  sql: SqlStorage,
  episodeId: string,
): CheckpointEpisode | null {
  const row = sql.exec(
    'SELECT * FROM checkpoint_episodes WHERE id = ?',
    episodeId,
  ).toArray()[0];
  if (!row) return null;
  try {
    return parseCheckpointEpisodeRow(row);
  } catch (error) {
    log.warn('checkpoint_episode.get_row_skipped', {
      episodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function getCheckpointEpisodeByPrompt(
  sql: SqlStorage,
  acpSessionId: string,
  promptEpoch: number,
): CheckpointEpisode | null {
  const row = sql.exec(
    `SELECT * FROM checkpoint_episodes
     WHERE acp_session_id = ? AND prompt_epoch = ?`,
    acpSessionId,
    promptEpoch,
  ).toArray()[0];
  if (!row) return null;
  try {
    return parseCheckpointEpisodeRow(row);
  } catch (error) {
    log.warn('checkpoint_episode.get_prompt_row_skipped', {
      acpSessionId,
      promptEpoch,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function listCheckpointEpisodes(
  sql: SqlStorage,
  sessionId: string,
  limit = 50,
): CheckpointEpisode[] {
  const rows = sql.exec(
    `SELECT * FROM checkpoint_episodes
     WHERE session_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    sessionId,
    Math.max(1, Math.min(limit, 200)),
  ).toArray();
  const episodes: CheckpointEpisode[] = [];
  for (const row of rows) {
    try {
      episodes.push(parseCheckpointEpisodeRow(row));
    } catch (error) {
      log.warn('checkpoint_episode.list_row_skipped', {
        episodeId: typeof row.id === 'string' ? row.id : null,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return episodes;
}

export function transitionCheckpointEpisode(
  sql: SqlStorage,
  episodeId: string,
  input: CheckpointEpisodeTransitionInput,
  now = Date.now(),
): CheckpointEpisode | null {
  const current = getCheckpointEpisode(sql, episodeId);
  if (!current) return null;
  if (input.expectedState && current.state !== input.expectedState) return current;
  if (!CHECKPOINT_EPISODE_TRANSITIONS[current.state].includes(input.toState)) {
    throw new Error(`Invalid checkpoint transition ${current.state} -> ${input.toState}`);
  }

  const result = sql.exec(
    `UPDATE checkpoint_episodes
     SET state = ?,
         attempt_count = attempt_count + ?,
         last_error = ?,
         mailbox_message_id = ?,
         prompt_delivery_id = ?,
         updated_at = ?,
         preempt_requested_at = CASE WHEN ? = 'preempt_requested' THEN ? ELSE preempt_requested_at END,
         preempt_accepted_at = CASE WHEN ? = 'waiting_ready' THEN ? ELSE preempt_accepted_at END,
         ready_observed_at = CASE WHEN ? = 'resume_queued' THEN ? ELSE ready_observed_at END,
         resume_accepted_at = CASE WHEN ? = 'resumed' THEN ? ELSE resume_accepted_at END,
         completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
         failed_at = CASE WHEN ? IN ('failed_recoverable', 'failed_terminal') THEN ? ELSE failed_at END
     WHERE id = ? AND state = ?`,
    input.toState,
    input.incrementAttempt ? 1 : 0,
    bounded(input.lastError, MAX_CHECKPOINT_ERROR_LENGTH),
    input.mailboxMessageId ?? current.mailboxMessageId,
    input.promptDeliveryId ?? current.promptDeliveryId,
    now,
    input.toState,
    now,
    input.toState,
    now,
    input.toState,
    now,
    input.toState,
    now,
    input.toState,
    now,
    input.toState,
    now,
    episodeId,
    current.state,
  );
  if (result.rowsWritten === 0) return getCheckpointEpisode(sql, episodeId);
  return getCheckpointEpisode(sql, episodeId);
}
