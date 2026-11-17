/**
 * Insights reads in the shared operation catalog (build spec idea 01M7HTS38KX2G78JD0ESAGMKKH). The
 * SAM Connector lists every catalog operation; sam-mcp serves `sam_project_insights` as its
 * `project_insights` tool (`apps/api/src/routes/mcp/project-insights-tool.ts`).
 */
import * as v from 'valibot';

import { projectInsights, ProjectInsightsInputSchema } from './insights-agent';
import { runReceipt } from './insights-receipt';
import { defineOperation } from './types';

export const samRunReceipt = defineOperation({
  name: 'sam_run_receipt',
  title: 'Run receipt',
  description:
    'Use this when you need to know how one task run went: where its time went (waiting for a machine, setup, agent working, waiting on a person, CI), its pull request and check state, which kind of account ran it, peak memory against what it requested, tool calls by kind, and up to three things that slowed it down compared with recent runs of the same skill or profile. Durations are in milliseconds; a null duration means SAM has no record to measure it from. outcome.ciFirstTry is "passed" or "failed" for the opening commit of the pull request, "pending" while its checks run or when none reported, and "not_recorded" when SAM did not see the pull request opened. Tokens are "not_reported". Never estimate either. Never returns credentials.',
  kind: 'read',
  input: v.object({
    projectId: v.pipe(v.string(), v.minLength(1)),
    taskId: v.pipe(v.string(), v.minLength(1)),
  }),
  run: (ctx, input) => runReceipt(ctx, input),
});

export const samProjectInsights = defineOperation({
  name: 'sam_project_insights',
  title: 'Project insights (numbers)',
  description:
    'Numbers about how runs in a project go, for planning work. method: receipt (taskId: one run\'s phases, PR and CI state, peak memory vs requested, tool calls, tokens, what slowed it), flow (range: merged runs, CI first-try pass rate, flaky checks, why runs stopped), setups (range, groupBy profile|skill|model: runs, merged without rework, median to PR, memory p90 vs requested, tokens per merged PR), phases (skillId or agentProfileId, optional operation, phaseNames and windowDays: median and p90 duration per lifecycle phase), accounts (range: runs, limit stalls and limit windows per account). range is 7d, 30d or 90d (default 30d). Durations are milliseconds; null or "not_recorded" means SAM has no record, never an estimate. Returns no titles, messages, names of people or accounts, or credentials; CI check names are included.',
  kind: 'read',
  input: ProjectInsightsInputSchema,
  run: (ctx, input) => projectInsights(ctx, input),
});

export const insightsOperations = [samRunReceipt, samProjectInsights] as const;
