/**
 * Insights · Flow (slice F, idea 01M7HTS38KX2G78JD0ESAGMKKH): how work moves from idea to merged
 * in one project, over 7, 30 or 90 days. The one shared read behind the Insights page's Flow tab
 * and the Project Overview's "This week" pane (policy 5cb362e8: every surface is a thin adapter).
 *
 * Everything is derived at read time; nothing is stored. Definitions live beside their SQL in
 * `insights-flow-sql.ts` and `insights-flow-stop-reasons.ts`.
 *
 * Round trips (rule 60, budget 12 in the Insights spec): authorization 1; settings 0 or 1 (the
 * per-isolate admin-settings cache); one D1 `batch()` carrying seven aggregate statements 1; the
 * idea evidence the Ideas list uses (`ideaItemsWithPullRequests`: repository, one ProjectData RPC,
 * linked tasks, their pull request associations, profile names when any task has one, pull request
 * states, each one statement whatever the number of ids) at most 6; the rework statement 1. At
 * most 10; measured 8 with 120 linked tasks (`insights-flow.test.ts`, "stays within its
 * round-trip budget"). If the batch fails as a whole, each statement is retried on its own so one
 * bad section cannot blank the page; that degraded path costs six more and is logged.
 */
import {
  DEFAULT_INSIGHTS_RANGE,
  FLOW_DELIBERATE_STOP_REASONS,
  FLOW_STOP_REASONS,
  type FlowRunsBucket,
  type FlowSection,
  type FlowStopReason,
  type FlowTopBlocker,
  type FlowWaitingIdea,
  type IdeaListItem,
  type IdeaPullRequest,
  INSIGHTS_RANGE_DAYS,
  type InsightsRange,
  isInsightsRange,
  type ProjectFlowResponse,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { ideaItemsWithPullRequests } from './idea-list-core';
import type { IdeaRow } from './idea-list-reads';
import { getInsightsFlowLimits } from './insights-flow-settings';
import {
  asksStatement,
  ciFirstTryStatement,
  flakyStatement,
  type FlowStatement,
  type FlowWindow,
  ideaSampleStatement,
  mergedStatement,
  reworkStatement,
  runsStatement,
  waitingIdeasStatement,
} from './insights-flow-sql';
import type { OperationContext } from './types';

const DAY_MS = 86_400_000;

export interface ProjectFlowInput {
  projectId: string;
  /** `7d`, `30d` or `90d`; omitted means `DEFAULT_INSIGHTS_RANGE`. */
  range?: unknown;
  /** Test seam: the instant the range ends at. */
  nowMs?: number;
}

type Rows = Record<string, unknown>[];
type BatchKey = 'runs' | 'merged' | 'ci' | 'flaky' | 'asks' | 'waiting' | 'sample';
const SECTION_OF: Record<BatchKey, FlowSection> = {
  runs: 'runs',
  merged: 'merged',
  ci: 'ci',
  flaky: 'flaky',
  asks: 'asks',
  waiting: 'ideas',
  sample: 'ideas',
};

const num = v.nullish(v.number());
const RunsRowSchema = v.object({
  kind: v.picklist(['bucket', 'reason']),
  key: v.nullable(v.string()),
  merged: num,
  closed: num,
  failed: num,
  stopped: num,
  pr_open: num,
  no_pr: num,
});
const FlakyRowSchema = v.object({
  check_key: v.string(),
  flips: v.number(),
  commits: v.number(),
  total: v.number(),
});
const AsksRowSchema = v.object({ current: v.number(), n: v.number(), median_ms: num });
const IdeaRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.string(),
  description: v.nullable(v.string()),
  status: v.string(),
  triggered_by: v.nullable(v.string()),
  connector_client_name: v.nullable(v.string()),
  idea_merge_ack_at: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
});

