/**
 * One batched read of the work linked to many ideas at once.
 *
 * The Ideas list derives every row's state from the chats linked to it, so it needs this for
 * the whole page. Asking per idea — which is what the single-idea link read does — would cost
 * one Durable Object round trip per idea and blow the list's I/O budget (rule 60), so this
 * answers for N ideas in a fixed handful of queries instead.
 *
 * Every `resource_links` read here goes through `links.ts`, which is the single home for that
 * table (program decision 7). This module owns only the composition: joining the linked
 * sessions to their chat rows, their unanswered questions and their note counts. It reads no
 * link table itself, and it no longer reads `chat_session_ideas` — that table stopped being
 * written when T1 landed (`routes/chat-ideas.ts` records a `resource_links` row now), so a
 * reader of it would have silently shown only links made before that deploy.
 *
 * Reads are fault-isolated per row (rule 50): one malformed row is skipped and logged, never
 * turned into a failed list for the whole project.
 */
import { isStrongLinkRelation, type LinkRelation } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { countIdeaUpdates } from './idea-updates';
import { type IdeaAssetLink, listIdeaAssetLinksForTargets, listLinksForTargets } from './links';
import { parseIdeaNeedsInputRow, parseIdeaWorkSessionRow } from './row-schemas';

const log = createModuleLogger('idea-work');

/**
 * The attention-marker kind that means "an agent asked a person something and nobody has
 * answered". Written by `request_human_input` (`routes/mcp/human-input-tool.ts`), by a pending
 * ACP interaction, and by the reconciliation episode.
 */
export const IDEA_NEEDS_INPUT_MARKER_KIND = 'needs_input';

/** The caps the link store is read under, resolved from admin settings by the caller. */
export interface IdeaWorkLinkCaps {
  /** Most links returned for one idea, per kind of thing linked. */
  perTargetCap: number;
  /** Most ideas one link query may ask about; longer lists are read in several queries. */
  maxTargets: number;
}

export interface IdeaWorkSessionRow {
  sessionId: string;
  topic: string | null;
  /** The chat session's own status. */
  sessionStatus: string;
  /** The task driving the chat, when it has one. */
  sessionTaskId: string | null;
  /** Epoch ms of the chat's last update. */
  lastActivityAt: number | null;
  /** Every relation recorded between this chat and the idea. */
  relations: LinkRelation[];
  /** True when at least one of those relations is a strong one. */
  strong: boolean;
  /** Epoch ms the earliest of those relations was first recorded. */
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
  /** Project files this idea owns, through its own links or its strong chats'. */
  fileIds: string[];
  /** Pull request URLs recorded in the link store for this idea. Not canonicalized here. */
  pullRequestUrls: string[];
  /** Notes on the idea, excluding soft-deleted ones. Exact. */
  updates: number;
  /** The lists a per-idea cap truncated, so the caller can say "50+" instead of "50". */
  truncated: { sessions: boolean; files: boolean; pullRequests: boolean };
}

interface SessionDisplayRow {
  topic: string | null;
  sessionStatus: string;
  sessionTaskId: string | null;
  lastActivityAt: number | null;
}

function emptySnapshot(ideaId: string): IdeaWorkSnapshot {
  return {
    ideaId,
    sessions: [],
    needsInput: [],
    fileIds: [],
    pullRequestUrls: [],
    updates: 0,
    truncated: { sessions: false, files: false, pullRequests: false },
  };
}

