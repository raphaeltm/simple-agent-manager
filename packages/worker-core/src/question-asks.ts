/**
 * Open questions held in D1 `asks` (inbox slice G, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9).
 *
 * A question an agent asks with `request_human_input` is one `asks` row (kind `question`). The
 * readers that used to find it as a ProjectData attention marker (the chat list, a chat's
 * attention, the ProjectData session reads, the stalled-task guard) read it here, in the shape
 * the marker summary had (`getAttentionSummary`, `packages/project-data/src/do/attention.ts`), so
 * their consumers see no difference. One home for the record; this module only reads it.
 */
import { createModuleLogger } from './logger';
import { maybeJsonRecord } from './runtime-validation';

const log = createModuleLogger('question_asks');

/** The `source` a question ask reports in an attention summary, as its marker did. */
export const QUESTION_ASK_SOURCE = 'request_human_input';

/** The attention summary shape (`getAttentionSummary`), for an open question ask. */
export interface QuestionAttentionSummary {
  markerId: string;
  kind: 'needs_input';
  source: typeof QUESTION_ASK_SOURCE;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
  options: string[];
  category: string | null;
  interactionId: null;
  interactionKind: null;
}

/**
 * A failed chat wake (inbox slice E): an open `asks` row of kind `error` with dedupe key
 * `error:wake:<sessionId>`, read in the shape the `wake_failed` attention marker summary had, so
 * the chat list's "Wake failed" state needs no client change. There is no marker any more.
 */
export const WAKE_FAILED_ASK_SOURCE = 'session_wake';
export const WAKE_FAILED_KEY_PREFIX = 'error:wake:';
/**
 * Open wake-failure items, as an index-seekable key range (a prefix `LIKE` is not, on a BINARY
 * column). Identical to the WHERE of `idx_asks_open_wake_error` (migration 0248), which is what
 * lets SQLite use that partial index; keep the two in step. `alias` is the asks table alias.
 */
export function openWakeErrorPredicate(alias: string): string {
  const a = alias ? `${alias}.` : '';
  return `${a}kind = 'error' AND ${a}status = 'open' AND ${a}dedupe_key >= 'error:wake:' AND ${a}dedupe_key < 'error:wake;'`;
}

export interface WakeFailedAttentionSummary {
  markerId: string;
  kind: 'wake_failed';
  source: typeof WAKE_FAILED_ASK_SOURCE;
  createdAt: number;
  expiresAt: null;
  reason: string | null;
  options: string[];
  category: null;
  interactionId: null;
  interactionKind: null;
}

/** What a chat shows from `asks`: its newest open question, else its open wake failure. */
export type AskAttentionSummary = QuestionAttentionSummary | WakeFailedAttentionSummary;

export interface OpenQuestionQuery {
  /** One project; or `chats` across projects. */
  projectId?: string;
  /** Only these chats; omit for every chat of the project. */
  sessionIds?: readonly string[];
  /** Chats of several projects, each bound to its own project (cross-project lists). */
  chats?: ReadonlyArray<{ projectId: string; sessionId: string }>;
  /** Only questions addressed to this person (the chat's creator). */
  assigneeUserId?: string | null;
  now: number;
  /** Rows read at most; open questions are bounded by expiry and the per-chat cap. */
  limit?: number;
}

/** Open questions live at most a day and a chat holds at most `inbox.openItemsPerChat`. */
export const DEFAULT_OPEN_QUESTION_READ_LIMIT = 500;