export async function projectFlow(
  ctx: OperationContext,
  input: ProjectFlowInput
): Promise<ProjectFlowResponse> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const range = input.range === undefined ? DEFAULT_INSIGHTS_RANGE : input.range;
  if (!isInsightsRange(range)) {
    throw new OperationError('invalid_input', 'range must be one of 7d, 30d, 90d');
  }
  await authorizeProjectOperation(ctx, projectId);
  const limits = await getInsightsFlowLimits(ctx);
  const w = flowWindow(projectId, range, input.nowMs ?? Date.now());

  const unavailable = new Set<FlowSection>();
  const rows = await runBatch(
    ctx,
    projectId,
    {
      runs: runsStatement(w),
      merged: mergedStatement(w),
      ci: ciFirstTryStatement(w),
      flaky: flakyStatement(w, limits.flakyChecksLimit),
      asks: asksStatement(w),
      waiting: waitingIdeasStatement(w, limits.waitingIdeasLimit),
      sample: ideaSampleStatement(w, limits.ideaSampleCap),
    },
    unavailable
  );

  // Ideas: the waiting list and the "idea to merged" sample share one evidence read.
  const waitingRows = parseRows(rows.waiting, IdeaRowSchema, 'waiting_idea', projectId);
  const sampleRaw = parseRows(rows.sample, IdeaRowSchema, 'sample_idea', projectId);
  const sampleTruncated = sampleRaw.length > limits.ideaSampleCap;
  const sampleRows = sampleRaw.slice(0, limits.ideaSampleCap);
  const evidenceRows = uniqueRows([...waitingRows, ...sampleRows]);
  let evidence: Array<{ item: IdeaListItem; pullRequests: IdeaPullRequest[] }> = [];
  if (evidenceRows.length > 0) {
    try {
      evidence = await ideaItemsWithPullRequests(ctx, projectId, evidenceRows);
    } catch (error) {
      sectionFailed(projectId, 'ideas', error, unavailable);
    }
  }
  const byIdea = new Map(evidence.map((entry) => [entry.item.ideaId, entry]));

  const rework = await readRework(ctx, w, limits.reworkWindowDays, evidence, unavailable);
  const runs = toRuns(rows.runs, w, projectId);
  const flaky = toFlaky(rows.flaky, projectId);

  return {
    projectId,
    range,
    since: w.since,
    until: new Date(w.nowMs).toISOString(),
    tiles: {
      ideaToMerged: {
        ...ideaToMerged(evidence, w),
        sampled: {
          ideas: sampleRows.length,
          cap: limits.ideaSampleCap,
          truncated: sampleTruncated,
        },
      },
      ciFirstTry: toCiFirstTry(rows.ci?.[0]),
      waitingOnPerson: toAsks(rows.asks, projectId),
      rework: { ...rework, windowDays: limits.reworkWindowDays },
    },
    merged: {
      count: numberOr0(rows.merged?.[0]?.current),
      previous: numberOr0(rows.merged?.[0]?.previous),
    },
    runs: runs.runs,
    stopReasons: runs.stopReasons,
    flakyChecks: flaky,
    waitingIdeas: {
      items: waitingRows.flatMap((row) => {
        const entry = byIdea.get(row.id);
        return entry ? [toWaitingIdea(entry.item)] : [];
      }),
      total: numberOr0(rows.waiting?.[0]?.total),
    },
    topBlocker: topBlocker(runs.stopReasons, flaky.items),
    unavailable: [...unavailable],
    generatedAt: new Date().toISOString(),
  };
}

export function flowWindow(projectId: string, range: InsightsRange, nowMs: number): FlowWindow {
  const days = INSIGHTS_RANGE_DAYS[range];
  const sinceMs = nowMs - days * DAY_MS;
  const prevSinceMs = nowMs - 2 * days * DAY_MS;
  return {
    projectId,
    since: new Date(sinceMs).toISOString(),
    prevSince: new Date(prevSinceMs).toISOString(),
    sinceMs,
    prevSinceMs,
    nowMs,
    bucket: range === '7d' ? 'day' : 'week',
  };
}

