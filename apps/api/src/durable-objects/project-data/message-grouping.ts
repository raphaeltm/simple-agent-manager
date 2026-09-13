/**
 * Streaming-delta grouping — the single implementation of "a run of consecutive
 * same-role rows is one logical message".
 *
 * SAM persists every streaming token as its own `chat_messages` row. Measured on a
 * real 255-message session, 239 assistant rows carried 1,017 characters of text in
 * 53,051 bytes — a 52x envelope overhead (SAM idea 01M27M6BDJCRVE1FFQA5BXAQ5D).
 * This module removes that overhead in two places:
 *
 *  - `coalesceStreamingDeltaBatch()` merges the deltas of one VM-agent flush BEFORE
 *    they are inserted, so the rows are never written. It must run pre-insert:
 *    `tests/unit/durable-objects/project-data-message-text-invariant.test.ts` pins
 *    the product invariant that no path may `UPDATE chat_messages SET content = …`
 *    or `DELETE FROM chat_messages` outside archive-sharding.
 *  - `groupChatMessageRows()` merges the surviving per-flush rows at read time, so
 *    sessions written before this shipped also load as whole turns.
 *
 * Before adding a fifth copy of this walk, use one of these.
 */

import type { Env } from './types';

/**
 * Roles whose consecutive rows are merged on the transcript read/write path.
 *
 * `tool` is deliberately ABSENT. A tool row carries per-call metadata (toolCallId,
 * status, locations) and its `id` is the handle the lazy-load endpoint
 * `GET …/messages/:messageId/tool-content` resolves, so concatenating tool rows
 * would destroy both. Tool runs are collapsed for readability in the client
 * instead, where the per-call ids survive. See `.claude/rules/67` — this set and
 * `TEXT_SEARCH_GROUPABLE_ROLES` below look alike on purpose and must not be merged
 * into one shared constant.
 */
export const STREAM_DELTA_GROUPABLE_ROLES: ReadonlySet<string> = new Set([
  'assistant',
  'thinking',
]);

/**
 * Roles grouped when the only output is plain text: the FTS5 materialization and
 * the MCP/agent message readers. Those consumers want a tool call's textual result
 * folded into the surrounding prose and have no lazy-load handle to preserve, so
 * `tool` IS groupable here.
 */
export const TEXT_SEARCH_GROUPABLE_ROLES: ReadonlySet<string> = new Set([
  'assistant',
  'tool',
  'thinking',
]);

/**
 * Default ceiling on the content of a single merged row, in UTF-16 code units.
 *
 * Bounds the string built in memory when a pathological session streams a very
 * long uninterrupted turn. 256 KiB matches the VM agent's per-flush payload cap
 * (`MSG_BATCH_MAX_BYTES`), so a normal flush never hits it.
 */
export const DEFAULT_MESSAGE_GROUP_MAX_CHARS = 256 * 1024;

export type MessageGroupingConfig = {
  /** Merge contiguous delta rows when serving a transcript read. */
  readGroupingEnabled: boolean;
  /** Merge the deltas of one flush before they are inserted. */
  coalescingEnabled: boolean;
  /** Shared ceiling on the content of a single merged row. */
  maxGroupChars: number;
};

function parseEnabled(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === '') return fallback;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

/**
 * Both switches default ON. They exist so an operator can disable either half
 * without a redeploy if grouping ever has to be rolled back independently of the
 * code that produces it.
 */
export function resolveMessageGroupingConfig(env: Env): MessageGroupingConfig {
  const parsedMax = Number.parseInt(env.PROJECT_DATA_MESSAGE_GROUP_MAX_CHARS || '', 10);
  return {
    readGroupingEnabled: parseEnabled(env.PROJECT_DATA_MESSAGE_GROUPING_ENABLED, true),
    coalescingEnabled: parseEnabled(env.PROJECT_DATA_MESSAGE_COALESCING_ENABLED, true),
    maxGroupChars:
      Number.isSafeInteger(parsedMax) && parsedMax > 0
        ? parsedMax
        : DEFAULT_MESSAGE_GROUP_MAX_CHARS,
  };
}

/** `origin` is nullable in SQLite and absent on pre-migration rows; both mean "user". */
function normalizeOrigin(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'user';
}

