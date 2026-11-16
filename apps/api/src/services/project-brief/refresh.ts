/**
 * Keep a project's Overview brief current (inbox slice I, spec 4.3). Runs after an Overview
 * response, in the background (`waitUntil`): a page view never waits on it or on the model.
 *
 * Each call walks one decision, and logs which way it went (`project_brief.refresh`):
 *
 * 1. `disabled`: the admin switch is off.
 * 2. `not_due`: another check ran within `checkIntervalSeconds`. Decided by one compare-and-set
 *    write on `checked_at`, so concurrent page views make one check, not one each.
 * 3. Read the facts (`readBriefFacts`) and fingerprint the ones that matter.
 *    `unchanged`: same fingerprint as the stored brief.
 *    `quiet`: nothing needs anyone and nothing is happening; an empty brief is stored, no model.
 *    `deferred`: changed, but the last brief is younger than `minIntervalMinutes`; marked stale.
 * 4. Claim a generation with a compare-and-set that also enforces the daily cap and the minimum
 *    interval. `capped` / `busy`: not claimed; the stored brief stays, marked stale.
 * 5. Call the model through the SAM AI Gateway (`fetchWorkersAIChatCompletion`), validate the
 *    reply (`parseBriefReply`), and write it under the claim. `generated` or `failed`.
 *
 * Cost bound: at most `dailyCap` model calls per project per UTC day, and never two within
 * `minIntervalMinutes`. The count is taken when the call is claimed, so failures spend it too.
 */
import {
  BRIEF_PENDING_TTL_MS,
  briefFactsAreQuiet,
  briefFactsFingerprint,
  type ProjectBriefSettings,
  readBriefFacts,
} from '@simple-agent-manager/operations';
import { DEFAULT_PROJECT_BRIEF_MODEL } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { fetchWorkersAIChatCompletion, WorkersAIGatewayError } from '../ai-proxy-shared';
import { getTaskTitleModelControls } from '../task-title';
import { parseBriefReply } from './parse';
import { buildBriefPrompt } from './prompt';

/** Most output tokens one brief may use: three short sentences of JSON. */
export const BRIEF_MAX_OUTPUT_TOKENS = 400;
/** One model call's time budget. Background only, so it never delays a page. */
export const BRIEF_MODEL_TIMEOUT_MS = 20_000;
/** Characters of a provider error kept for the operator. */
const BRIEF_ERROR_MAX_CHARS = 300;

export type BriefRefreshOutcome =
  | 'disabled'
  | 'not_due'
  | 'unchanged'
  | 'quiet'
  | 'deferred'
  | 'capped'
  | 'busy'
  | 'generated'
  | 'failed';

export interface BriefRefreshInput {
  env: Env;
  projectId: string;
  settings: ProjectBriefSettings;
  now?: number;
}

const CLAIM_CHECK_SQL = `
  INSERT INTO project_briefs (project_id, checked_at, updated_at) VALUES (?1, ?2, ?2)
  ON CONFLICT(project_id) DO UPDATE SET checked_at = excluded.checked_at,
                                        updated_at = excluded.updated_at
   WHERE project_briefs.checked_at IS NULL OR project_briefs.checked_at <= ?3`;

const READ_STATE_SQL = `
  SELECT fingerprint, generated_at, stale, last_error_at FROM project_briefs WHERE project_id = ?`;

/**
 * The generation claim. SQLite evaluates every SET expression against the row as it was, so the
 * day rollover and the increment read the same old values the WHERE clause checked.
 */
const CLAIM_GENERATION_SQL = `
  UPDATE project_briefs
     SET pending_since = ?1,
         generation_count = CASE WHEN generation_day = ?2 THEN generation_count + 1 ELSE 1 END,
         generation_day = ?2,
         updated_at = ?1
   WHERE project_id = ?3
     AND (pending_since IS NULL OR pending_since <= ?4)
     AND (CASE WHEN generation_day = ?2 THEN generation_count ELSE 0 END) < ?5
     AND (generated_at IS NULL OR generated_at <= ?6)
     AND (last_error_at IS NULL OR last_error_at <= ?6)`;