/** One `batch()` round trip; if it fails as a whole, each statement on its own, isolated. */
async function runBatch(
  ctx: OperationContext,
  projectId: string,
  statements: Record<BatchKey, FlowStatement>,
  unavailable: Set<FlowSection>
): Promise<Partial<Record<BatchKey, Rows>>> {
  const keys = Object.keys(statements) as BatchKey[];
  const prepared = keys.map((key) =>
    ctx.env.DATABASE.prepare(statements[key].sql).bind(...statements[key].binds)
  );
  try {
    const results = await ctx.env.DATABASE.batch<Record<string, unknown>>(prepared);
    return Object.fromEntries(keys.map((key, i) => [key, results[i]?.results ?? []]));
  } catch (error) {
    log.error('insights_flow.batch_failed', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
      action: 'retrying_statements_individually',
    });
  }
  const settled = await Promise.all(
    prepared.map(async (statement, i) => {
      const key = keys[i] as BatchKey;
      try {
        const result = await statement.all<Record<string, unknown>>();
        return [key, result.results ?? []] as const;
      } catch (error) {
        sectionFailed(projectId, SECTION_OF[key], error, unavailable);
        return [key, undefined] as const;
      }
    })
  );
  return Object.fromEntries(settled.filter(([, value]) => value !== undefined));
}

function sectionFailed(
  projectId: string,
  section: FlowSection,
  error: unknown,
  unavailable: Set<FlowSection>
): void {
  log.error('insights_flow.section_failed', {
    projectId,
    section,
    error: error instanceof Error ? error.message : String(error),
    action: 'section_unavailable',
  });
  unavailable.add(section);
}

