/**
 * The Project Overview brief as the page reads it (inbox slice I, spec 4.3). One D1 statement:
 * the stored row (`project_briefs`, written by `refreshProjectBriefIfDue` in apps/api) plus which
 * of the asks, running chats and automations it names are still open, so a claim whose item has
 * closed since is dropped instead of shown.
 *
 * The stored JSON is a trust boundary like any row (rule 51): it is validated here, and refs are
 * kept to the kinds and shapes SAM itself writes. Nothing here renders text; the web app escapes
 * every string and builds every link from `kind` + `id`.
 */
import {
  OVERVIEW_BRIEF_REF_KINDS,
  type OverviewBrief,
  type OverviewBriefSentence,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { OVERVIEW_RUNNING_TASK_STATUSES } from './project-overview-statuses';

/** At most this many sentences are stored, and so shown (three on desktop, two on a phone). */
export const BRIEF_MAX_SENTENCES = 3;
/** A generation that has not finished in this long is treated as abandoned. */
export const BRIEF_PENDING_TTL_MS = 2 * 60 * 1000;

const RefSchema = v.object({
  kind: v.picklist(OVERVIEW_BRIEF_REF_KINDS),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  label: v.pipe(v.string(), v.maxLength(300)),
  url: v.optional(v.pipe(v.string(), v.url(), v.regex(/^https:\/\//i))),
});

const PartSchema = v.union([
  v.object({ text: v.pipe(v.string(), v.maxLength(400)) }),
  v.object({ ref: RefSchema }),
]);

export const StoredBriefSchema = v.object({
  sentences: v.pipe(
    v.array(v.object({ parts: v.pipe(v.array(PartSchema), v.minLength(1), v.maxLength(24)) })),
    v.maxLength(BRIEF_MAX_SENTENCES)
  ),
});
export type StoredBrief = v.InferOutput<typeof StoredBriefSchema>;

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * The stored row, and of the items it names, those still open. Every subquery binds the row's
 * own `project_id`, so a ref can never resolve another project's item (rule 11).
 */
const BRIEF_SQL = `
  SELECT b.brief_json, b.generated_at, b.stale, b.pending_since, b.last_error_at,
    (SELECT json_group_array(a.id) FROM asks a
      WHERE a.project_id = b.project_id AND a.status = 'open'
        AND a.id IN (SELECT value FROM json_each(b.ref_asks_json))) AS open_asks,
    (SELECT json_group_array(ss.id) FROM session_summaries ss
       JOIN tasks t ON t.id = ss.task_id AND t.project_id = ss.project_id
      WHERE ss.project_id = b.project_id AND ss.status = 'active'
        AND t.status IN (${sqlList(OVERVIEW_RUNNING_TASK_STATUSES)})
        AND ss.id IN (SELECT value FROM json_each(b.ref_chats_json))) AS running_chats,
    (SELECT json_group_array(t.id) FROM triggers t
      WHERE t.project_id = b.project_id AND t.status <> 'disabled'
        AND t.id IN (SELECT value FROM json_each(b.ref_automations_json))) AS live_automations,
    b.ref_chats_json
  FROM project_briefs b
  WHERE b.project_id = ?`;

const RowSchema = v.object({
  brief_json: v.nullable(v.string()),
  generated_at: v.nullable(v.number()),
  stale: v.number(),
  pending_since: v.nullable(v.number()),
  last_error_at: v.nullable(v.number()),
  open_asks: v.nullable(v.string()),
  running_chats: v.nullable(v.string()),
  live_automations: v.nullable(v.string()),
  ref_chats_json: v.string(),
});

const IdList = v.array(v.string());

function idSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = v.safeParse(IdList, JSON.parse(raw));
    return new Set(parsed.success ? parsed.output : []);
  } catch {
    return new Set();
  }
}

/**
 * The brief as the viewer should see it, or null when there is nothing to show. Throws only on a
 * failed D1 read, which the Overview turns into an unavailable section.
 */
export async function readProjectBrief(
  db: D1Database,
  projectId: string,
  now: number
): Promise<OverviewBrief | null> {
  const raw = await db.prepare(BRIEF_SQL).bind(projectId).first<Record<string, unknown>>();
  if (!raw) return null;
  const row = v.safeParse(RowSchema, raw);
  if (!row.success) {
    log.warn('project_brief.row_skipped', {
      projectId,
      issue: row.issues[0]?.message ?? 'invalid row',
      action: 'hidden',
    });
    return null;
  }
  const r = row.output;
  if (!r.brief_json || r.generated_at === null) return null;

  let stored: StoredBrief;
  try {
    const parsed = v.safeParse(StoredBriefSchema, JSON.parse(r.brief_json));
    if (!parsed.success) throw new Error(parsed.issues[0]?.message ?? 'invalid brief');
    stored = parsed.output;
  } catch (error) {
    log.warn('project_brief.stored_brief_invalid', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
      action: 'hidden',
    });
    return null;
  }

  const refreshing = r.pending_since !== null && now - r.pending_since < BRIEF_PENDING_TTL_MS;
  const stale = r.stale === 1;
  // The last attempt to catch up failed: what is stored no longer matches the facts and nothing
  // newer is coming, so the page is just its tiles (spec: "fails → simply the tiles").
  if (stale && !refreshing && r.last_error_at !== null && r.last_error_at > r.generated_at) {
    return null;
  }

  const openAsks = idSet(r.open_asks);
  const runningChats = idSet(r.running_chats);
  const liveAutomations = idSet(r.live_automations);
  const namedRunning = idSet(r.ref_chats_json);
  const stillTrue = (sentence: OverviewBriefSentence) =>
    sentence.parts.every((part) => {
      if (!('ref' in part)) return true;
      const { kind, id } = part.ref;
      if (kind === 'ask') return openAsks.has(id);
      if (kind === 'automation') return liveAutomations.has(id);
      // A chat named as running must still be running; one named as failed stays true.
      if (kind === 'chat' && namedRunning.has(id)) return runningChats.has(id);
      return true;
    });
  const sentences = stored.sentences.filter(stillTrue);
  if (sentences.length === 0) return null;

  return {
    sentences,
    generatedAt: new Date(r.generated_at).toISOString(),
    stale: stale || refreshing || sentences.length < stored.sentences.length,
    refreshing,
  };
}