/** True when a column holds no tool metadata (SQL NULL, absent, or empty string). */
function hasNoToolMetadata(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

// ---------------------------------------------------------------------------
// Text-token grouping (FTS materialization, MCP readers)
// ---------------------------------------------------------------------------

export type TextToken = {
  id: string;
  role: string;
  content: string;
  createdAt: number;
};

/**
 * Merge consecutive same-role tokens into one, keeping the FIRST token's id and
 * createdAt. Callers pass their own role set so the read path cannot inherit the
 * search path's wider one.
 */
export function groupTextTokens<T extends TextToken>(
  tokens: readonly T[],
  groupableRoles: ReadonlySet<string> = TEXT_SEARCH_GROUPABLE_ROLES
): T[] {
  const grouped: T[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === token.role && groupableRoles.has(token.role)) {
      last.content += token.content;
      continue;
    }
    grouped.push({ ...token });
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Read-path grouping over raw chat_messages rows
// ---------------------------------------------------------------------------

export type ChatMessageRowGroupingOptions = {
  /** Ceiling on merged content length; a longer run is split into several rows. */
  maxGroupChars: number;
  /**
   * Message ids that must start their own group. A comment thread anchors on
   * `comment_threads.message_id`; if such a row were absorbed into a group carrying
   * a different id, the thread's anchor would not be in the returned page and the
   * comment would silently disappear from the conversation.
   */
  anchoredMessageIds?: ReadonlySet<string>;
};

/**
 * True when `next` is the immediate successor of `previousSequence` in the real
 * transcript.
 *
 * "Adjacent in the returned array" is NOT sufficient. A `roles=assistant` read
 * elides the interleaved tool rows, which would make two different turns adjacent
 * and merge them into one bubble; a page boundary has the same effect. `sequence`
 * is dense per session — every insert path allocates it from `nextSequence()`
 * (`MAX(sequence) + 1`) and migration 007 backfilled `sequence = rowid` — so
 * strict succession proves the two rows really were neighbours.
 */
function isSequenceSuccessor(previousSequence: unknown, next: unknown): boolean {
  return (
    typeof previousSequence === 'number' &&
    typeof next === 'number' &&
    next === previousSequence + 1
  );
}

/**
 * Merge contiguous `assistant` / `thinking` rows of one turn into a single row.
 *
 * Operates on raw SQL rows (snake_case columns) BEFORE valibot parsing, so a large
 * session also costs proportionally fewer parses of DO CPU time.
 *
 * The merged row keeps the FIRST row's `id`, `created_at` and `sequence`. That is
 * the same identity the browser already derives for the bubble
 * (`chatMessagesToConversationItems` keeps the first chunk's id), so comment
 * anchors, timeline jumps and the `before` pagination cursor all keep resolving.
 *
 * Rows this never merges: a different role, a non-groupable role, an `origin`
 * change (so the `origin='system'` "Show system context" disclosure keeps its own
 * bubbles), any row carrying `tool_metadata`, a row whose id is comment-anchored,
 * a non-successor `sequence`, and anything whose columns are not the expected
 * types — a malformed row passes through untouched so the caller's per-row parse
 * can still skip it in isolation (`.claude/rules/50`).
 */
export function groupChatMessageRows(
  rows: readonly Record<string, unknown>[],
  options: ChatMessageRowGroupingOptions
): Record<string, unknown>[] {
  const maxGroupChars =
    Number.isFinite(options.maxGroupChars) && options.maxGroupChars > 0
      ? options.maxGroupChars
      : DEFAULT_MESSAGE_GROUP_MAX_CHARS;
  const anchored = options.anchoredMessageIds;

  const grouped: Record<string, unknown>[] = [];
  // Sequence of the LAST row absorbed into the open group. The group's own
  // `sequence` column stays at the first row's value, so it cannot be used here.
  let openTailSequence: unknown = null;
  let openContent = '';

  for (const row of rows) {
    const open = grouped[grouped.length - 1];
    const role = row.role;
    const content = row.content;
    // A groupable row may accept successors. An anchored row still may — the
    // merged row then carries the anchor's OWN id, so the thread still resolves
    // — it just may not be absorbed INTO a predecessor, which would replace its
    // id with someone else's.
    const groupable =
      typeof role === 'string' &&
      STREAM_DELTA_GROUPABLE_ROLES.has(role) &&
      typeof content === 'string' &&
      typeof row.id === 'string' &&
      hasNoToolMetadata(row.tool_metadata);
    const absorbable = groupable && !(anchored?.has(row.id as string) ?? false);

    if (
      open &&
      absorbable &&
      open.role === role &&
      normalizeOrigin(open.origin) === normalizeOrigin(row.origin) &&
      hasNoToolMetadata(open.tool_metadata) &&
      isSequenceSuccessor(openTailSequence, row.sequence) &&
      openContent.length + (content as string).length <= maxGroupChars
    ) {
      openContent += content as string;
      open.content = openContent;
      openTailSequence = row.sequence;
      continue;
    }

    const copy = { ...row };
    grouped.push(copy);
    // Only a groupable row can accept successors; anything else closes the group.
    openTailSequence = groupable ? row.sequence : null;
    openContent = groupable ? (content as string) : '';
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Persist-path coalescing over one VM-agent flush batch
// ---------------------------------------------------------------------------

export type CoalescibleBatchMessage = {
  messageId: string;
  role: string;
  content: string;
  toolMetadata: string | null;
  timestamp: string;
  sequence?: number;
  origin?: string | null;
};

export type CoalesceStreamingDeltaBatchResult<T extends CoalescibleBatchMessage> = {
  messages: T[];
  /** Rows that will never be written because their text was folded into a predecessor. */
  absorbed: number;
};

/**
 * Merge the consecutive assistant/thinking deltas of ONE flush into one message.
 *
 * The VM agent flushes every `MSG_BATCH_MAX_WAIT` (2 s) with at most
 * `MSG_BATCH_MAX_SIZE` (50) rows, and the browser receives that flush as a single
 * `messages.batch` broadcast, so merging inside a flush leaves the live streaming
 * cadence byte-for-byte identical while writing one row instead of fifty.
 *
 * The surviving message keeps the run's FIRST `messageId`. That is what makes the
 * retry path safe without any new bookkeeping: the agent deletes an outbox batch
 * only after a 2xx and re-reads the identical `ORDER BY id ASC LIMIT ?` prefix on
 * retry, so a replayed batch coalesces to the same first id and the existing
 * `SELECT id FROM chat_messages WHERE id = ?` probe recognises it as a duplicate.
 */
export function coalesceStreamingDeltaBatch<T extends CoalescibleBatchMessage>(
  messages: readonly T[],
  maxGroupChars: number = DEFAULT_MESSAGE_GROUP_MAX_CHARS
): CoalesceStreamingDeltaBatchResult<T> {
  const cap =
    Number.isFinite(maxGroupChars) && maxGroupChars > 0
      ? maxGroupChars
      : DEFAULT_MESSAGE_GROUP_MAX_CHARS;

  const coalesced: T[] = [];
  let openTailSequence: number | undefined;
  let absorbed = 0;

  for (const message of messages) {
    const open = coalesced[coalesced.length - 1];
    const groupable =
      STREAM_DELTA_GROUPABLE_ROLES.has(message.role) && hasNoToolMetadata(message.toolMetadata);

    if (
      open &&
      groupable &&
      open.role === message.role &&
      normalizeOrigin(open.origin) === normalizeOrigin(message.origin) &&
      hasNoToolMetadata(open.toolMetadata) &&
      sequencesJoin(openTailSequence, message.sequence) &&
      open.content.length + message.content.length <= cap
    ) {
      open.content += message.content;
      openTailSequence = message.sequence;
      absorbed++;
      continue;
    }

    coalesced.push({ ...message });
    openTailSequence = groupable ? message.sequence : undefined;
  }

  return { messages: coalesced, absorbed };
}

/**
 * Explicit sequences must be strict successors; absent sequences join freely
 * because `persistMessageBatch` assigns them densely in arrival order. A batch
 * that mixes explicit and absent sequences is not merged — the caller's intent is
 * ambiguous and the rows may not be neighbours.
 */
function sequencesJoin(previous: number | undefined, next: number | undefined): boolean {
  if (previous === undefined && next === undefined) return true;
  if (previous === undefined || next === undefined) return false;
  return next === previous + 1;
}
