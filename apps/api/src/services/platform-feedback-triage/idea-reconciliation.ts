/**
 * Hourly reconciliation of incident ideas (run from `scheduled/platform-feedback-hourly.ts`).
 *
 * Incidents end through many writers (resolve/reject from the triage agent, max-age and
 * stale-singleton expiry, dispatch-attempt exhaustion, diagnosis failure), so closing their
 * ideas is reconciled here from the stored state rather than bolted onto each writer.
 *
 * 1. Adopt: a legacy idea (no ownership record, filed before ownership tracking) whose title,
 *    body, priority and status are still exactly what the pipeline generated, and which has no
 *    chat link, note, file or pull request, becomes owned. Anything else stays tracked work.
 * 2. Close: an owned draft idea whose incident is resolved, rejected or expired is cancelled.
 * 3. Retitle: an owned idea whose open incident still has the legacy generic summary gets a
 *    readable one from a representative error message.
 *
 * Every candidate is re-checked against the Durable Object first; an engaged idea is released
 * instead (never cancelled, never retitled). Each candidate leaves its step's candidate set in one
 * pass: cancelled, released, adopted, retitled or (retitle only) marked as unrecoverable.
 *
 * Throughput: one batch is one D1 read, one Durable Object read and one D1 batch, well under a
 * second. At the default 25 per batch and 20 s deadline a run handles several hundred ideas; the
 * 2026-11 backlog (~300 legacy ideas) clears in the first run, and a 2,000-idea backlog in a few
 * hourly runs.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveFleetOpsSettings } from '../fleet-ops/settings';
import {
  cancelOwnedIncidentIdea,
  configuredFeedbackProjectId,
  ideaHasEngagement,
  type IdeaWorkSnapshotReader,
  PIPELINE_IDEA_TRIGGERED_BY,
  pipelineOwnsIdeaSql,
  readIdeaEngagement,
  releaseEngagedIncidentIdeas,
} from '../platform-feedback-incidents';
import {
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_IDEA_TITLE_MAX_LENGTH,
  displayPlatformErrorMessage,
  parseStoredEvidenceRefs,
  platformErrorSummary,
} from './grouping';
import { refreshOwnedIdea } from './idea-refresh';
import { positive } from './numbers';
import type { FeedbackErrorGroup } from './types';

/**
 * Generated body markers of a pre-ownership idea (`ideaDescription` before 2026-11). Matched
 * with `substr`/`instr`, not `LIKE`: D1 rejects LIKE patterns longer than
 * `D1_MAX_LIKE_PATTERN_BYTES` ("LIKE or GLOB pattern too complex"), which local SQLite allows.
 */
export const LEGACY_BODY_HEADING = '## Maintainer Instructions';
export const LEGACY_BODY_SUMMARY = 'Triage this automated platform feedback report';
export const LEGACY_TITLE_PATTERN = 'Recurring % platform error';
/** D1's LIKE pattern ceiling (SQLITE_LIMIT_LIKE_PATTERN_LENGTH on Cloudflare D1). */
export const D1_MAX_LIKE_PATTERN_BYTES = 50;
const TERMINAL_INCIDENT_SQL = "('resolved', 'rejected', 'expired')";
/**
 * `tasks.triggered_by` values a legacy pipeline idea can carry. Ideas filed before the pipeline
 * set `triggered_by = 'incident'` kept the column default, 'user': on 2026-11-20 production had
 * 320 unowned legacy ideas with 'user' (305 of them in the exact generated shape) and 1 with
 * 'incident'. Adoption still requires the exact generated title and body, a
 * draft at priority 0, the triage row's own link and no Durable Object engagement, and it
 * rewrites the column to 'incident' in the same transaction so `pipelineOwnsIdeaSql` holds.
 */
const LEGACY_PIPELINE_IDEA_TRIGGERED_BY_SQL = `('${PIPELINE_IDEA_TRIGGERED_BY}', 'user')`;

export interface IncidentIdeaReconciliationResult {
  enabled: boolean;
  adopted: number;
  cancelled: number;
  retitled: number;
  released: number;
  /** Steps that threw; the others still ran. */
  failedSteps: string[];
  deadlineReached: boolean;
}

