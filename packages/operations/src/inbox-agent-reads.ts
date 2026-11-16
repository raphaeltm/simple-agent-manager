/**
 * What an agent reads back from the inbox (slice D, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9): the open
 * items of its chat or project (`inbox_read list`, the check before filing), one item with its
 * outcome (`inbox_read get`), and the similar open items returned when it files.
 *
 * These read `asks` by where an item came from, not by who may act on it, so they are separate
 * from the viewer-scoped inbox list (`inbox-list-core.ts`): an agent checks what this chat or
 * project already asked, whoever it is addressed to. Every read binds `project_id` (rule 11).
 */
import {
  ASK_STATUSES,
  type InboxAgentItem,
  type InboxLink,
  type InboxSimilarItem,
  parseInboxRef,
} from '@simple-agent-manager/shared';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { OperationError } from './errors';
import { InboxLinksSchema } from './inbox-rows';
import { getInboxLimits, type InboxLimits } from './inbox-settings';
import type { OperationContext } from './types';

/** Where an agent's call came from. Always from its verified MCP token, never from arguments. */
export interface AgentInboxSource {
  projectId: string;
  sessionId: string;
  taskId: string;
  workspaceId: string | null;
  /** The person the agent works for: the assignee of what it files. */
  userId: string;
}

export const AGENT_ITEM_NOT_FOUND = 'Inbox item not found';

const AGENT_ITEM_COLUMNS = `id, kind, blocking, status, title, body_md, links_json, group_key,
  source_session_id, created_at, expires_at, resolved_at, answer_json`;

const RowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.pipe(v.string(), v.minLength(1)),
  blocking: v.union([v.literal(0), v.literal(1)]),
  status: v.picklist(ASK_STATUSES),
  title: v.string(),
  body_md: v.nullable(v.string()),
  links_json: v.nullable(v.string()),
  group_key: v.nullable(v.string()),
  source_session_id: v.nullable(v.string()),
  created_at: v.pipe(v.number(), v.safeInteger()),
  expires_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
  resolved_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
  answer_json: v.nullable(v.string()),
});

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function answerFields(answerJson: string | null): { answer: string | null; cancelReason: string | null } {
  if (!answerJson) return { answer: null, cancelReason: null };
  try {
    const record = maybeJsonRecord(JSON.parse(answerJson) as unknown);
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return { answer: text(record?.text), cancelReason: text(record?.cancelReason) };
  } catch {
    return { answer: null, cancelReason: null };
  }
}

function parseLinks(linksJson: string | null): InboxLink[] {
  if (!linksJson) return [];
  return v
    .parse(InboxLinksSchema, JSON.parse(linksJson) as unknown)
    .map((link) => ({ kind: link.kind, id: link.id, label: link.label ?? null }));
}

/** One row as the agent reads it; throws on a malformed row (callers isolate it, rule 50). */
function agentItemFromRow(row: unknown, sessionId: string): InboxAgentItem {
  const parsed = v.parse(RowSchema, row);
  return {
    ref: `ask:${parsed.id}`,
    kind: parsed.kind,
    blocking: parsed.blocking === 1,
    status: parsed.status,
    title: parsed.title,
    why: parsed.body_md,
    links: parseLinks(parsed.links_json),
    groupKey: parsed.group_key,
    sessionId: parsed.source_session_id,
    fromThisChat: parsed.source_session_id === sessionId,
    createdAt: new Date(parsed.created_at).toISOString(),
    expiresAt: iso(parsed.expires_at),
    resolvedAt: iso(parsed.resolved_at),
    ...answerFields(parsed.answer_json),
    untrustedContent: true,
  };
}

/** The `asks` id of an `ask:<id>` ref; any other ref names nothing an agent can read here. */
export function agentAskId(ref: string): string {
  const parsed = parseInboxRef(ref);
  if (!parsed || parsed.store !== 'ask') throw new OperationError('not_found', AGENT_ITEM_NOT_FOUND);
  return parsed.id;
}

export interface AgentListInput {
  scope?: 'chat' | 'project';
  limit?: number;
}

/**
 * Open items filed from this chat (default) or anywhere in this project, newest first. One
 * statement on `idx_asks_project_status`; at most `inbox.listPageMax` rows. `hasMore` says when
 * there are more than were returned, so a partial list is never read as the whole (rule 65).
 */
