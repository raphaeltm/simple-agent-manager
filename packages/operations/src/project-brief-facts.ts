/**
 * The facts a Project Overview brief is built from (inbox slice I, spec 4.3): structured rows
 * from the same D1 data the Overview already reads. Never transcripts, never message bodies,
 * never secrets. Titles and topics are written by agents and people, so they are cleaned and
 * capped here and handed to the model only as data.
 *
 * Every fact is one that every active member of the project may see, because there is one brief
 * per project (Needs you beside it stays per person):
 * - an ask is included when nobody but its one reader could see it anyway: an unclaimed team ask
 *   (any member may), or a user or claimed ask in a project whose only active member is that
 *   reader (`inbox-list-core.ts` lists an ask to its assignee, or to a team's claimer);
 * - running and failed chats, automations, merged pull requests and ideas are project-wide;
 * - an account is included only when the credential is the project's or the platform's, never a
 *   member's own.
 *
 * Round trips: seven reads issued together (background only: a page view never waits on them).
 */
import { DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES } from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { ideaTaskPredicateSql } from './idea-identity';
import { readRunningChats } from './project-overview';
import { sanitizeUserInput } from './sanitize-user-input';

/** Characters of a title or topic the model sees. */
export const BRIEF_FACT_TEXT_MAX_CHARS = 120;
/** Rows of each kind the model sees. */
export const BRIEF_FACT_ROWS_MAX = 8;
/** How far back "recently" reaches for failed chats, merged pull requests and new ideas. */
export const BRIEF_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How far back a failed chat still counts as news. */
export const BRIEF_FAILED_CHAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Coarse age words: the brief says no numbers, so neither do its inputs. */
export type BriefAge = 'just now' | 'today' | 'this week' | 'older';

export interface BriefFacts {
  asks: Array<{ id: string; kind: string; title: string; blocking: boolean; age: BriefAge }>;
  runningChats: Array<{ id: string; topic: string; state: 'starting' | 'working' | 'waiting' }>;
  failedChats: Array<{ id: string; topic: string }>;
  failingAutomations: Array<{ id: string; name: string; paused: boolean }>;
  accounts: Array<{ id: string; label: string; level: 'warning' | 'critical' | 'rejected' }>;
  mergedPullRequests: Array<{ number: number; url: string; title: string }>;
  newIdeas: Array<{ id: string; title: string }>;
}