export interface IncidentIdeaReconciliationDeps {
  now?: () => number;
  readEngagement?: IdeaWorkSnapshotReader;
  batchSize?: number;
  deadlineMs?: number;
  ideaTitleMaxLength?: number;
}

interface Candidate {
  signature: string;
  idea_id: string;
}

interface StepContext {
  env: Env;
  projectId: string;
  now: () => number;
  deadlineAt: number;
  batchSize: number;
  ideaTitleMaxLength: number;
  readEngagement: IdeaWorkSnapshotReader;
  result: IncidentIdeaReconciliationResult;
}

/** Splits a batch into engaged (released) and untouched candidates. */
async function untouchedOnly(ctx: StepContext, rows: Candidate[]): Promise<Candidate[]> {
  const snapshots = await ctx.readEngagement(
    ctx.env,
    ctx.projectId,
    rows.map((row) => row.idea_id)
  );
  const engaged = rows.filter((row) => ideaHasEngagement(snapshots[row.idea_id]));
  if (engaged.length > 0) {
    // Mark released so the row leaves every candidate set, then report the count.
    await releaseEngagedIncidentIdeas(
      ctx.env,
      ctx.projectId,
      engaged.map((row) => ({ signature: row.signature, ideaId: row.idea_id })),
      async () => snapshots
    );
    ctx.result.released += engaged.length;
  }
  return rows.filter((row) => !ideaHasEngagement(snapshots[row.idea_id]));
}

async function adoptLegacyIdeas(ctx: StepContext): Promise<void> {
  while (ctx.now() < ctx.deadlineAt) {
    const rows = await ctx.env.DATABASE.prepare(
      `SELECT triage.signature, triage.idea_id, idea.updated_at
       FROM platform_feedback_triages triage
       JOIN tasks idea ON idea.id = triage.idea_id
       WHERE triage.idea_owned_at IS NULL
         AND idea.project_id = ?
         AND idea.triggered_by IN ${LEGACY_PIPELINE_IDEA_TRIGGERED_BY_SQL}
         AND idea.status = 'draft' AND idea.priority = 0
         AND idea.title LIKE ?
         AND substr(idea.description, 1, ?) = ?
         AND instr(idea.description, ?) > 0
         AND substr(rtrim(idea.description, char(9, 10, 13, 32)), -3) = '\`\`\`'
       ORDER BY triage.signature
       LIMIT ?`
    )
      .bind(
        ctx.projectId,
        LEGACY_TITLE_PATTERN,
        LEGACY_BODY_HEADING.length,
        LEGACY_BODY_HEADING,
        LEGACY_BODY_SUMMARY,
        ctx.batchSize
      )
      .all<Candidate & { updated_at: string }>();
    const batch = rows.results ?? [];
    if (batch.length === 0) return;
    const untouched = await untouchedOnly(ctx, batch);
    const updatedAt = new Map(batch.map((row) => [row.signature, row.updated_at]));
    if (untouched.length > 0) {
      // Compare-and-set on the `updated_at` read with the candidate: an edit that lands while
      // the Durable Object is being read moves it, and that idea is not adopted. It then fails
      // the selector's shape checks or stays NULL until the next run re-reads it.
      // One transaction for the batch; per idea, mark it as the pipeline's (the column legacy
      // ideas lack) only while its triage row is still unowned, then record ownership only if
      // that exact, unedited idea was marked.
      const results = await ctx.env.DATABASE.batch(
        untouched.flatMap((row) => [
          ctx.env.DATABASE.prepare(
            `UPDATE tasks SET triggered_by = '${PIPELINE_IDEA_TRIGGERED_BY}'
             WHERE id = ? AND updated_at = ? AND status = 'draft' AND priority = 0
               AND triggered_by IN ${LEGACY_PIPELINE_IDEA_TRIGGERED_BY_SQL}
               AND EXISTS (SELECT 1 FROM platform_feedback_triages
                           WHERE signature = ? AND idea_id = ? AND idea_owned_at IS NULL)`
          ).bind(row.idea_id, updatedAt.get(row.signature), row.signature, row.idea_id),
          ctx.env.DATABASE.prepare(
            `UPDATE platform_feedback_triages SET idea_owned_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE signature = ? AND idea_id = ? AND idea_owned_at IS NULL
               AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?
                           AND status = 'draft' AND priority = 0
                           AND triggered_by = '${PIPELINE_IDEA_TRIGGERED_BY}')`
          ).bind(
            updatedAt.get(row.signature),
            row.signature,
            row.idea_id,
            row.idea_id,
            updatedAt.get(row.signature)
          ),
        ])
      );
      // Ownership writes are every second statement.
      const ownership = results.filter((_, index) => index % 2 === 1);
      const adopted = ownership.reduce((sum, item) => sum + (item.meta.changes ?? 0), 0);
      ctx.result.adopted += adopted;
      // A lost compare leaves the row selectable; stop rather than spin on it this run.
      if (adopted < untouched.length) return;
    }
  }
  ctx.result.deadlineReached = true;
}

