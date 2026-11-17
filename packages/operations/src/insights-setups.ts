/**
 * Insights · Agent setups (slice S, idea 01M7HTS38KX2G78JD0ESAGMKKH): which agent profile, skill or
 * model gets this project's work merged without rework, how fast, with how much human help, and
 * at what token and memory cost, over 7, 30 or 90 days. Plus one-tap suggestions for a skill
 * (`insights-setups-suggestions.ts`). The one shared read behind the Insights page's Agent setups
 * tab (policy 5cb362e8: every surface is a thin adapter).
 *
 * Everything is derived at read time; nothing is stored. Definitions live in
 * `insights-setups-compute.ts`, the statement in `insights-setups-sql.ts`.
 *
 * Round trips (rule 60, budget 6 in the Insights spec): authorization 1; settings 0 or 1 (the
 * per-isolate admin-settings cache); one D1 `batch()` carrying the runs statement 1; one ProjectData
 * RPC counting nudges for the runs that have a chat 1 (skipped when none has). At most 4, measured
 * in `insights-setups.test.ts`. If the batch fails as a whole its statement is retried once alone
 * (`runInsightsBatch`), at most 5.
 *
 * Throughput (rule 81): the runs statement reads at most `insights.setupsRunScanCap` runs (default
 * 2,000, newest first), and the response says when the cap cut the range short. At the outer limit
 * (a 90-day range on a project running 100 tasks a day, 9,000 runs) the page covers the newest
 * 2,000, about the last 20 days, and says so; raising the setting to 10,000 covers it all. The
 * nudge read probes each of those runs' chats once through a partial index of user messages, so
 * its cost grows with runs, not with transcript size.
 */
import {
  DEFAULT_INSIGHTS_RANGE,
  DEFAULT_INSIGHTS_SETUP_GROUPING,
  isInsightsRange,
  isInsightsSetupGrouping,
  type InsightsSetupsSection,
  type ProjectSetupsResponse,
  type RunNudgeWindow,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { parseInsightsRows, runInsightsBatch } from './insights-batch';
import { flowWindow } from './insights-flow';
import { getInsightsPageLimits } from './insights-page-settings';
import { julianDayMs, reservationOf } from './insights-receipt-reads';
import { groupRuns, type SetupRef, type SetupRun } from './insights-setups-compute';
import { setupRunsStatement } from './insights-setups-sql';
import { setupSuggestions } from './insights-setups-suggestions';
import type { OperationContext } from './types';

export interface ProjectSetupsInput {
  projectId: string;
  /** `7d`, `30d` or `90d`; omitted means `DEFAULT_INSIGHTS_RANGE`. */
  range?: unknown;
  /** `profile`, `skill` or `model`; omitted means `DEFAULT_INSIGHTS_SETUP_GROUPING`. */
  groupBy?: unknown;
  /** Test seam: the instant the range ends at. */
  nowMs?: number;
}

const EVENT = 'insights_setups';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const str = v.nullish(v.string());
const num = v.nullish(v.number());
const OWNER = v.nullish(v.picklist(['project', 'you', 'teammate']));

const RunRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  status: v.string(),
  running: v.number(),
  pr_rank: v.number(),
  profile_id: str,
  skill_id: str,
  model: str,
  agent_type: str,
  agent_session_id: str,
  chat_session_id: str,
  created_jd: v.number(),
  completed_jd: num,
  first_pr_jd: num,
  reworked: num,
  workspace_reservation: str,
  task_reservation: str,
  mem_rows: num,
  mem_peak: num,
  mem_oom: num,
  tokens: num,
  profile_name: str,
  profile_owner: OWNER,
  skill_name: str,
  skill_owner: OWNER,
  skill_default_profile_id: str,
  skill_resources: str,
  total_runs: v.number(),
});
type RunRow = v.InferOutput<typeof RunRowSchema>;

function ref(id: string | null | undefined, name: string | null | undefined, owner: RunRow['profile_owner']): SetupRef {
  if (!id) return { id: null, name: null, owner: 'none' };
  // Joined by id but no row came back: deleted, or a profile this project cannot see.
  if (!owner) return { id, name: null, owner: 'not_recorded' };
  return { id, name: owner === 'teammate' ? null : (name ?? null), owner };
}

