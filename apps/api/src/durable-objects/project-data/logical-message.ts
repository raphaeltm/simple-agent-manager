/**
 * One whole message read by any of its stored rows: the full text of a streamed reply, by offset,
 * or an excerpt around a search hit.
 *
 * A search hit or a comment can name any chunk of a reply, so the read starts at that row and walks
 * both ways while rows continue the same run (`logical-transcript-model.ts`). Each side is bounded
 * by `maxRows`; `complete` says whether both ends of the message were reached. A tool run comes back
 * as its metadata-only activity summary, and a thought's text only when the caller asked for it.
 */
import type { ProjectDataArchiveExactReadInput } from '../../project-data-archive/contract';
import { isArchiveReadOutOfTime } from './compact-archive';
import {
  addRunToActivity,
  assembleMessage,
  continuesRun,
  emptyActivity,
  type LogicalActivity,
  type LogicalMessage,
  type Row,
  rowPosition,
  rowRole,
  type Run,
  RUN_ROLES,
  runContent,
  SCAN_PAGE_ROWS,
} from './logical-transcript-model';
import {
  type MessageContextReader,
  sourceTranscriptReader,
  targetTranscriptReader,
} from './message-context';
import type { Env } from './types';

export interface LogicalMessageRequest {
  /** Any stored row of the message. */
  messageId: string;
  /** Rows read each side of the named row, at most. */
  maxRows: number;
  /** First character returned; ignored when `focus` finds a match. */
  offset: number;
  /** Characters returned at most. */
  maxChars: number;
  /** Return an excerpt centred on the first occurrence of any term, instead of reading by offset. */
  focus: { terms: string[] } | null;
  includeThinking: boolean;
  includeToolTitles: boolean;
}

export interface LogicalMessageResult {
  found: boolean;
  message: LogicalMessage | null;
  activity: LogicalActivity | null;
  /** True when a thought was found but its text was not requested. */
  thinkingWithheld: boolean;
  /** `focus` found a term, so `message.offset` starts an excerpt around it. */
  focusMatched: boolean;
}

const NOT_FOUND: LogicalMessageResult = {
  found: false,
  message: null,
  activity: null,
  thinkingWithheld: false,
  focusMatched: false,
};

/** Rows continuing the anchor's run on one side, nearest first, and whether the run ended. */
async function walkRun(
  reader: MessageContextReader,
  anchor: Row,
  side: 'before' | 'after',
  maxRows: number
): Promise<{ rows: Row[]; complete: boolean }> {
  const run: Run = { role: rowRole(anchor), rows: [anchor] };
  const rows: Row[] = [];
  let cursor = rowPosition(anchor);
  while (cursor) {
    const limit = Math.min(SCAN_PAGE_ROWS, maxRows - rows.length);
    if (limit <= 0) return { rows, complete: false };
    let page: Awaited<ReturnType<MessageContextReader['page']>>;
    try {
      page = await reader.page(
        side === 'before' ? { before: cursor, after: null } : { before: null, after: cursor },
        limit,
        side === 'before' ? 'desc' : 'asc'
      );
    } catch (error) {
      // Out of archive read time: the message is returned as read so far, marked incomplete.
      if (!isArchiveReadOutOfTime(error)) throw error;
      return { rows, complete: false };
    }
    const nearestFirst = side === 'before' ? [...page.messages].reverse() : page.messages;
    for (const row of nearestFirst) {
      if (!continuesRun(run, rowRole(row))) return { rows, complete: true };
      rows.push(row);
    }
    if (!page.hasMore) return { rows, complete: true };
    const farthest = nearestFirst[nearestFirst.length - 1];
    cursor = farthest ? rowPosition(farthest) : null;
  }
  return { rows, complete: false };
}

function focusStart(content: string, terms: string[], maxChars: number): number | null {
  const haystack = content.toLowerCase();
  let match = -1;
  for (const term of terms) {
    const index = term ? haystack.indexOf(term.toLowerCase()) : -1;
    if (index >= 0 && (match < 0 || index < match)) match = index;
  }
  if (match < 0) return null;
  return Math.max(0, match - Math.floor(maxChars / 3));
}

/** The whole message containing `request.messageId`, read through `reader`. */
export async function readLogicalMessage(
  reader: MessageContextReader,
  request: LogicalMessageRequest
): Promise<LogicalMessageResult> {
  const anchor = await reader.locate(request.messageId);
  if (!anchor || !rowPosition(anchor)) return NOT_FOUND;
  const maxRows = Math.max(1, Math.floor(request.maxRows));
  const role = rowRole(anchor);
  const [before, after] = RUN_ROLES.has(role)
    ? await Promise.all([
        walkRun(reader, anchor, 'before', maxRows),
        walkRun(reader, anchor, 'after', maxRows),
      ])
    : [
        { rows: [], complete: true },
        { rows: [], complete: true },
      ];
  // Newest first, as `Run` expects.
  const run: Run = { role, rows: [...after.rows.reverse(), anchor, ...before.rows] };
  const complete = before.complete && after.complete;
  if (role === 'tool') {
    const activity = emptyActivity();
    addRunToActivity(activity, run, request.includeToolTitles, new Map());
    activity.complete = complete;
    return { ...NOT_FOUND, found: true, activity };
  }
  if (role === 'thinking' && !request.includeThinking) {
    const withheld = assembleMessage(run, { offset: 0, maxChars: 0 }, complete);
    const message = { ...withheld, truncated: false, nextOffset: null };
    return { ...NOT_FOUND, found: true, message, thinkingWithheld: true };
  }
  // The whole text is built only to search it; a plain read builds just the requested slice.
  const content = request.focus ? runContent(run) : undefined;
  const focused =
    content !== undefined && request.focus
      ? focusStart(content, request.focus.terms, request.maxChars)
      : null;
  const message = assembleMessage(
    run,
    { offset: focused ?? request.offset, maxChars: request.maxChars, content },
    complete
  );
  return { ...NOT_FOUND, found: true, message, focusMatched: focused !== null };
}

/** The message from the root ProjectData object, which still owns the transcript. */
export function readSourceLogicalMessage(
  sql: SqlStorage,
  env: Env,
  owner: ProjectDataArchiveExactReadInput,
  request: LogicalMessageRequest
): Promise<LogicalMessageResult> {
  return readLogicalMessage(
    sourceTranscriptReader(sql, env, owner, true, 'logical message read'),
    request
  );
}

/** The message from an archive shard that holds a sealed copy of the transcript. */
export function readTargetLogicalMessage(
  sql: SqlStorage,
  env: Env,
  owner: ProjectDataArchiveExactReadInput,
  request: LogicalMessageRequest
): Promise<LogicalMessageResult> {
  return readLogicalMessage(
    targetTranscriptReader(sql, env, owner, true, 'logical message read'),
    request
  );
}