/** Clean an untrusted title for the model: no control characters, one line, capped. */
export function briefText(value: string | null | undefined, fallback: string): string {
  const cleaned = sanitizeUserInput(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > BRIEF_FACT_TEXT_MAX_CHARS
    ? `${cleaned.slice(0, BRIEF_FACT_TEXT_MAX_CHARS - 1).trimEnd()}…`
    : cleaned;
}

export function briefAge(createdAtMs: number, now: number): BriefAge {
  const age = now - createdAtMs;
  if (age < 60 * 60 * 1000) return 'just now';
  if (age < 24 * 60 * 60 * 1000) return 'today';
  if (age < 7 * 24 * 60 * 60 * 1000) return 'this week';
  return 'older';
}

/**
 * Open asks every member may see (see the module comment). Blocking first, then oldest first:
 * the order the inbox itself puts them in, and the order the brief should mention them.
 */
const ASKS_SQL = `
  SELECT a.id, a.kind, a.title, a.blocking, a.created_at
    FROM asks a
   WHERE a.project_id = ? AND a.status = 'open'
     AND (a.expires_at IS NULL OR a.expires_at > ?)
     AND ((a.assignee_kind = 'team' AND a.claimed_by_user_id IS NULL)
       OR NOT EXISTS (
         SELECT 1 FROM project_members pm
          WHERE pm.project_id = a.project_id AND pm.status = 'active'
            AND pm.user_id <> COALESCE(
              CASE WHEN a.assignee_kind = 'team' THEN a.claimed_by_user_id
                   ELSE a.assignee_user_id END, '')))
   ORDER BY a.blocking DESC, a.created_at ASC, a.id ASC
   LIMIT ?`;

/** Chats whose task failed recently. `julianday` reads both ISO and SQLite timestamp forms. */
const FAILED_CHATS_SQL = `
  SELECT ss.id, ss.topic, t.title
    FROM tasks t
    JOIN session_summaries ss ON ss.task_id = t.id AND ss.project_id = t.project_id
   WHERE t.project_id = ? AND t.status = 'failed'
     AND julianday(t.updated_at) >= julianday(?)
   ORDER BY t.updated_at DESC, t.id DESC
   LIMIT ?`;

/**
 * Automations whose newest finished runs all failed: the Automation page's own rule
 * (`failureStreak` ≥ `DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES`, apps/web automation model). Each
 * trigger reads only its newest few finished runs, by its own index.
 */
const FAILING_AUTOMATIONS_SQL = `
  SELECT t.id, t.name, t.status
    FROM triggers t
   WHERE t.project_id = ? AND t.status <> 'disabled'
     AND (SELECT COUNT(*) FROM (
            SELECT te.status FROM trigger_executions te
             WHERE te.trigger_id = t.id AND te.status IN ('completed', 'failed')
             ORDER BY te.sequence_number DESC, te.created_at DESC
             LIMIT ?) recent
           WHERE recent.status = 'failed') >= ?
   ORDER BY t.name ASC, t.id ASC
   LIMIT ?`;

/** Shared accounts near or past a limit. A member's own credential is never a project fact. */
const ACCOUNTS_SQL = `
  SELECT credential_reference, credential_source, provider, last_event_level
    FROM credential_limit_windows
   WHERE project_id = ? AND credential_source IN ('project', 'platform')
     AND last_event_level IN ('warning', 'critical', 'rejected')
     AND (resets_at IS NULL OR resets_at > ?)
   ORDER BY credential_reference ASC, window_type ASC`;

const MERGED_PULL_REQUESTS_SQL = `
  SELECT number, url, title
    FROM pull_requests
   WHERE project_id = ? AND state = 'merged' AND julianday(merged_at) >= julianday(?)
   ORDER BY merged_at DESC
   LIMIT ?`;

const NEW_IDEAS_SQL = `
  SELECT tasks.id, tasks.title
    FROM tasks
   WHERE tasks.project_id = ? AND ${ideaTaskPredicateSql()}
     AND tasks.status NOT IN ('completed', 'cancelled')
     AND julianday(tasks.created_at) >= julianday(?)
   ORDER BY tasks.created_at DESC, tasks.id DESC
   LIMIT ?`;

const AskRow = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.string(),
  title: v.nullable(v.string()),
  blocking: v.number(),
  created_at: v.number(),
});
const FailedChatRow = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  topic: v.nullable(v.string()),
  title: v.nullable(v.string()),
});
const AutomationRow = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.nullable(v.string()),
  status: v.string(),
});
const AccountRow = v.object({
  credential_reference: v.pipe(v.string(), v.minLength(1)),
  credential_source: v.picklist(['project', 'platform']),
  provider: v.string(),
  last_event_level: v.picklist(['warning', 'critical', 'rejected']),
});
const PullRequestRow = v.object({
  number: v.pipe(v.number(), v.integer()),
  url: v.pipe(v.string(), v.url(), v.regex(/^https:\/\//i)),
  title: v.nullable(v.string()),
});
const IdeaRow = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.nullable(v.string()),
});

/** Parse each row on its own: one malformed row costs that row, not the brief (rule 50). */
function parseRows<S extends v.GenericSchema>(
  schema: S,
  rows: readonly Record<string, unknown>[] | undefined,
  context: string,
  projectId: string
): v.InferOutput<S>[] {
  const out: v.InferOutput<S>[] = [];
  for (const raw of rows ?? []) {
    const parsed = v.safeParse(schema, raw);
    if (parsed.success) {
      out.push(parsed.output);
      continue;
    }
    log.warn('project_brief.fact_row_skipped', {
      projectId,
      context,
      rowId: typeof raw.id === 'string' ? raw.id : null,
      issue: parsed.issues[0]?.message ?? 'invalid row',
      action: 'skipped',
    });
  }
  return out;
}

const LEVEL_RANK = { warning: 1, critical: 2, rejected: 3 } as const;

function accountLabel(source: 'project' | 'platform', provider: string): string {
  const name = briefText(provider, 'model');
  return source === 'platform' ? `SAM's shared ${name} account` : `the project's ${name} account`;
}