function toRun(row: RunRow, nudges: number | null): SetupRun {
  const finished = TERMINAL.has(row.status) && row.running === 0;
  const merged = row.pr_rank === 3;
  const createdMs = julianDayMs(row.created_jd);
  const firstPrMs = julianDayMs(row.first_pr_jd);
  const reservation = reservationOf(row);
  const hasMemory = (row.mem_rows ?? 0) > 0 && typeof row.mem_peak === 'number';
  return {
    id: row.id,
    finished,
    merged,
    mergedClean: finished && merged && !row.reworked,
    toPullRequestMs:
      createdMs !== null && firstPrMs !== null ? Math.max(0, firstPrMs - createdMs) : null,
    profile: ref(row.profile_id, row.profile_name, row.profile_owner),
    skill: {
      ...ref(row.skill_id, row.skill_name, row.skill_owner),
      defaultProfileId: row.skill_default_profile_id ?? null,
      resourcesJson: row.skill_resources ?? null,
    },
    model: row.model ?? null,
    agentType: row.agent_type ?? null,
    sessionRecorded: Boolean(row.agent_session_id),
    chatSessionId: row.chat_session_id ?? null,
    tokens: typeof row.tokens === 'number' ? row.tokens : null,
    memoryPeakBytes: hasMemory ? (row.mem_peak ?? null) : null,
    oomKills: Math.round(row.mem_oom ?? 0),
    requestedMemoryMb: reservation?.memoryMb ?? null,
    nudges,
  };
}

/** One nudge window per run that has a chat: from the run being asked for to its end, or now. */
function nudgeWindows(rows: RunRow[], nowMs: number): Array<{ index: number; window: RunNudgeWindow }> {
  return rows.flatMap((row, index) => {
    const from = julianDayMs(row.created_jd);
    if (!row.chat_session_id || from === null) return [];
    const ended = julianDayMs(row.completed_jd);
    const to = row.running === 0 && ended !== null ? ended : nowMs;
    return [{ index, window: { sessionId: row.chat_session_id, fromMs: from, toMs: to } }];
  });
}

export async function projectSetups(
  ctx: OperationContext,
  input: ProjectSetupsInput
): Promise<ProjectSetupsResponse> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const range = input.range === undefined ? DEFAULT_INSIGHTS_RANGE : input.range;
  if (!isInsightsRange(range)) {
    throw new OperationError('invalid_input', 'range must be one of 7d, 30d, 90d');
  }
  const groupBy = input.groupBy === undefined ? DEFAULT_INSIGHTS_SETUP_GROUPING : input.groupBy;
  if (!isInsightsSetupGrouping(groupBy)) {
    throw new OperationError('invalid_input', 'groupBy must be one of profile, skill, model');
  }
  await authorizeProjectOperation(ctx, projectId);
  const limits = await getInsightsPageLimits(ctx);
  const nowMs = input.nowMs ?? Date.now();
  const w = flowWindow(projectId, range, nowMs);
  const cap = limits.setupsRunScanCap;

  const unavailable = new Set<InsightsSetupsSection>();
  const rows = await runInsightsBatch(
    ctx,
    EVENT,
    projectId,
    {
      runs: setupRunsStatement(w, {
        viewerId: ctx.actor.userId,
        cap,
        reworkWindowDays: limits.reworkWindowDays,
      }),
    },
    (_key, error) => {
      log.error('insights_setups.section_failed', {
        projectId,
        section: 'runs',
        error: error instanceof Error ? error.message : String(error),
        action: 'section_unavailable',
      });
      unavailable.add('runs');
    }
  );
  const runRows = parseInsightsRows(rows.runs, RunRowSchema, EVENT, 'run', projectId, 'id');
  const totalRuns = rows.runs?.[0]?.total_runs;

  const nudgeCounts = new Map<number, number | null>();
  const windows = nudgeWindows(runRows, nowMs);
  if (windows.length > 0) {
    try {
      const result = await ctx.ports.projectData.countRunNudges(
        projectId,
        windows.map((entry) => entry.window),
        cap
      );
      windows.forEach((entry, i) => nudgeCounts.set(entry.index, result.counts[i] ?? null));
    } catch (error) {
      log.error('insights_setups.section_failed', {
        projectId,
        section: 'nudges',
        error: error instanceof Error ? error.message : String(error),
        action: 'section_unavailable',
      });
      unavailable.add('nudges');
    }
  }

  const runs = runRows.map((row, index) => toRun(row, nudgeCounts.get(index) ?? null));
  return {
    projectId,
    range,
    groupBy,
    since: w.since,
    until: new Date(nowMs).toISOString(),
    rework: { windowDays: limits.reworkWindowDays, rule: 'same_branch' },
    sample: {
      runs: runs.length,
      cap,
      truncated: typeof totalRuns === 'number' && totalRuns > runs.length,
    },
    groups: groupRuns(runs, groupBy),
    suggestions: setupSuggestions(
      runs,
      {
        minRuns: limits.setupsSuggestionMinRuns,
        minGapPercent: limits.setupsSuggestionMinGapPercent,
        memoryHeadroomPercent: limits.setupsMemoryHeadroomPercent,
      },
      projectId
    ),
    suggestionMinRuns: limits.setupsSuggestionMinRuns,
    unavailable: [...unavailable],
    generatedAt: new Date().toISOString(),
  };
}