/** A row read back out of D1 is a trust boundary; one malformed row costs that row (rule 50). */
function parseRows<S extends v.GenericSchema>(
  rows: Rows | undefined,
  schema: S,
  context: string,
  projectId: string
): v.InferOutput<S>[] {
  const out: v.InferOutput<S>[] = [];
  for (const raw of rows ?? []) {
    const parsed = v.safeParse(schema, raw);
    if (parsed.success) out.push(parsed.output);
    else
      log.error('insights_flow.row_skipped', {
        projectId,
        context,
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
  }
  return out;
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rate(count: number, of: number): number | null {
  return of > 0 ? count / of : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

function uniqueRows(rows: IdeaRow[]): IdeaRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/**
 * Idea created → its first pull request merged. An idea counts in the period its first merge
 * happened in; an idea whose first merge predates the previous period does not count at all.
 */
function ideaToMerged(
  evidence: Array<{ item: IdeaListItem; pullRequests: IdeaPullRequest[] }>,
  w: FlowWindow
): { medianMs: number | null; previousMedianMs: number | null; count: number } {
  const current: number[] = [];
  const previous: number[] = [];
  for (const { item, pullRequests } of evidence) {
    const firstMerge = Math.min(
      ...pullRequests
        .filter((pr) => pr.state === 'merged' && pr.mergedAt)
        .map((pr) => Date.parse(pr.mergedAt as string))
        .filter(Number.isFinite)
    );
    const created = Date.parse(item.createdAt);
    if (!Number.isFinite(firstMerge) || !Number.isFinite(created)) continue;
    const duration = Math.max(0, firstMerge - created);
    if (firstMerge >= w.sinceMs && firstMerge <= w.nowMs) current.push(duration);
    else if (firstMerge >= w.prevSinceMs && firstMerge < w.sinceMs) previous.push(duration);
  }
  return { medianMs: median(current), previousMedianMs: median(previous), count: current.length };
}

async function readRework(
  ctx: OperationContext,
  w: FlowWindow,
  windowDays: number,
  evidence: Array<{ item: IdeaListItem; pullRequests: IdeaPullRequest[] }>,
  unavailable: Set<FlowSection>
): Promise<{ count: number; of: number; rate: number | null; previousRate: number | null }> {
  // Only ideas with two or more pull requests can link a follow-up.
  const links = evidence.flatMap(({ item, pullRequests }) =>
    pullRequests.length > 1 ? pullRequests.map((pr) => [item.ideaId, pr.url] as const) : []
  );
  try {
    const statement = reworkStatement(w, windowDays, links);
    const row = await ctx.env.DATABASE.prepare(statement.sql)
      .bind(...statement.binds)
      .first<Record<string, unknown>>();
    const merged = numberOr0(row?.merged);
    const reworked = numberOr0(row?.reworked);
    return {
      count: reworked,
      of: merged,
      rate: rate(reworked, merged),
      previousRate: rate(numberOr0(row?.prev_reworked), numberOr0(row?.prev_merged)),
    };
  } catch (error) {
    sectionFailed(w.projectId, 'rework', error, unavailable);
    return { count: 0, of: 0, rate: null, previousRate: null };
  }
}

function toCiFirstTry(row: Record<string, unknown> | undefined) {
  const passed = numberOr0(row?.passed);
  const decided = numberOr0(row?.decided);
  return {
    count: passed,
    of: decided,
    rate: rate(passed, decided),
    previousRate: rate(numberOr0(row?.prev_passed), numberOr0(row?.prev_decided)),
    recorded: numberOr0(row?.recorded),
  };
}

function toAsks(rows: Rows | undefined, projectId: string) {
  const parsed = parseRows(rows, AsksRowSchema, 'asks', projectId);
  const current = parsed.find((row) => row.current === 1);
  const previous = parsed.find((row) => row.current === 0);
  return {
    medianMs: current?.median_ms ?? null,
    previousMedianMs: previous?.median_ms ?? null,
    count: current?.n ?? 0,
  };
}

function toFlaky(rows: Rows | undefined, projectId: string) {
  const parsed = parseRows(rows, FlakyRowSchema, 'flaky', projectId);
  return {
    items: parsed.map((row) => ({
      // `check_run:<appId>:<name>`: the name may itself contain colons.
      name: row.check_key.split(':').slice(2).join(':') || row.check_key,
      flips: row.flips,
      commits: row.commits,
    })),
    total: parsed[0]?.total ?? 0,
  };
}

function toRuns(rows: Rows | undefined, w: FlowWindow, projectId: string) {
  const parsed = parseRows(rows, RunsRowSchema, 'runs', projectId);
  const counts = new Map<string, FlowRunsBucket>();
  const other = { stopped: 0, prOpen: 0, noPullRequest: 0 };
  const stopReasons: Array<{ reason: FlowStopReason; count: number }> = [];
  for (const row of parsed) {
    if (row.kind === 'reason') {
      const reason = FLOW_STOP_REASONS.find((r) => r === row.key);
      if (reason) stopReasons.push({ reason, count: numberOr0(row.merged) });
      continue;
    }
    if (!row.key) continue;
    counts.set(row.key, {
      start: row.key,
      merged: numberOr0(row.merged),
      closed: numberOr0(row.closed),
      failed: numberOr0(row.failed),
    });
    other.stopped += numberOr0(row.stopped);
    other.prOpen += numberOr0(row.pr_open);
    other.noPullRequest += numberOr0(row.no_pr);
  }
  const buckets = bucketStarts(w).map(
    (start) => counts.get(start) ?? { start, merged: 0, closed: 0, failed: 0 }
  );
  stopReasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { runs: { bucket: w.bucket, buckets, other }, stopReasons };
}

/** Every bucket start from the range's start to now, so a quiet day or week shows as zero. */
export function bucketStarts(w: FlowWindow): string[] {
  const starts: string[] = [];
  const first = new Date(w.since.slice(0, 10) + 'T00:00:00.000Z');
  if (w.bucket === 'week') first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const step = w.bucket === 'week' ? 7 : 1;
  for (let day = first; day.getTime() <= w.nowMs; day = new Date(day.getTime() + step * DAY_MS)) {
    starts.push(day.toISOString().slice(0, 10));
  }
  return starts;
}

function toWaitingIdea(item: IdeaListItem): FlowWaitingIdea {
  const pr = item.derived.pullRequest;
  return {
    ideaId: item.ideaId,
    title: item.title,
    createdAt: item.createdAt,
    state: item.derived.state,
    chats: item.counts.chats,
    pullRequest: pr ? { number: pr.number, checksState: pr.checksState } : null,
    note: item.derived.note,
  };
}

/**
 * The single biggest source of friction: the most frequent stop reason that is not a deliberate
 * stop, or the flakiest check, whichever affected more runs or commits. Ties go to the stop
 * reason, which is the more direct measure of a run not finishing.
 */
export function topBlocker(
  stopReasons: ReadonlyArray<{ reason: FlowStopReason; count: number }>,
  flaky: ReadonlyArray<{ name: string; flips: number }>
): FlowTopBlocker | null {
  const reason = stopReasons.find((r) => !FLOW_DELIBERATE_STOP_REASONS.includes(r.reason));
  const check = flaky[0];
  if (check && (!reason || check.flips > reason.count)) {
    return { kind: 'flaky_check', name: check.name, flips: check.flips };
  }
  return reason ? { kind: 'stop_reason', reason: reason.reason, count: reason.count } : null;
}