async function closeEndedIncidentIdeas(ctx: StepContext): Promise<void> {
  while (ctx.now() < ctx.deadlineAt) {
    const rows = await ctx.env.DATABASE.prepare(
      `SELECT triage.signature, triage.idea_id, triage.queue_state
       FROM platform_feedback_triages triage
       JOIN tasks idea ON idea.id = triage.idea_id
       WHERE triage.queue_state IN ${TERMINAL_INCIDENT_SQL}
         AND idea.project_id = ?
         AND idea.status = 'draft'
         AND ${pipelineOwnsIdeaSql('triage', 'idea')}
       ORDER BY triage.signature
       LIMIT ?`
    )
      .bind(ctx.projectId, ctx.batchSize)
      .all<Candidate & { queue_state: string }>();
    const batch = rows.results ?? [];
    if (batch.length === 0) return;
    const untouched = await untouchedOnly(ctx, batch);
    const writtenAt = new Date(ctx.now()).toISOString();
    for (const row of untouched) {
      const state = batch.find((item) => item.signature === row.signature)?.queue_state;
      const cancelled = await cancelOwnedIncidentIdea(
        ctx.env,
        { signature: row.signature, ideaId: row.idea_id, projectId: ctx.projectId },
        `Incident ${state ?? 'ended'}; closed its automated idea`,
        writtenAt
      );
      if (cancelled) ctx.result.cancelled += 1;
    }
    // A candidate that was neither released nor cancelled lost ownership to a concurrent
    // write in this pass and no longer matches the selector, so the loop still progresses.
  }
  ctx.result.deadlineReached = true;
}

