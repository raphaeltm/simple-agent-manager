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
 * Cost (rule 81): one session lookup and one indexed read per distinct chat, however many runs
 * share it (a woken run continues its predecessor's chat). `idx_chat_messages_user_content`
 * (`session_id, content`, partial on `role = 'user'`) holds only a chat's user messages, so a read
 * touches that chat's typed prompts, never its tool output or agent messages; each row fetched is
 * a timestamp and a flag. At the caller's default cap (2,000 runs) that is at most 4,000 small
 * statements, a few tens of milliseconds of SQLite work; the caller bounds the windows.
 */
import type { RunNudgeCounts, RunNudgeWindow } from '@simple-agent-manager/shared';

import { HUMAN_PROMPT_DELIVERY_TRIGGERS } from './agent-wake-policy';

const HUMAN_SOURCES = HUMAN_PROMPT_DELIVERY_TRIGGERS.map((source) => `'${source}'`).join(', ');

// `json_valid` first: one malformed row must not raise "malformed JSON" and fail the whole read
// (`.claude/rules/50`); a row that is not valid JSON is simply not a nudge.
const HUMAN_MESSAGE_TIMES_SQL = `
  SELECT created_at
    FROM chat_messages INDEXED BY idx_chat_messages_user_content
   WHERE session_id = ? AND role = 'user'
     AND CASE WHEN json_valid(tool_metadata)
              THEN json_extract(tool_metadata, '$.source') IN (${HUMAN_SOURCES})
              ELSE 0 END`;

const SESSION_SQL = 'SELECT archive_state FROM chat_sessions WHERE id = ? LIMIT 1';

/** A chat's human follow-up times, or null when this object cannot say (absent or archived). */
function humanMessageTimes(sql: SqlStorage, sessionId: string): number[] | null {
  const session = sql.exec(SESSION_SQL, sessionId).toArray()[0];
  if (!session || session.archive_state === 'source_deleted') return null;
  return sql
    .exec(HUMAN_MESSAGE_TIMES_SQL, sessionId)
    .toArray()
    .flatMap((row) =>
      typeof row.created_at === 'number' && Number.isFinite(row.created_at) ? [row.created_at] : []
    );
}

export function countRunNudges(
  sql: SqlStorage,
  windows: readonly RunNudgeWindow[],
  maxWindows: number
): RunNudgeCounts {
  const cap = Math.max(0, Math.floor(maxWindows));
  const times = new Map<string, number[] | null>();
  const counts = windows.slice(0, cap).map((window) => {
    let chat = times.get(window.sessionId);
    if (chat === undefined) {
      chat = humanMessageTimes(sql, window.sessionId);
      times.set(window.sessionId, chat);
    }
    // `created_at > from` leaves out a prompt that started the run.
    return chat === null
      ? null
      : chat.filter((at) => at > window.fromMs && at <= window.toMs).length;
  });
  return { counts };
}
