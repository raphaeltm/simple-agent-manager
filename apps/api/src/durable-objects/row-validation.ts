/**
 * Cross-DO Durable Object SQLite row-validation helpers.
 *
 * `sql.exec(...).toArray()` on DO-embedded SQLite returns loosely-typed rows
 * with no compile-time or runtime guarantee that they match the shape a
 * caller casts them to (`as unknown as XRow[]`). A single malformed row
 * (partial write, legacy schema drift, a future migration relaxing a NOT
 * NULL constraint) must never throw the whole read — see
 * .claude/rules/50-list-read-row-fault-isolation.md.
 *
 * The throwing single-row validator (`parseRow`) and its two fault-isolated
 * wrappers live in `@simple-agent-manager/worker-core` (`row-parsing.ts`; fully
 * generic, and ProjectData uses them too). This module re-exports them for the
 * worker's other DOs:
 *
 *  - `mapRows`: validate a LIST of rows, skipping (and warn-logging) any row
 *    that fails validation instead of throwing the whole read.
 *  - `parseRowOrNull`: validate a SINGLE optional row (e.g. `rows[0]`),
 *    degrading to `null` + a warn log instead of throwing, for callers that
 *    already treat a missing row as null/undefined.
 *
 * It also centralizes the `conversations` / `messages` / `rate_limits` row
 * schemas that are byte-identical between the ProjectAgent and SamSession
 * DOs (see both DOs' `migrate()`). ProjectAgent's `conversations` table has
 * no `type` column at all, so `type` is optional here to cover both DOs'
 * SELECTs with one schema.
 */
import { mapRows, parseRow, parseRowOrNull } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

/** Generic DO row parsers live in worker-core; re-exported for the worker's Durable Objects. */
export { mapRows, parseRow, parseRowOrNull };

/** Best-effort row identifier for skip-log diagnostics; `idKey` defaults to `id`. */
// =============================================================================
// Shared row schemas — ProjectAgent + SamSession
// =============================================================================
// The `messages` and `rate_limits` tables (and their SELECTed columns) are
// byte-identical between the ProjectAgent and SamSession DOs. `conversations`
// differs only by the `type` column (SamSession has it, ProjectAgent does
// not), so `type` is optional here to validate both DOs' SELECTs.

/** `conversations` list-row shape shared by ProjectAgent and SamSession. */
export const ConversationSummaryRowSchema = v.object({
  id: v.string(),
  title: v.nullable(v.string()),
  type: v.optional(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
});
export type ConversationSummaryRow = v.InferOutput<typeof ConversationSummaryRowSchema>;

/** `messages` row shape shared by ProjectAgent and SamSession. */
export const MessageRowSchema = v.object({
  id: v.string(),
  conversation_id: v.string(),
  role: v.string(),
  content: v.string(),
  tool_calls_json: v.nullable(v.string()),
  tool_call_id: v.nullable(v.string()),
  sequence: v.number(),
  created_at: v.string(),
});

/** `rate_limits` singleton-row shape shared by ProjectAgent and SamSession. */
export const RateLimitRowSchema = v.object({
  window_start: v.number(),
  request_count: v.number(),
});
export type RateLimitRow = v.InferOutput<typeof RateLimitRowSchema>;

/** `SELECT rowid FROM messages WHERE id = ?` shape, used for FTS5 sync. */
export const RowidRowSchema = v.object({
  rowid: v.number(),
});
