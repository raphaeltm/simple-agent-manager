/**
 * Transcript pages counted in whole messages, not stored rows.
 *
 * A reader paging stored rows sees a long reply cut into fragments at every page edge, and a role
 * filter applied after the read can return an empty page while consuming the whole row budget.
 * This module reads rows inside the object that owns the transcript, where extra pages cost no
 * network round trip, and returns:
 *
 * - each included message assembled from its chunks, with a stable `messageId` (its first row), a
 *   bounded content prefix and its full length, so the rest can be read by offset;
 * - everything between two included messages (tool calls, thoughts, plans, filtered roles) folded
 *   into one bounded `activity` summary (`logical-transcript-model.ts`);
 * - a cursor that always sits on a message boundary, so the next page starts exactly where this one
 *   stopped, with no duplicated or missing chunk.
 */
import type { MessageCursor, MessagePosition } from '@simple-agent-manager/shared';

import type { ProjectDataArchiveExactReadInput } from '../../project-data-archive/contract';
import {
  addRunToActivity,
  assembleMessage,
  continuesRun,
  emptyActivity,
  type LogicalActivity,
  type LogicalEntry,
  type LogicalMessage,
  rowPosition,
  rowRole,
  type Run,
  RUN_ROLES,
  SCAN_PAGE_ROWS,
  type ToolCallStates,
} from './logical-transcript-model';
import {
  type MessageContextReader,
  sourceTranscriptReader,
  targetTranscriptReader,
} from './message-context';
import type { Env } from './types';

export type { LogicalActivity, LogicalEntry, LogicalMessage } from './logical-transcript-model';

export interface LogicalTranscriptRequest {
  /** Exclusive bound: the page holds messages older than this position. */
  before: MessageCursor | null;
  /** Included messages to return at most. Activity summaries do not count. */
  limit: number;
  /** Roles returned as messages. Tool runs are always summarized as activity. */
  roles: string[];
  /** Stored rows examined at most, across all pages of the scan. */
  maxScanRows: number;
  /** Content characters returned per message; the rest is read by offset. */
  maxMessageChars: number;
  /** Content characters returned per page, across messages. */
  maxPageChars: number;
  /** Report the newest user and assistant messages, scanning past a full page if needed. */
  includeLatest: boolean;
  /** Include bounded tool-call titles in activity summaries (they can contain command text). */
  includeToolTitles: boolean;
}

export interface LogicalTranscriptResult {
  /** Newest first. */
  entries: LogicalEntry[];
  /** Position to pass as `before` for the next (older) page; null at the transcript start. */
  nextCursor: MessagePosition | null;
  hasMore: boolean;
  scannedRows: number;
  /** The row budget ended the page before `limit` messages were found. */
  scanBudgetExhausted: boolean;
  latest: {
    assistant: LogicalMessage | null;
    user: LogicalMessage | null;
    /** The scan budget ended before a user message was found. */
    userSearchExhausted: boolean;
  } | null;
}

interface ScanState {
  entries: LogicalEntry[];
  messages: number;
  pageChars: number;
  /** Position of the oldest committed entry's first row: where the next page starts. */
  resumeAt: MessagePosition | null;
  /** Activity read since the last committed entry; committed only before an older message. */
  pending: LogicalActivity | null;
  pendingStart: MessagePosition | null;
  calls: ToolCallStates;
  pageFull: boolean;
  latest: { assistant: LogicalMessage | null; user: LogicalMessage | null } | null;
}

function commitPending(state: ScanState): void {
  if (state.pending && state.pending.rowCount > 0) {
    state.entries.push(state.pending);
    state.resumeAt = state.pendingStart;
  }
  state.pending = null;
  state.pendingStart = null;
  state.calls = new Map();
}

/** True while a full page still needs to find the newest user message. */
function stillSearchingLatest(state: ScanState): boolean {
  return !!state.latest && !state.latest.user;
}

function prefix(request: LogicalTranscriptRequest) {
  return { offset: 0, maxChars: request.maxMessageChars };
}

/** Closes a run whose first row has been read. Returns false once the scan should stop. */
function closeRun(
  state: ScanState,
  run: Run,
  request: LogicalTranscriptRequest,
  included: ReadonlySet<string>,
  limit: number
): boolean {
  const start = rowPosition(run.rows[run.rows.length - 1] ?? {});
  if (state.latest) {
    if (!state.latest.assistant && run.role === 'assistant') {
      state.latest.assistant = assembleMessage(run, prefix(request), true);
    }
    if (!state.latest.user && run.role === 'user') {
      state.latest.user = assembleMessage(run, prefix(request), true);
    }
  }
  if (state.pageFull) return stillSearchingLatest(state);
  if (!included.has(run.role)) {
    state.pending ??= emptyActivity();
    addRunToActivity(state.pending, run, request.includeToolTitles, state.calls);
    state.pendingStart = start;
    return true;
  }
  const message = assembleMessage(run, prefix(request), true);
  if (state.messages > 0 && state.pageChars + message.content.length > request.maxPageChars) {
    // Leave it for the next page, which starts after the last committed entry.
    state.pageFull = true;
    return stillSearchingLatest(state);
  }
  commitPending(state);
  state.entries.push(message);
  state.messages += 1;
  state.pageChars += message.content.length;
  state.resumeAt = start;
  if (state.messages >= limit) state.pageFull = true;
  return !state.pageFull || stillSearchingLatest(state);
}

