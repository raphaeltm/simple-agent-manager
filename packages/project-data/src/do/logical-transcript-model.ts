/**
 * Shapes and run helpers for reading a transcript as whole messages (`logical-transcript.ts`,
 * `logical-message.ts`).
 *
 * The VM agent stores an agent reply (and a thought) as one row per streamed chunk, and each tool
 * call as several rows (the call and its status updates). Run boundaries follow the chat's own
 * rule (`RUN_ROLES` below, shared with `message-context.ts`): consecutive rows of one of those roles
 * are one message; any other row is a message on its own.
 *
 * Tool runs are only ever summarized from tool metadata (call ids, kinds, statuses, tool names, and
 * titles when the caller asked for them). Tool output and command text never leave this module.
 */
import { MERGED_MESSAGE_ROLES, type MessagePosition } from '@simple-agent-manager/shared';

/** Distinct tool names (and titles, when requested) kept per activity summary. */
const ACTIVITY_LIST_CAP = 8;
const ACTIVITY_TEXT_MAX = 120;

/** Rows per page read inside a bounded transcript scan; each reader's own row budget caps the total. */
export const SCAN_PAGE_ROWS = 250;

/**
 * Roles whose consecutive rows display as one item: an agent reply or thought merged from its
 * streamed chunks (`MERGED_MESSAGE_ROLES`, which must stay the chat's text-merge rule), and a
 * run of tool rows, which the chat shows as one tool-call group. Every whole-message reader
 * (`message-context.ts`, `logical-transcript.ts`, `logical-message.ts`) uses this one rule.
 */
export const RUN_ROLES: ReadonlySet<string> = new Set([...MERGED_MESSAGE_ROLES, 'tool']);

export interface LogicalActivity {
  kind: 'activity';
  /** First stored row of the summarized span. */
  firstRowId: string;
  /** Exact position of that row: `before` for a page that starts just older than this entry. */
  start: MessagePosition | null;
  rowCount: number;
  toolCalls: number;
  toolStatuses: Record<string, number>;
  toolKinds: Record<string, number>;
  toolNames: string[];
  toolTitles?: string[];
  /** Thinking messages hidden from this page. */
  thinkingMessages: number;
  planUpdates: number;
  /** Other messages left out by the role filter, by role. */
  otherMessages: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  /** False when the scan budget ended before the span's oldest row was read. */
  complete: boolean;
  /**
   * True when the span continues into the newer page (a cursor that ends mid-span: legacy cursors,
   * or one from a read that ran out of time); null when that could not be checked in time.
   */
  continuesInNewerPage: boolean | null;
}

export interface LogicalMessage {
  kind: 'message';
  /** First stored row of the message: stable while the message is still streaming. */
  messageId: string;
  /** Exact position of that row: `before` for a page that starts just older than this entry. */
  start: MessagePosition | null;
  lastRowId: string;
  role: string;
  /** `system` marks a user-role prompt SAM injected; anything else was typed by a person. */
  origin: string | null;
  /** The returned slice of the message, starting at `offset`. */
  content: string;
  offset: number;
  contentLength: number;
  /** More content exists after the returned slice; read it from `nextOffset`. */
  truncated: boolean;
  nextOffset: number | null;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
  /** False when a row budget ended before the whole message was read. */
  complete: boolean;
  /**
   * True when the message continues into the newer page (a cursor that ends mid-message: legacy
   * cursors, or one from a read that ran out of time); null when that could not be checked in time.
   */
  continuesInNewerPage: boolean | null;
}

export type LogicalEntry = LogicalMessage | LogicalActivity;

export type Row = Record<string, unknown>;

export interface Run {
  role: string;
  /** Newest first, as scanned. */
  rows: Row[];
}

export function rowRole(row: Row): string {
  return typeof row.role === 'string' ? row.role : 'unknown';
}

export function rowPosition(row: Row): MessagePosition | null {
  const { createdAt, sequence, id } = row;
  if (typeof createdAt !== 'number' || typeof sequence !== 'number' || typeof id !== 'string') {
    return null;
  }
  return { createdAt, sequence, id };
}

function rowTime(row: Row): number {
  return typeof row.createdAt === 'number' ? row.createdAt : 0;
}

function rowId(row: Row): string {
  return typeof row.id === 'string' ? row.id : '';
}

/** Whether a row of `role` read after `run` is another chunk of the same message. */
export function continuesRun(run: Run, role: string): boolean {
  return run.role === role && RUN_ROLES.has(role);
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > ACTIVITY_TEXT_MAX ? `${text.slice(0, ACTIVITY_TEXT_MAX - 1)}…` : text;
}

function pushDistinct(list: string[], value: string | null): void {
  if (value && list.length < ACTIVITY_LIST_CAP && !list.includes(value)) list.push(value);
}