export async function listAgentAsks(
  ctx: OperationContext,
  source: AgentInboxSource,
  input: AgentListInput
): Promise<{ items: InboxAgentItem[]; hasMore: boolean; skipped: number }> {
  const limits = await getInboxLimits(ctx);
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? limits.listPageSize)), limits.listPageMax);
  const chatOnly = (input.scope ?? 'chat') === 'chat';
  const result = await ctx.env.DATABASE.prepare(
    `SELECT ${AGENT_ITEM_COLUMNS} FROM asks
      WHERE project_id = ? AND status = 'open'${chatOnly ? ' AND source_session_id = ?' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(...(chatOnly ? [source.projectId, source.sessionId] : [source.projectId]), limit + 1)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const items: InboxAgentItem[] = [];
  let skipped = 0;
  for (const row of rows.slice(0, limit)) {
    try {
      items.push(agentItemFromRow(row, source.sessionId));
    } catch (error) {
      skipped += 1;
      console.warn(
        JSON.stringify({
          event: 'inbox.agent_list_row_skipped',
          projectId: source.projectId,
          askId: typeof row.id === 'string' ? row.id : null,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  return { items, hasMore: rows.length > limit, skipped };
}

/** One item of this project, any status. Missing and foreign refs read the same not-found. */
export async function getAgentAsk(
  ctx: OperationContext,
  source: AgentInboxSource,
  input: { ref: string }
): Promise<InboxAgentItem> {
  const askId = agentAskId(input.ref);
  const row = await ctx.env.DATABASE.prepare(
    `SELECT ${AGENT_ITEM_COLUMNS} FROM asks WHERE id = ? AND project_id = ?`
  )
    .bind(askId, source.projectId)
    .first<Record<string, unknown>>();
  if (!row) throw new OperationError('not_found', AGENT_ITEM_NOT_FOUND);
  try {
    return agentItemFromRow(row, source.sessionId);
  } catch (error) {
    // A malformed row is a clean not-found, never an opaque 500 (rule 50).
    console.warn(
      JSON.stringify({
        event: 'inbox.agent_get_row_unreadable',
        projectId: source.projectId,
        askId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new OperationError('not_found', AGENT_ITEM_NOT_FOUND);
  }
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'should', 'this', 'that', 'with', 'you', 'can', 'are', 'what', 'which']);

/** Lower-case words of three or more letters, without filler words. */
function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
  );
}

/** Share of words two titles have in common (Jaccard). */
export function titleSimilarity(left: string, right: string): number {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Two titles at or above this overlap read as the same ask. */
export const SIMILAR_TITLE_THRESHOLD = 0.6;

/**
 * Open items of the project that look like the one just filed: the same `groupKey`, or a title
 * sharing most of its words. Cost: one read of at most `inbox.similarScanMax` rows on
 * `idx_asks_project_status`, compared in the Worker; off when `inbox.similarMatchesMax` is 0.
 * Never throws: a failed check returns nothing rather than failing the filing.
 */
export async function findSimilarAsks(
  ctx: OperationContext,
  limits: InboxLimits,
  input: { projectId: string; sessionId: string; title: string; groupKey?: string; excludeId: string }
): Promise<InboxSimilarItem[]> {
  if (limits.similarMatchesMax <= 0) return [];
  let rows: Record<string, unknown>[];
  try {
    const result = await ctx.env.DATABASE.prepare(
      `SELECT id, kind, title, group_key, source_session_id FROM asks
        WHERE project_id = ? AND status = 'open' AND id != ?
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
      .bind(input.projectId, input.excludeId, limits.similarScanMax)
      .all<Record<string, unknown>>();
    rows = result.results ?? [];
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'inbox.similar_read_failed',
        projectId: input.projectId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return [];
  }
  const groupMatches: InboxSimilarItem[] = [];
  const titleMatches: InboxSimilarItem[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.kind !== 'string')
      continue;
    const base = {
      ref: `ask:${row.id}`,
      kind: row.kind,
      title: row.title,
      fromThisChat: row.source_session_id === input.sessionId,
    };
    if (input.groupKey && row.group_key === input.groupKey) {
      groupMatches.push({ ...base, match: 'group' });
    } else if (titleSimilarity(input.title, row.title) >= SIMILAR_TITLE_THRESHOLD) {
      titleMatches.push({ ...base, match: 'title' });
    }
  }
  return [...groupMatches, ...titleMatches].slice(0, limits.similarMatchesMax);
}