/**
 * The budget ended before any entry was committed. Report the span read so far so the caller still
 * advances: the closed activity first, otherwise the open run as an incomplete entry.
 */
function commitPartialSpan(
  state: ScanState,
  open: Run | null,
  request: LogicalTranscriptRequest,
  included: ReadonlySet<string>
): MessagePosition | null {
  if (state.pending && state.pending.rowCount > 0) {
    commitPending(state);
    return state.resumeAt;
  }
  if (!open) return null;
  if (included.has(open.role)) {
    state.entries.push(assembleMessage(open, prefix(request), false));
  } else {
    const activity = emptyActivity();
    addRunToActivity(activity, open, request.includeToolTitles, new Map());
    activity.complete = false;
    state.entries.push(activity);
  }
  return rowPosition(open.rows[open.rows.length - 1] ?? {});
}

/**
 * Whether the row the `before` cursor names carries on the run the page starts with. Only a cursor
 * from the old stored-row paging can point inside a run; a logical cursor sits on a run's first row.
 */
async function cursorContinuesRun(
  reader: MessageContextReader,
  before: MessageCursor | null,
  newestRole: string
): Promise<boolean> {
  if (before === null || typeof before === 'number' || !RUN_ROLES.has(newestRole)) return false;
  const cursorRow = await reader.locate(before.id);
  return cursorRow !== null && rowRole(cursorRow) === newestRole;
}

/** One page of whole messages, newest first, read through `reader`. */
export async function readLogicalTranscriptPage(
  reader: MessageContextReader,
  request: LogicalTranscriptRequest
): Promise<LogicalTranscriptResult> {
  const included: ReadonlySet<string> = new Set(request.roles.filter((role) => role !== 'tool'));
  const limit = Math.max(1, Math.floor(request.limit));
  const maxScanRows = Math.max(1, Math.floor(request.maxScanRows));
  const state: ScanState = {
    entries: [],
    messages: 0,
    pageChars: 0,
    resumeAt: null,
    pending: null,
    pendingStart: null,
    calls: new Map(),
    pageFull: false,
    latest:
      request.includeLatest && request.before === null ? { assistant: null, user: null } : null,
  };
  let open: Run | null = null;
  let scanned = 0;
  let cursor = request.before;
  let exhausted = false;
  let reachedStart = false;
  /** Role of the newest row read: the newest entry's newest run, whatever its kind. */
  let newestRole: string | null = null;

  scan: for (;;) {
    const pageLimit = Math.min(SCAN_PAGE_ROWS, maxScanRows - scanned);
    if (pageLimit <= 0) {
      exhausted = true;
      break;
    }
    const page = await reader.page({ before: cursor, after: null }, pageLimit, 'desc');
    const newestFirst = [...page.messages].reverse();
    for (const row of newestFirst) {
      scanned += 1;
      const role = rowRole(row);
      newestRole ??= role;
      if (open && continuesRun(open, role)) {
        open.rows.push(row);
        continue;
      }
      if (open && !closeRun(state, open, request, included, limit)) {
        open = null;
        break scan;
      }
      open = { role, rows: [row] };
    }
    if (!page.hasMore) {
      reachedStart = true;
      break;
    }
    const oldest = newestFirst[newestFirst.length - 1];
    const next = oldest ? rowPosition(oldest) : null;
    // A page of unreadable rows cannot advance the scan; report what was read.
    if (!next) {
      exhausted = true;
      break;
    }
    cursor = next;
  }

  if (open && reachedStart) {
    closeRun(state, open, request, included, limit);
    open = null;
  }

  let nextCursor: MessagePosition | null;
  if (reachedStart && !state.pageFull) {
    commitPending(state);
    nextCursor = null;
  } else if (!state.pageFull && state.entries.length === 0) {
    nextCursor = commitPartialSpan(state, open, request, included);
  } else {
    nextCursor = state.resumeAt;
  }

  const newest = state.entries[0];
  if (newest && newestRole !== null) {
    newest.continuesInNewerPage = await cursorContinuesRun(reader, request.before, newestRole);
  }

  return {
    entries: state.entries,
    nextCursor,
    hasMore: nextCursor !== null,
    scannedRows: scanned,
    scanBudgetExhausted: exhausted && !state.pageFull,
    latest: state.latest
      ? { ...state.latest, userSearchExhausted: !state.latest.user && !reachedStart }
      : null,
  };
}

/** A page from the root ProjectData object, which still owns the transcript. */
export function readSourceLogicalTranscript(
  sql: SqlStorage,
  env: Env,
  owner: ProjectDataArchiveExactReadInput,
  request: LogicalTranscriptRequest
): Promise<LogicalTranscriptResult> {
  return readLogicalTranscriptPage(
    sourceTranscriptReader(sql, env, owner, true, 'logical transcript read'),
    request
  );
}

/** A page from an archive shard that holds a sealed copy of the transcript. */
export function readTargetLogicalTranscript(
  sql: SqlStorage,
  env: Env,
  owner: ProjectDataArchiveExactReadInput,
  request: LogicalTranscriptRequest
): Promise<LogicalTranscriptResult> {
  return readLogicalTranscriptPage(
    targetTranscriptReader(sql, env, owner, true, 'logical transcript read'),
    request
  );
}