function toolMetadata(row: Row): Record<string, unknown> {
  const meta = row.toolMetadata;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

export function emptyActivity(): LogicalActivity {
  return {
    kind: 'activity',
    firstRowId: '',
    start: null,
    rowCount: 0,
    toolCalls: 0,
    toolStatuses: {},
    toolKinds: {},
    toolNames: [],
    thinkingMessages: 0,
    planUpdates: 0,
    otherMessages: {},
    createdAt: 0,
    updatedAt: 0,
    complete: true,
    continuesInNewerPage: false,
  };
}

/** What one activity summary knows about each tool call it has seen, newest row first. */
export type ToolCallStates = Map<string, { status: string | null; kind: string | null }>;

function countBy(states: ToolCallStates, field: 'status' | 'kind'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of states.values()) {
    const value = state[field] ?? (field === 'status' ? 'unknown' : null);
    if (value) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Folds one run (newest rows first) into an activity summary, from metadata only. Runs arrive
 * newest first too, so the summary's start moves back with each run while its end stays put.
 *
 * A call's status and kind are the first ones seen reading newest first: its latest reported
 * values. Update rows that only carry new output omit both, so a missing value is filled from an
 * older row of the same call rather than read as "unknown".
 */
export function addRunToActivity(
  activity: LogicalActivity,
  run: Run,
  includeTitles: boolean,
  calls: ToolCallStates
): void {
  const oldest = run.rows[run.rows.length - 1];
  const newest = run.rows[0];
  if (!oldest || !newest) return;
  activity.rowCount += run.rows.length;
  activity.firstRowId = rowId(oldest);
  activity.start = rowPosition(oldest);
  activity.createdAt = rowTime(oldest);
  if (!activity.updatedAt) activity.updatedAt = rowTime(newest);
  if (run.role === 'thinking') {
    activity.thinkingMessages += 1;
    return;
  }
  if (run.role === 'plan') {
    activity.planUpdates += 1;
    return;
  }
  if (run.role !== 'tool') {
    activity.otherMessages[run.role] = (activity.otherMessages[run.role] ?? 0) + 1;
    return;
  }
  if (includeTitles) activity.toolTitles ??= [];
  for (const row of run.rows) {
    const meta = toolMetadata(row);
    const callId = typeof meta.toolCallId === 'string' && meta.toolCallId ? meta.toolCallId : null;
    const key = callId ?? `row:${rowId(row)}`;
    const state = calls.get(key) ?? { status: null, kind: null };
    state.status ??= boundedText(meta.status);
    state.kind ??= boundedText(meta.kind);
    calls.set(key, state);
    pushDistinct(activity.toolNames, boundedText(meta.toolName));
    if (activity.toolTitles) pushDistinct(activity.toolTitles, boundedText(meta.title));
  }
  activity.toolCalls = calls.size;
  activity.toolStatuses = countBy(calls, 'status');
  activity.toolKinds = countBy(calls, 'kind');
}

/** The run's text, oldest chunk first. */
export function runContent(run: Run): string {
  let content = '';
  for (let index = run.rows.length - 1; index >= 0; index -= 1) {
    const chunk = run.rows[index]?.content;
    if (typeof chunk === 'string') content += chunk;
  }
  return content;
}

/**
 * `maxChars` characters of the run's text from `offset`, and the text's whole length, copying only
 * the chunks that overlap the slice (a long reply is never joined in full to return a page of it).
 */
function runTextSlice(run: Run, offset: number, maxChars: number) {
  let length = 0;
  for (const row of run.rows) length += typeof row.content === 'string' ? row.content.length : 0;
  const start = Math.min(Math.max(0, Math.floor(offset)), length);
  const end = Math.min(length, start + Math.max(0, Math.floor(maxChars)));
  const parts: string[] = [];
  let position = 0;
  for (let index = run.rows.length - 1; index >= 0 && position < end; index -= 1) {
    const chunk = run.rows[index]?.content;
    if (typeof chunk !== 'string') continue;
    if (position + chunk.length > start) {
      parts.push(chunk.slice(Math.max(0, start - position), end - position));
    }
    position += chunk.length;
  }
  return { text: parts.join(''), length, start, end };
}

/**
 * One message from a run, returning `maxChars` of its text from `offset`. `content` is the run's
 * whole text when the caller already built it (to search it); otherwise only the slice is built.
 */
export function assembleMessage(
  run: Run,
  slice: { offset: number; maxChars: number; content?: string },
  complete: boolean
): LogicalMessage {
  const first = run.rows[run.rows.length - 1] ?? {};
  const last = run.rows[0] ?? {};
  const { text, length, start, end } =
    slice.content === undefined
      ? runTextSlice(run, slice.offset, slice.maxChars)
      : (() => {
          const whole = slice.content;
          const from = Math.min(Math.max(0, Math.floor(slice.offset)), whole.length);
          const to = Math.min(whole.length, from + Math.max(0, Math.floor(slice.maxChars)));
          return { text: whole.slice(from, to), length: whole.length, start: from, end: to };
        })();
  return {
    kind: 'message',
    messageId: rowId(first),
    start: rowPosition(first),
    lastRowId: rowId(last),
    role: run.role,
    origin: typeof first.origin === 'string' ? first.origin : null,
    content: text,
    offset: start,
    contentLength: length,
    truncated: end < length,
    nextOffset: end < length ? end : null,
    rowCount: run.rows.length,
    createdAt: rowTime(first),
    updatedAt: rowTime(last),
    complete,
    continuesInNewerPage: false,
  };
}
