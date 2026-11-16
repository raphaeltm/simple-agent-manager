/**
 * The ProjectData half of a run receipt (Insights slice R, `runReceipt` in
 * `packages/operations/src/insights-receipt.ts`): what only this object knows about one chat
 * during one run window. One RPC, every read bounded, aggregation done inside SQLite so memory
 * does not grow with the session (`.claude/rules/69`, memory ceiling).
 *
 * - Tool calls by kind: `chat_messages.tool_metadata` holds the ACP tool call
 *   (`{toolCallId, kind, status, toolName}`, `vm-agent/internal/messagereport`). A call is
 *   persisted more than once as it updates, so calls are counted by distinct `toolCallId`.
 *   The scan reads at most `messageScanMaxRows` messages and says when it stopped early.
 * - Waiting on a person: `session_attention_markers` of kind `needs_input` (the agent asked
 *   a question, `request_human_input`), from creation to resolution. Resolved markers are kept.
 * - The time of the agent's last message, which ends its work and starts any CI wait.
 * - The chat's ACP sessions, newest first: the canonical link from a chat to its
 *   `agent_sessions` rows (`acp_sessions.chat_session_id`).
 */
import type {
  RunReceiptFacts,
  RunReceiptFactsInput,
  RunReceiptToolKindCount,
  RunReceiptWaitingInterval,
} from '@simple-agent-manager/shared';

const ACP_SESSION_LIMIT = 10;

/**
 * One pass over the window's messages in time order, capped by messages READ, not by tool rows
 * matched, so a long chat with few tool calls costs at most the cap (served by
 * idx_chat_messages_session_seq). The CTE is materialized once, holding only each message's
 * kind and call id (never its metadata, so memory does not grow with payload size), and feeds
 * both the per-kind counts and the count of messages read. `json_valid` guards every `json_extract`: one malformed
 * row would otherwise raise "malformed JSON" and fail the whole read (`.claude/rules/50`).
 * MAX(kind) makes a call whose rows disagree on kind count once, deterministically. Bind: session,
 * from, to, cap + 1 (the extra row only tells us the cap was reached), cap (rows counted).
 */
const TOOL_KIND_SQL = `
  WITH w AS MATERIALIZED (
    SELECT created_at, sequence,
      CASE WHEN role = 'tool' THEN COALESCE(
        CASE WHEN json_valid(tool_metadata) THEN json_extract(tool_metadata, '$.kind') END,
        'other') END AS kind,
      CASE WHEN role = 'tool' THEN COALESCE(
        CASE WHEN json_valid(tool_metadata) THEN json_extract(tool_metadata, '$.toolCallId') END,
        id) END AS call_id
      FROM chat_messages
     WHERE session_id = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at, sequence
     LIMIT ?
  ),
  counted AS (SELECT kind, call_id FROM w ORDER BY created_at, sequence LIMIT ?)
  SELECT kind, COUNT(*) AS calls, NULL AS examined FROM (
    SELECT MAX(kind) AS kind FROM counted WHERE call_id IS NOT NULL GROUP BY call_id
  ) GROUP BY kind
  UNION ALL
  SELECT NULL, NULL, COUNT(*) FROM w`;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getRunReceiptFacts(sql: SqlStorage, input: RunReceiptFactsInput): RunReceiptFacts {
  const toMs = input.toMs ?? Date.now();
  const empty: RunReceiptFacts = {
    sessionFound: false,
    messagesArchived: false,
    acpSessionIds: [],
    toolCalls: { byKind: [], total: 0, examinedMessages: 0, scanLimited: false },
    waitingIntervals: [],
    waitingLimited: false,
    lastAgentMessageAt: null,
    lastMessageAt: null,
  };

  const session = sql
    .exec('SELECT id, archive_state FROM chat_sessions WHERE id = ? LIMIT 1', input.sessionId)
    .toArray()[0];
  if (!session) return empty;

  const messagesArchived = session.archive_state === 'source_deleted';
  const scanCap = Math.max(1, Math.floor(input.messageScanMaxRows));

  const byKind: RunReceiptToolKindCount[] = [];
  let total = 0;
  let examined = 0;
  if (!messagesArchived) {
    for (const row of sql
      .exec(TOOL_KIND_SQL, input.sessionId, input.fromMs, toMs, scanCap + 1, scanCap)
      .toArray()) {
      if (row.kind === null && row.calls === null) {
        examined = numberOrNull(row.examined) ?? 0;
        continue;
      }
      const count = numberOrNull(row.calls);
      if (count === null || count <= 0) continue;
      const kind = typeof row.kind === 'string' && row.kind.length > 0 ? row.kind : 'other';
      byKind.push({ kind: kind.slice(0, 40), count });
      total += count;
    }
    byKind.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }

  const waitingCap = Math.max(1, Math.floor(input.waitingMaxIntervals));
  const waitingRows = sql
    .exec(
      `SELECT created_at, resolved_at, reason FROM session_attention_markers
        WHERE session_id = ? AND kind = 'needs_input'
          AND created_at <= ? AND (resolved_at IS NULL OR resolved_at >= ?)
        ORDER BY created_at, id
        LIMIT ?`,
      input.sessionId,
      toMs,
      input.fromMs,
      waitingCap + 1
    )
    .toArray();
  const waitingIntervals: RunReceiptWaitingInterval[] = [];
  for (const row of waitingRows.slice(0, waitingCap)) {
    const startMs = numberOrNull(row.created_at);
    if (startMs === null) continue; // a malformed marker costs that marker, not the receipt
    waitingIntervals.push({
      startMs,
      endMs: numberOrNull(row.resolved_at),
      reason: typeof row.reason === 'string' ? row.reason : null,
    });
  }

  const times = sql
    .exec(
      `SELECT
         (SELECT MAX(created_at) FROM chat_messages
           WHERE session_id = ? AND role IN ('assistant', 'tool')
             AND created_at >= ? AND created_at <= ?) AS last_agent,
         (SELECT MAX(created_at) FROM chat_messages
           WHERE session_id = ? AND created_at >= ? AND created_at <= ?) AS last_message`,
      input.sessionId,
      input.fromMs,
      toMs,
      input.sessionId,
      input.fromMs,
      toMs
    )
    .toArray()[0];

  const acpSessionIds = sql
    .exec(
      `SELECT id FROM acp_sessions WHERE chat_session_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      input.sessionId,
      ACP_SESSION_LIMIT
    )
    .toArray()
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return {
    sessionFound: true,
    messagesArchived,
    acpSessionIds,
    toolCalls: {
      byKind,
      total,
      examinedMessages: Math.min(examined, scanCap),
      scanLimited: examined > scanCap,
    },
    waitingIntervals,
    waitingLimited: waitingRows.length > waitingCap,
    lastAgentMessageAt: numberOrNull(times?.last_agent),
    lastMessageAt: numberOrNull(times?.last_message),
  };
}