async function representativeMessage(env: Env, evidenceRefs: string): Promise<string | null> {
  const ids = parseStoredEvidenceRefs(evidenceRefs, 5).map((item) => item.errorId);
  if (ids.length === 0) return null;
  const row = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT message FROM platform_errors WHERE id IN (${ids.map(() => '?').join(', ')})
     ORDER BY timestamp DESC LIMIT 1`
  )
    .bind(...ids)
    .first<{ message: string }>();
  return row?.message ?? null;
}

async function retitleLegacyIdeas(ctx: StepContext): Promise<void> {
  // A row whose errors were purged keeps its generic summary; `seen` stops it being picked
  // again in this run, and the next run tries it once more at the same cost.
  const seen = new Set<string>();
  while (ctx.now() < ctx.deadlineAt) {
    const rows = await ctx.env.DATABASE.prepare(
      `SELECT triage.signature, triage.idea_id, triage.source, triage.severity,
         triage.evidence_refs, triage.diagnosis_id, triage.first_seen_at, triage.last_seen_at,
         triage.occurrence_count
       FROM platform_feedback_triages triage
       JOIN tasks idea ON idea.id = triage.idea_id
       WHERE triage.queue_state NOT IN ${TERMINAL_INCIDENT_SQL}
         AND triage.summary LIKE ?
         AND idea.project_id = ?
         AND ${pipelineOwnsIdeaSql('triage', 'idea')}
       ORDER BY triage.signature
       LIMIT ?`
    )
      .bind(LEGACY_TITLE_PATTERN, ctx.projectId, ctx.batchSize + seen.size)
      .all<
        Candidate & {
          source: string;
          severity: string | null;
          evidence_refs: string;
          diagnosis_id: string | null;
          first_seen_at: number;
          last_seen_at: number;
          occurrence_count: number;
        }
      >();
    const batch = (rows.results ?? []).filter((row) => !seen.has(row.signature));
    if (batch.length === 0) return;
    for (const row of batch) seen.add(row.signature);
    const untouched = new Set((await untouchedOnly(ctx, batch)).map((row) => row.signature));
    for (const row of batch) {
      if (!untouched.has(row.signature)) continue;
      const raw = await representativeMessage(ctx.env, row.evidence_refs);
      if (!raw) continue;
      const message = displayPlatformErrorMessage(raw);
      const summary = platformErrorSummary(row.source, message);
      const group: FeedbackErrorGroup = {
        signature: row.signature,
        source: row.source,
        severity: row.severity === 'warn' ? 'warn' : 'error',
        summary,
        message,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        evidence: parseStoredEvidenceRefs(row.evidence_refs, 10),
        count: row.occurrence_count,
      };
      // Idea first, then the stored summary: if the idea write throws, the row keeps the
      // legacy summary and is retried next run instead of leaving with a generic idea title.
      const updated = await refreshOwnedIdea(ctx.env, {
        group,
        signature: row.signature,
        ideaId: row.idea_id,
        projectId: ctx.projectId,
        diagnosisId: row.diagnosis_id ?? 'pending',
        ideaTitleMaxLength: ctx.ideaTitleMaxLength,
        writtenAt: new Date(ctx.now()).toISOString(),
        title: summary,
      });
      await ctx.env.DATABASE.prepare(
        `UPDATE platform_feedback_triages SET summary = ?, updated_at = CURRENT_TIMESTAMP
         WHERE signature = ? AND summary LIKE ?`
      )
        .bind(summary, row.signature, LEGACY_TITLE_PATTERN)
        .run();
      if (updated) ctx.result.retitled += 1;
    }
  }
  ctx.result.deadlineReached = true;
}

const STEPS: Array<[string, (ctx: StepContext) => Promise<void>]> = [
  ['adopt_legacy', adoptLegacyIdeas],
  ['close_ended', closeEndedIncidentIdeas],
  ['retitle_legacy', retitleLegacyIdeas],
];

export async function reconcileIncidentIdeas(
  env: Env,
  deps: IncidentIdeaReconciliationDeps = {}
): Promise<IncidentIdeaReconciliationResult> {
  const result: IncidentIdeaReconciliationResult = {
    enabled: false,
    adopted: 0,
    cancelled: 0,
    retitled: 0,
    released: 0,
    failedSteps: [],
    deadlineReached: false,
  };
  const projectId = await configuredFeedbackProjectId(env);
  if (!projectId) return result;
  result.enabled = true;
  const now = deps.now ?? Date.now;
  const settings = deps.batchSize && deps.deadlineMs ? null : await resolveFleetOpsSettings(env);
  const ctx: StepContext = {
    env,
    projectId,
    now,
    deadlineAt: now() + (deps.deadlineMs ?? settings?.incidentIdeaReconcileDeadlineMs ?? 0),
    batchSize: deps.batchSize ?? settings?.incidentIdeaReconcileBatchSize ?? 1,
    ideaTitleMaxLength:
      deps.ideaTitleMaxLength ??
      positive(
        env.SAM_IDEA_TITLE_MAX_LENGTH,
        DEFAULT_PLATFORM_FEEDBACK_TRIAGE_IDEA_TITLE_MAX_LENGTH
      ),
    readEngagement: deps.readEngagement ?? readIdeaEngagement,
    result,
  };
  for (const [name, step] of STEPS) {
    try {
      await step(ctx);
    } catch (error) {
      result.failedSteps.push(name);
      log.error('platform_feedback_triage.idea_reconcile_step_failed', {
        step: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.info('platform_feedback_triage.idea_reconcile_completed', { ...result });
  return result;
}
