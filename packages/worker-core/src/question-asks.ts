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
 * The newest open blocking question per chat, as attention summaries (what a chat paused on a
 * person shows). Bound to the project in the
 * predicate (rule 11). Never throws: a failed read returns an empty map and logs, because every
 * caller is enriching a read that is still worth serving without the question badge.
 */
export async function readOpenQuestionAttention(
  db: D1Database,
  query: OpenQuestionQuery
): Promise<Map<string, QuestionAttentionSummary>> {
  const bySession = new Map<string, QuestionAttentionSummary>();
  if (query.sessionIds && query.sessionIds.length === 0) return bySession;
  if (query.chats && query.chats.length === 0) return bySession;
  // Every read is bound to a project (rule 11): one, or each chat's own.
  if (!query.projectId && !query.chats) return bySession;
  const limit = query.limit ?? DEFAULT_OPEN_QUESTION_READ_LIMIT;
  const conditions = [
    "kind = 'question'",
    "status = 'open'",
    // Only a blocking question pauses a chat; a non-blocking ask (inbox slice D) lets it work on.
    'blocking = 1',
    'source_session_id IS NOT NULL',
    '(expires_at IS NULL OR expires_at > ?)',
  ];
  const params: unknown[] = [query.now];
  if (query.projectId) {
    conditions.push('project_id = ?');
    params.push(query.projectId);
  }
  if (query.chats) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(?) chat
      WHERE json_extract(chat.value, '$[0]') = asks.project_id
        AND json_extract(chat.value, '$[1]') = asks.source_session_id)`);
    params.push(JSON.stringify(query.chats.map((chat) => [chat.projectId, chat.sessionId])));
  }
  if (query.sessionIds) {
    // json_each keeps any number of chats inside the bound-parameter ceiling (rule 69).
    conditions.push('source_session_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(query.sessionIds));
  }
  if (query.assigneeUserId) {
    conditions.push('assignee_user_id = ?');
    params.push(query.assigneeUserId);
  }
  let rows: Record<string, unknown>[];
  try {
    const result = await db
      .prepare(
        `SELECT id, source_session_id, title, body_md, answer_spec_json, category, created_at,
                expires_at
           FROM asks WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      )
      .bind(...params, limit)
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
    const parsed = questionAttentionFromRow(row);
    if (!parsed) {
      log.warn('question_asks.row_skipped', {
        projectId: query.projectId ?? null,
        askId: text(row.id),
      });
      continue;
    }
    // Newest first, so the first row of a chat is the one it shows.
    if (!bySession.has(parsed.sessionId)) bySession.set(parsed.sessionId, parsed.summary);
  }
  return bySession;
}

/**
 * The attention a chat shows when it holds both a ProjectData marker summary and an open question
 * ask: the newest question for a person, then any other marker. This is `getAttentionSummary`'s
 * rule with both stores taken together (a later `wake_failed` must not hide a question).
 */
export function preferAttention(marker: unknown, question: QuestionAttentionSummary | undefined) {
  if (!question) return marker ?? null;
  if (marker && typeof marker === 'object') {
    const record = marker as Record<string, unknown>;
    if (
      record.kind === 'needs_input' &&
      typeof record.createdAt === 'number' &&
      record.createdAt > question.createdAt
    ) {
      return marker;
    }
  }
  return question;
}

/**
 * Whether the chat has an open, unexpired blocking question from this task (the stalled-task
 * guard): only a blocking question means the agent is waiting on a person.
 */
export async function hasOpenQuestionAsk(
  db: D1Database,
  input: { projectId: string; sessionId: string; taskId: string; now: number }
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS open FROM asks
        WHERE project_id = ? AND source_session_id = ? AND kind = 'question' AND status = 'open'
          AND blocking = 1 AND (source_task_id IS NULL OR source_task_id = ?)
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1`
    )
    .bind(input.projectId, input.sessionId, input.taskId, input.now)
    .first<{ open: number }>();
  return Boolean(row);
}