const StateRow = v.object({
  fingerprint: v.nullable(v.string()),
  generated_at: v.nullable(v.number()),
  stale: v.nullable(v.number()),
  last_error_at: v.nullable(v.number()),
});

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function markStale(db: D1Database, projectId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE project_briefs SET stale = 1, updated_at = ? WHERE project_id = ? AND stale = 0`
    )
    .bind(now, projectId)
    .run();
}

async function callModel(env: Env, messages: ReturnType<typeof buildBriefPrompt>['messages']) {
  const controls = getTaskTitleModelControls(DEFAULT_PROJECT_BRIEF_MODEL);
  return fetchWorkersAIChatCompletion(env, {
    modelId: DEFAULT_PROJECT_BRIEF_MODEL,
    maxTokens: BRIEF_MAX_OUTPUT_TOKENS,
    timeoutMs: BRIEF_MODEL_TIMEOUT_MS,
    metadata: { source: 'project-brief', modelId: DEFAULT_PROJECT_BRIEF_MODEL },
    responseLabel: 'project_brief.gateway_response',
    reasoningEffort: controls.reasoningEffort,
    chatTemplateKwargs: controls.chatTemplateKwargs,
    errorDiagnosticMaxLength: BRIEF_ERROR_MAX_CHARS,
    messages,
  });
}

async function refresh(input: BriefRefreshInput): Promise<BriefRefreshOutcome> {
  const { env, projectId, settings } = input;
  const db = env.DATABASE;
  const now = input.now ?? Date.now();
  if (!settings.enabled) return 'disabled';

  const checkCutoff = now - settings.checkIntervalSeconds * 1000;
  const claimed = await db.prepare(CLAIM_CHECK_SQL).bind(projectId, now, checkCutoff).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return 'not_due';

  const [stateRaw, facts] = await Promise.all([
    db.prepare(READ_STATE_SQL).bind(projectId).first<Record<string, unknown>>(),
    readBriefFacts(db, projectId, now),
  ]);
  const state = v.safeParse(StateRow, stateRaw);
  if (!state.success) throw new Error('project_briefs row unreadable after check claim');
  const fingerprint = await briefFactsFingerprint(facts);

  if (state.output.generated_at !== null && state.output.fingerprint === fingerprint) {
    if (state.output.stale === 1) {
      await db
        .prepare(`UPDATE project_briefs SET stale = 0, updated_at = ? WHERE project_id = ?`)
        .bind(now, projectId)
        .run();
    }
    return 'unchanged';
  }

  if (briefFactsAreQuiet(facts)) {
    await db
      .prepare(
        `UPDATE project_briefs
            SET brief_json = NULL, ref_asks_json = '[]', ref_chats_json = '[]',
                ref_automations_json = '[]', fingerprint = ?, generated_at = ?, stale = 0,
                updated_at = ?
          WHERE project_id = ? AND pending_since IS NULL`
      )
      .bind(fingerprint, now, now, projectId)
      .run();
    return 'quiet';
  }

  const minCutoff = now - settings.minIntervalMinutes * 60_000;
  // A failed attempt waits out the same interval as a success, so a model that keeps failing
  // costs at most one call per interval rather than one per check.
  const lastAttempt = Math.max(state.output.generated_at ?? 0, state.output.last_error_at ?? 0);
  if (lastAttempt > minCutoff) {
    await markStale(db, projectId, now);
    return 'deferred';
  }

  const generation = await db
    .prepare(CLAIM_GENERATION_SQL)
    .bind(now, utcDay(now), projectId, now - BRIEF_PENDING_TTL_MS, settings.dailyCap, minCutoff)
    .run();
  if ((generation.meta?.changes ?? 0) !== 1) {
    await markStale(db, projectId, now);
    const row = await db
      .prepare(`SELECT generation_day, generation_count FROM project_briefs WHERE project_id = ?`)
      .bind(projectId)
      .first<{ generation_day: string | null; generation_count: number }>();
    return row?.generation_day === utcDay(now) && row.generation_count >= settings.dailyCap
      ? 'capped'
      : 'busy';
  }

  const prompt = buildBriefPrompt(facts);
  let reason: string;
  try {
    const reply = await callModel(env, prompt.messages);
    const parsed = parseBriefReply(reply, prompt.handles);
    if (parsed.ok) {
      const written = await db
        .prepare(
          `UPDATE project_briefs
              SET brief_json = ?, ref_asks_json = ?, ref_chats_json = ?, ref_automations_json = ?,
                  fingerprint = ?, generated_at = ?, stale = 0, pending_since = NULL,
                  last_error = NULL, updated_at = ?
            WHERE project_id = ? AND pending_since = ?`
        )
        .bind(
          JSON.stringify(parsed.brief),
          JSON.stringify(parsed.refAsks),
          JSON.stringify(parsed.refRunningChats),
          JSON.stringify(parsed.refAutomations),
          fingerprint,
          now,
          Date.now(),
          projectId,
          now
        )
        .run();
      if (parsed.dropped > 0) {
        log.warn('project_brief.sentences_rejected', { projectId, dropped: parsed.dropped });
      }
      return (written.meta?.changes ?? 0) === 1 ? 'generated' : 'busy';
    }
    reason = parsed.reason;
  } catch (error) {
    reason =
      error instanceof WorkersAIGatewayError
        ? `gateway_${error.status}`
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'model_call_failed';
    log.warn('project_brief.model_call_failed', {
      projectId,
      reason,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        BRIEF_ERROR_MAX_CHARS
      ),
    });
  }

  // Keep the old brief; the read hides it now that it is stale and the catch-up failed.
  await db
    .prepare(
      `UPDATE project_briefs
          SET pending_since = NULL, stale = 1, last_error = ?, last_error_at = ?, updated_at = ?
        WHERE project_id = ? AND pending_since = ?`
    )
    .bind(reason, now, Date.now(), projectId, now)
    .run();
  log.warn('project_brief.generation_rejected', { projectId, reason });
  return 'failed';
}

/** Never throws: a broken brief must not touch the page it sits on. */
export async function refreshProjectBriefIfDue(
  input: BriefRefreshInput
): Promise<BriefRefreshOutcome | 'error'> {
  try {
    const outcome = await refresh(input);
    log.info('project_brief.refresh', { projectId: input.projectId, outcome });
    return outcome;
  } catch (error) {
    log.error('project_brief.refresh_failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
      action: 'skipped',
    });
    return 'error';
  }
}
