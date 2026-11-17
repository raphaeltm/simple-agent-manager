/**
 * Insights reads in the shared operation catalog, so the SAM Connector can call them now and
 * sam-mcp can in Insights slice I (build spec idea 01M7HTS38KX2G78JD0ESAGMKKH).
 */
import * as v from 'valibot';

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

export const insightsOperations = [samRunReceipt] as const;