/** The options of a question's answer spec (`{type:'options', options}`), or none. */
export function questionOptions(answerSpecJson: unknown): string[] {
  if (typeof answerSpecJson !== 'string' || !answerSpecJson) return [];
  try {
    const record = maybeJsonRecord(JSON.parse(answerSpecJson) as unknown);
    if (!record || record.type !== 'options' || !Array.isArray(record.options)) return [];
    return record.options.filter((option): option is string => typeof option === 'string');
  } catch {
    return [];
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** One `asks` row as an attention summary, or null when it cannot be read (rule 50). */
export function questionAttentionFromRow(row: Record<string, unknown>): {
  sessionId: string;
  summary: QuestionAttentionSummary;
} | null {
  const id = text(row.id);
  const sessionId = text(row.source_session_id);
  const createdAt = int(row.created_at);
  if (!id || !sessionId || createdAt === null) return null;
  return {
    sessionId,
    summary: {
      markerId: id,
      kind: 'needs_input',
      source: QUESTION_ASK_SOURCE,
      createdAt,
      expiresAt: int(row.expires_at),
      reason: text(row.body_md) ?? text(row.title),
      options: questionOptions(row.answer_spec_json),
      category: text(row.category),
      interactionId: null,
      interactionKind: null,
    },
  };
}

/**
 * The newest open question per chat, as attention summaries. Bound to the project in the
 * predicate (rule 11). Never throws: a failed read returns an empty map and logs, because every
 * caller is enriching a read that is still worth serving without the question badge.
 */
export async function readOpenQuestionAttention(
  db: D1Database,
  query: OpenQuestionQuery
): Promise<Map<string, AskAttentionSummary>> {
  const bySession = new Map<string, AskAttentionSummary>();
  if (query.sessionIds && query.sessionIds.length === 0) return bySession;
  if (query.chats && query.chats.length === 0) return bySession;
  // Every read is bound to a project (rule 11): one, or each chat's own.
  if (!query.projectId && !query.chats) return bySession;
  const limit = query.limit ?? DEFAULT_OPEN_QUESTION_READ_LIMIT;
  // The chat scope both arms share.
  const scope: string[] = ['source_session_id IS NOT NULL'];
  const scopeParams: unknown[] = [];
  if (query.projectId) {
    scope.push('project_id = ?');
    scopeParams.push(query.projectId);
  }
  if (query.chats) {
    scope.push(`EXISTS (SELECT 1 FROM json_each(?) chat
      WHERE json_extract(chat.value, '$[0]') = asks.project_id
        AND json_extract(chat.value, '$[1]') = asks.source_session_id)`);
    scopeParams.push(JSON.stringify(query.chats.map((chat) => [chat.projectId, chat.sessionId])));
  }
  if (query.sessionIds) {
    // json_each keeps any number of chats inside the bound-parameter ceiling (rule 69).
    scope.push('source_session_id IN (SELECT value FROM json_each(?))');
    scopeParams.push(JSON.stringify(query.sessionIds));
  }
  if (query.assigneeUserId) {
    scope.push('assignee_user_id = ?');
    scopeParams.push(query.assigneeUserId);
  }
  const columns = `id, kind, source_session_id, title, body_md, answer_spec_json, category,
                created_at, expires_at`;
  let rows: Record<string, unknown>[];
  try {
    // Two indexed arms in one round trip: open questions (`idx_asks_open_question`) and open
    // wake failures (`idx_asks_open_wake_error`). Questions sort first, so a chat's first
    // row is its newest question when it has one.
    const result = await db
      .prepare(
        `SELECT * FROM (
           SELECT 0 AS rank, ${columns} FROM asks
            WHERE kind = 'question' AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
              AND ${scope.join(' AND ')}
           UNION ALL
           SELECT 1 AS rank, ${columns} FROM asks
            WHERE ${openWakeErrorPredicate('')}
              AND ${scope.join(' AND ')}
         ) ORDER BY rank, created_at DESC, id DESC
         LIMIT ?`
      )
      .bind(query.now, ...scopeParams, ...scopeParams, limit)
      .all<Record<string, unknown>>();
    rows = result.results ?? [];
  } catch (error) {
    log.warn('question_asks.read_failed', {
      projectId: query.projectId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return bySession;
  }
  if (rows.length >= limit) {
    log.warn('question_asks.read_limit_reached', { projectId: query.projectId ?? null, limit });
  }
  for (const row of rows) {
    const parsed =
      row.kind === 'error' ? wakeFailedAttentionFromRow(row) : questionAttentionFromRow(row);
    if (!parsed) {
      log.warn('question_asks.row_skipped', {
        projectId: query.projectId ?? null,
        askId: text(row.id),
      });
      continue;
    }
    if (!bySession.has(parsed.sessionId)) bySession.set(parsed.sessionId, parsed.summary);
  }
  return bySession;
}

/** One open wake-failure `asks` row as an attention summary, or null (rule 50). */
export function wakeFailedAttentionFromRow(row: Record<string, unknown>): {
  sessionId: string;
  summary: WakeFailedAttentionSummary;
} | null {
  const id = text(row.id);
  const sessionId = text(row.source_session_id);
  const createdAt = int(row.created_at);
  if (!id || !sessionId || createdAt === null) return null;
  return {
    sessionId,
    summary: {
      markerId: id,
      kind: 'wake_failed',
      source: WAKE_FAILED_ASK_SOURCE,
      createdAt,
      expiresAt: null,
      reason: text(row.body_md) ?? text(row.title),
      options: [],
      category: null,
      interactionId: null,
      interactionKind: null,
    },
  };
}

/**
 * The attention a chat shows when it holds both a ProjectData marker summary and an open question
 * ask: the newest question for a person, then any other marker. This is `getAttentionSummary`'s
 * rule with both stores taken together (a later `wake_failed` must not hide a question).
 */
export function preferAttention(marker: unknown, ask: AskAttentionSummary | undefined) {
  if (!ask) return marker ?? null;
  const record = marker && typeof marker === 'object' ? (marker as Record<string, unknown>) : null;
  if (record) {
    const markerCreatedAt = typeof record.createdAt === 'number' ? record.createdAt : null;
    if (record.kind === 'needs_input') {
      // A pending question or permission beats a wake failure, and a newer one beats a question.
      if (ask.kind !== 'needs_input') return marker;
      if (markerCreatedAt !== null && markerCreatedAt > ask.createdAt) return marker;
    } else if (
      ask.kind !== 'needs_input' &&
      markerCreatedAt !== null &&
      markerCreatedAt > ask.createdAt
    ) {
      // Neither is a question: the newest wins, as in `getAttentionSummary`.
      return marker;
    }
  }
  return ask;
}

/** Whether the chat has an open, unexpired question from this task (the stalled-task guard). */
export async function hasOpenQuestionAsk(
  db: D1Database,
  input: { projectId: string; sessionId: string; taskId: string; now: number }
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS open FROM asks
        WHERE project_id = ? AND source_session_id = ? AND kind = 'question' AND status = 'open'
          AND (source_task_id IS NULL OR source_task_id = ?)
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1`
    )
    .bind(input.projectId, input.sessionId, input.taskId, input.now)
    .first<{ open: number }>();
  return Boolean(row);
}
