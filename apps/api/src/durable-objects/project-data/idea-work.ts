/**
 * One batched read of the work linked to many ideas at once.
 *
 * The Ideas list derives every row's state from the chats linked to it, so it needs this for
 * the whole page. Asking per idea — which is what the single-idea link read does — would cost
 * one Durable Object round trip per idea and blow the list's I/O budget (rule 60), so this
 * answers for N ideas in a fixed handful of queries instead.
 *
 * Reads are fault-isolated per row (rule 50): one malformed row is skipped and logged, never
 * turned into a failed list for the whole project.
 */
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { createModuleLogger } from '../../lib/logger';
import { parseIdeaNeedsInputRow, parseIdeaWorkSessionRow } from './row-schemas';

const log = createModuleLogger('idea-work');

/**
 * The platform's bound-parameter ceiling covers the whole statement, not just the `IN (…)`
 * list: the needs-input query also binds the attention kind and the current time. The margin
 * is wider than those two so another predicate can be added without crossing the ceiling.
 */
const RESERVED_BIND_PARAMETERS = 4;
const MAX_IDS_PER_QUERY = D1_MAX_BOUND_PARAMETERS - RESERVED_BIND_PARAMETERS;

/**
 * The attention-marker kind that means "an agent asked a person something and nobody has
 * answered". Written by `request_human_input` (`routes/mcp/human-input-tool.ts`), by a pending
 * ACP interaction, and by the reconciliation episode.
 */
export const IDEA_NEEDS_INPUT_MARKER_KIND = 'needs_input';

export interface IdeaWorkSessionRow {
  sessionId: string;
  topic: string | null;
  /** The chat session's own status. */
  sessionStatus: string;
  /** The task driving the chat, when it has one. */
  sessionTaskId: string | null;
  /** Epoch ms of the chat's last update. */
  lastActivityAt: number | null;
  linkedAt: number;
}

export interface IdeaNeedsInputRow {
  sessionId: string;
  question: string | null;
  askedAt: number;
}

export interface IdeaWorkSnapshot {
  ideaId: string;
  sessions: IdeaWorkSessionRow[];
  needsInput: IdeaNeedsInputRow[];
}

/**
 * The work linked to each of `ideaIds`, keyed by idea id. Ideas with no linked work get an
 * entry with empty lists, so a caller never has to distinguish "absent" from "nothing yet".
 */
export function getIdeaWorkSnapshots(
  sql: SqlStorage,
  ideaIds: readonly string[],
  now: number = Date.now()
): Record<string, IdeaWorkSnapshot> {
  const snapshots: Record<string, IdeaWorkSnapshot> = {};
  const unique = [...new Set(ideaIds.filter((id) => typeof id === 'string' && id.length > 0))];
  for (const ideaId of unique) {
    snapshots[ideaId] = { ideaId, sessions: [], needsInput: [] };
  }
  if (unique.length === 0) return snapshots;

  for (const ids of chunk(unique, MAX_IDS_PER_QUERY)) {
    const placeholders = ids.map(() => '?').join(', ');

    // The chats linked to these ideas, with the task driving each one.
    const sessionRows = sql
      .exec(
        `SELECT csi.task_id AS idea_id, cs.id AS session_id, cs.topic, cs.status,
                cs.task_id AS session_task_id, cs.updated_at, csi.created_at AS linked_at
           FROM chat_session_ideas csi
           JOIN chat_sessions cs ON cs.id = csi.session_id
          WHERE csi.task_id IN (${placeholders})
          ORDER BY cs.updated_at DESC`,
        ...ids
      )
      .toArray();
    for (const row of sessionRows) {
      try {
        const parsed = parseIdeaWorkSessionRow(row);
        snapshots[parsed.ideaId]?.sessions.push({
          sessionId: parsed.sessionId,
          topic: parsed.topic,
          sessionStatus: parsed.sessionStatus,
          sessionTaskId: parsed.sessionTaskId,
          lastActivityAt: parsed.lastActivityAt,
          linkedAt: parsed.linkedAt,
        });
      } catch (error) {
        log.warn('idea_work.session_row_skipped', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Unanswered questions on those chats. Scoped to the ideas asked for, so one project's
    // unrelated attention markers never reach this read.
    const markerRows = sql
      .exec(
        `SELECT csi.task_id AS idea_id, sam.session_id, sam.reason, sam.created_at
           FROM session_attention_markers sam
           JOIN chat_session_ideas csi ON csi.session_id = sam.session_id
          WHERE csi.task_id IN (${placeholders})
            AND sam.kind = ?
            AND sam.resolved_at IS NULL
            AND (sam.expires_at IS NULL OR sam.expires_at > ?)
          ORDER BY sam.created_at DESC`,
        ...ids,
        IDEA_NEEDS_INPUT_MARKER_KIND,
        now
      )
      .toArray();
    for (const row of markerRows) {
      try {
        const parsed = parseIdeaNeedsInputRow(row);
        snapshots[parsed.ideaId]?.needsInput.push({
          sessionId: parsed.sessionId,
          question: parsed.question,
          askedAt: parsed.askedAt,
        });
      } catch (error) {
        log.warn('idea_work.needs_input_row_skipped', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return snapshots;
}