export async function readBriefFacts(
  db: D1Database,
  projectId: string,
  now: number
): Promise<BriefFacts> {
  const limit = BRIEF_FACT_ROWS_MAX;
  const recentCutoff = new Date(now - BRIEF_RECENT_WINDOW_MS).toISOString();
  const failedCutoff = new Date(now - BRIEF_FAILED_CHAT_WINDOW_MS).toISOString();
  const all = (sql: string, ...params: unknown[]) =>
    db
      .prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  const threshold = DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES;
  const [asks, running, failed, automations, accounts, pulls, ideas] = await Promise.all([
    all(ASKS_SQL, projectId, now, limit),
    // A viewer id that matches nobody: the facts are the same for every member.
    readRunningChats(db, projectId, '', limit),
    all(FAILED_CHATS_SQL, projectId, failedCutoff, limit),
    all(FAILING_AUTOMATIONS_SQL, projectId, threshold, threshold, limit),
    all(ACCOUNTS_SQL, projectId, now),
    all(MERGED_PULL_REQUESTS_SQL, projectId, recentCutoff, limit),
    all(NEW_IDEAS_SQL, projectId, recentCutoff, limit),
  ]);

  // One line per account, at its worst window.
  const byAccount = new Map<string, BriefFacts['accounts'][number]>();
  for (const row of parseRows(AccountRow, accounts, 'accounts', projectId)) {
    const current = byAccount.get(row.credential_reference);
    if (current && LEVEL_RANK[current.level] >= LEVEL_RANK[row.last_event_level]) continue;
    byAccount.set(row.credential_reference, {
      id: row.credential_reference,
      label: accountLabel(row.credential_source, row.provider),
      level: row.last_event_level,
    });
  }

  return {
    asks: parseRows(AskRow, asks, 'asks', projectId).map((row) => ({
      id: row.id,
      kind: briefText(row.kind, 'question'),
      title: briefText(row.title, 'An open item'),
      blocking: row.blocking === 1,
      age: briefAge(row.created_at, now),
    })),
    runningChats: running.items.map((chat) => ({
      id: chat.sessionId,
      topic: briefText(chat.topic, 'A new chat'),
      state: chat.state,
    })),
    failedChats: parseRows(FailedChatRow, failed, 'failedChats', projectId).map((row) => ({
      id: row.id,
      topic: briefText(row.topic ?? row.title, 'A chat'),
    })),
    failingAutomations: parseRows(AutomationRow, automations, 'automations', projectId).map(
      (row) => ({
        id: row.id,
        name: briefText(row.name, 'An automation'),
        paused: row.status === 'paused',
      })
    ),
    accounts: [...byAccount.values()].slice(0, limit),
    mergedPullRequests: parseRows(PullRequestRow, pulls, 'pullRequests', projectId).map(
      (row) => ({
        number: row.number,
        url: row.url,
        title: briefText(row.title, `Pull request`),
      })
    ),
    newIdeas: parseRows(IdeaRow, ideas, 'ideas', projectId).map((row) => ({
      id: row.id,
      title: briefText(row.title, 'An idea'),
    })),
  };
}

/**
 * Nothing needs a person and nothing is running: a brief would only restate the tiles, so none
 * is made or shown (spec: "show nothing").
 */
export function briefFactsAreQuiet(facts: BriefFacts): boolean {
  return (
    facts.asks.length === 0 &&
    facts.runningChats.length === 0 &&
    facts.failedChats.length === 0 &&
    facts.failingAutomations.length === 0 &&
    facts.accounts.length === 0
  );
}

/**
 * The changes that matter, as one string: an item opened or closed, a chat started, changed
 * state, finished or failed, an automation started failing or recovered, an account crossed a
 * level. Pull requests and ideas are inputs but do not by themselves warrant a new brief.
 * Sorted, so the same facts in a different row order give the same fingerprint.
 */
export function briefFactsMaterial(facts: BriefFacts): string {
  const sorted = (values: string[]) => [...values].sort().join(',');
  return [
    `asks:${sorted(facts.asks.map((ask) => `${ask.id}:${ask.blocking ? 1 : 0}`))}`,
    `running:${sorted(facts.runningChats.map((chat) => `${chat.id}:${chat.state}`))}`,
    `failed:${sorted(facts.failedChats.map((chat) => chat.id))}`,
    `automations:${sorted(facts.failingAutomations.map((a) => `${a.id}:${a.paused ? 1 : 0}`))}`,
    `accounts:${sorted(facts.accounts.map((account) => `${account.id}:${account.level}`))}`,
  ].join('|');
}

export async function briefFactsFingerprint(facts: BriefFacts): Promise<string> {
  const bytes = new TextEncoder().encode(briefFactsMaterial(facts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
