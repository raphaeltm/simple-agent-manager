/**
 * The ProjectData half of Insights · Agent setups (slice S, `projectSetups` in
 * `packages/operations/src/insights-setups.ts`): how many times a person nudged each run.
 *
 * A nudge is a message a person sent into a run's chat while the run was going: a
 * `chat_messages` row with `role = 'user'` created inside the run's window whose
 * `tool_metadata.source` is a human prompt-delivery trigger (`HUMAN_PROMPT_DELIVERY_TRIGGERS`:
 * `user_followup`, written by send-chat for a typed follow-up, and `comment_directive`, a
 * comment addressed to the agent). The task's own first prompt, agent mailbox messages, SAM
 * notices, wake prompts and scheduled prompts carry other sources and are not nudges. Follow-ups
 * sent while durable prompt delivery is switched off (`DURABLE_PROMPT_DELIVERY_ENABLED=false`,
 * on by default) carry no source and are not counted.
 *
 * Cost: one indexed probe per window. `idx_chat_messages_user_content` (`session_id, content`,
 * partial on `role = 'user'`) holds only a chat's user messages, so each probe reads that chat's
 * typed prompts (a handful), never its tool output. The caller bounds the number of windows.
 */
import type { RunNudgeCounts, RunNudgeWindow } from '@simple-agent-manager/shared';

import { HUMAN_PROMPT_DELIVERY_TRIGGERS } from './agent-wake-policy';

const HUMAN_SOURCES = HUMAN_PROMPT_DELIVERY_TRIGGERS.map((source) => `'${source}'`).join(', ');

// `json_valid` first: one malformed row must not raise "malformed JSON" and fail the whole read
// (`.claude/rules/50`). `created_at > from` leaves out a prompt that started the run.
const NUDGE_COUNT_SQL = `
  SELECT COUNT(*) AS nudges
    FROM chat_messages INDEXED BY idx_chat_messages_user_content
   WHERE session_id = ? AND role = 'user' AND created_at > ? AND created_at <= ?
     AND CASE WHEN json_valid(tool_metadata)
              THEN json_extract(tool_metadata, '$.source') IN (${HUMAN_SOURCES})
              ELSE 0 END`;

const SESSION_SQL = 'SELECT archive_state FROM chat_sessions WHERE id = ? LIMIT 1';

export function countRunNudges(
  sql: SqlStorage,
  windows: readonly RunNudgeWindow[],
  maxWindows: number
): RunNudgeCounts {
  const cap = Math.max(0, Math.floor(maxWindows));
  const archived = new Map<string, boolean | null>();
  const counts = windows.slice(0, cap).map((window) => {
    let state = archived.get(window.sessionId);
    if (state === undefined) {
      const row = sql.exec(SESSION_SQL, window.sessionId).toArray()[0];
      state = row ? row.archive_state === 'source_deleted' : null;
      archived.set(window.sessionId, state);
    }
    // A chat this object does not hold, or one whose messages were archived away: not recorded.
    if (state !== false) return null;
    const row = sql
      .exec(NUDGE_COUNT_SQL, window.sessionId, window.fromMs, window.toMs)
      .toArray()[0];
    const value = row?.nudges;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
  return { counts };
}