/** Chunks `ids` so no link query is asked about more targets than it allows. */
function chunkTargets(ids: string[], maxTargets: number): string[][] {
  const size = Math.max(1, Math.floor(maxTargets));
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

/** The chat rows behind a set of session ids, by id. One query, one bound parameter. */
function readSessionDisplay(sql: SqlStorage, sessionIds: string[]): Map<string, SessionDisplayRow> {
  const byId = new Map<string, SessionDisplayRow>();
  if (!sessionIds.length) return byId;
  const rows = sql
    .exec(
      `SELECT id AS session_id, topic, status, task_id AS session_task_id, updated_at
         FROM chat_sessions WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(sessionIds)
    )
    .toArray();
  for (const row of rows) {
    try {
      const parsed = parseIdeaWorkSessionRow(row);
      byId.set(parsed.sessionId, {
        topic: parsed.topic,
        sessionStatus: parsed.sessionStatus,
        sessionTaskId: parsed.sessionTaskId,
        lastActivityAt: parsed.lastActivityAt,
      });
    } catch (error) {
      log.warn('idea_work.session_row_skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return byId;
}

/**
 * Unanswered questions on a set of chats, by session id.
 *
 * Scoped to the sessions the links already selected, so one project's unrelated attention
 * markers never reach this read, and a chat that only *read* an idea cannot contribute a
 * question to it — the caller drops weak links before asking.
 */
function readNeedsInput(
  sql: SqlStorage,
  sessionIds: string[],
  now: number
): Map<string, IdeaNeedsInputRow> {
  const bySession = new Map<string, IdeaNeedsInputRow>();
  if (!sessionIds.length) return bySession;
  const rows = sql
    .exec(
      `SELECT session_id, reason, created_at FROM session_attention_markers
        WHERE session_id IN (SELECT value FROM json_each(?))
          AND kind = ?
          AND resolved_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC`,
      JSON.stringify(sessionIds),
      IDEA_NEEDS_INPUT_MARKER_KIND,
      now
    )
    .toArray();
  for (const row of rows) {
    try {
      const parsed = parseIdeaNeedsInputRow(row);
      // Newest first, so the first marker for a session is the one on screen.
      if (!bySession.has(parsed.sessionId)) bySession.set(parsed.sessionId, parsed);
    } catch (error) {
      log.warn('idea_work.needs_input_row_skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return bySession;
}

function applyAssets(
  snapshots: Record<string, IdeaWorkSnapshot>,
  assets: IdeaAssetLink[],
  perTargetCap: number
): void {
  for (const asset of assets) {
    const snapshot = snapshots[asset.ideaId];
    if (!snapshot) continue;
    if (asset.targetKind === 'file') snapshot.fileIds.push(asset.targetId);
    else snapshot.pullRequestUrls.push(asset.targetId);
  }
  for (const snapshot of Object.values(snapshots)) {
    snapshot.truncated.files = snapshot.fileIds.length >= perTargetCap;
    snapshot.truncated.pullRequests = snapshot.pullRequestUrls.length >= perTargetCap;
  }
}

/**
 * The work linked to each of `ideaIds`, keyed by idea id. Ideas with no linked work get an
 * entry with empty lists, so a caller never has to distinguish "absent" from "nothing yet".
 */
export function getIdeaWorkSnapshots(
  sql: SqlStorage,
  ideaIds: readonly string[],
  caps: IdeaWorkLinkCaps,
  now: number = Date.now()
): Record<string, IdeaWorkSnapshot> {
  const snapshots: Record<string, IdeaWorkSnapshot> = {};
  const unique = [...new Set(ideaIds.filter((id) => typeof id === 'string' && id.length > 0))];
  for (const ideaId of unique) snapshots[ideaId] = emptySnapshot(ideaId);
  if (unique.length === 0) return snapshots;

  // 1. Which chats are linked to these ideas, and how. `relations` is what makes strength
  //    real: before T1 every link meant "works on", so the derivation could assume it.
  const sessionsByIdea = new Map<string, Map<string, IdeaWorkSessionRow>>();
  /*
   * Raw link ROWS per idea, which is what the cap actually limits.
   *
   * `listLinksForTargets` caps per `target_id` by row, and one chat can hold several relations
   * to one idea (`read` and `works_on`, say), each its own row folded into a single `byId`
   * entry below. So `byId.size` undercounts against the cap: 50 rows from 30 chats reached the
   * limit, but the map holds 30 and the list would publish "30 chats" as exact. That breaks the
   * `IdeaCounts.atLeast` contract, whose whole job is to say "50+" when a cap intervened.
   */
  const linkRowsByIdea = new Map<string, number>();
  const assets: IdeaAssetLink[] = [];
  for (const ids of chunkTargets(unique, caps.maxTargets)) {
    for (const link of listLinksForTargets(sql, 'idea', ids, caps.perTargetCap, caps.maxTargets)) {
      const ideaId = link.targetId;
      linkRowsByIdea.set(ideaId, (linkRowsByIdea.get(ideaId) ?? 0) + 1);
      const existing = sessionsByIdea.get(ideaId) ?? new Map<string, IdeaWorkSessionRow>();
      sessionsByIdea.set(ideaId, existing);
      const current = existing.get(link.sourceId);
      if (current) {
        if (!current.relations.includes(link.relation)) current.relations.push(link.relation);
        current.strong ||= isStrongLinkRelation(link.relation);
        current.linkedAt = Math.min(current.linkedAt, link.firstAt);
        continue;
      }
      existing.set(link.sourceId, {
        sessionId: link.sourceId,
        topic: null,
        sessionStatus: 'unknown',
        sessionTaskId: null,
        lastActivityAt: null,
        relations: [link.relation],
        strong: isStrongLinkRelation(link.relation),
        linkedAt: link.firstAt,
      });
    }
    assets.push(...listIdeaAssetLinksForTargets(sql, ids, caps.perTargetCap, caps.maxTargets));
  }

  // 2. Those chats' own rows, and the questions on them, in one query each.
  const sessionIds = [...new Set([...sessionsByIdea.values()].flatMap((byId) => [...byId.keys()]))];
  const display = readSessionDisplay(sql, sessionIds);
  const needsInput = readNeedsInput(sql, sessionIds, now);

  for (const [ideaId, byId] of sessionsByIdea) {
    const snapshot = snapshots[ideaId];
    if (!snapshot) continue;
    for (const session of byId.values()) {
      const row = display.get(session.sessionId);
      // A link whose chat has been deleted is dropped rather than shown as "unknown".
      if (!row) continue;
      snapshot.sessions.push({ ...session, ...row });
      const marker = session.strong ? needsInput.get(session.sessionId) : undefined;
      if (marker) snapshot.needsInput.push(marker);
    }
    snapshot.sessions.sort((a, b) => (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1));
    snapshot.needsInput.sort((a, b) => b.askedAt - a.askedAt);
    snapshot.truncated.sessions = (linkRowsByIdea.get(ideaId) ?? 0) >= caps.perTargetCap;
  }

  // 3. The files and pull requests those ideas own, and how many notes each one has.
  applyAssets(snapshots, assets, caps.perTargetCap);
  const updates = countIdeaUpdates(sql, unique);
  for (const [ideaId, count] of Object.entries(updates)) {
    const snapshot = snapshots[ideaId];
    if (snapshot) snapshot.updates = count;
  }

  return snapshots;
}
