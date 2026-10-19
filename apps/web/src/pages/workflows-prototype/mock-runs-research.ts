/**
 * PROTOTYPE ONLY — a one-off research run that the chat agent drafted and
 * started itself (no approval screen). Four evaluations fan out under a
 * 2-at-a-time cap, one fails on judgement (no automatic retry), and the owner
 * retries it with edited instructions or skips it.
 */
import type { ActivityEntry, RunDef, RunFrame, StepDef, StepState } from './model';

export const RESEARCH_STEPS: StepDef[] = [
  {
    key: 'criteria',
    title: 'Agree criteria and shortlist',
    kind: 'agent',
    profileId: 'brainstormer',
    after: [],
    instructions:
      'Turn the request into scoring criteria and confirm the four candidates. No code changes.',
  },
  {
    key: 'launchdarkly',
    title: 'Evaluate LaunchDarkly',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['criteria'],
    instructions: 'Score LaunchDarkly against the criteria. Cite sources.',
  },
  {
    key: 'unleash',
    title: 'Evaluate Unleash',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['criteria'],
    instructions: 'Score Unleash against the criteria. Cite sources.',
  },
  {
    key: 'growthbook',
    title: 'Evaluate GrowthBook',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['criteria'],
    instructions: 'Score GrowthBook against the criteria. Cite sources.',
  },
  {
    key: 'flagsmith',
    title: 'Evaluate Flagsmith',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['criteria'],
    instructions: 'Score Flagsmith against the criteria. Cite sources.',
  },
  {
    key: 'report',
    title: 'Compare and write the report',
    kind: 'agent',
    profileId: 'opus',
    after: ['launchdarkly', 'unleash', 'growthbook', 'flagsmith'],
    instructions:
      'Compare the four evaluations, recommend one, and save the report to the project Library.',
  },
];

const W: StepState = { status: 'waiting', reason: 'After “Agree criteria and shortlist”' };
const SLOT: StepState = { status: 'up_next', reason: 'Waiting for a free slot · 2 of 2 in use' };
const AFTER_ALL: StepState = { status: 'waiting', reason: 'After the four evaluations' };

const CRITERIA_DONE: StepState = {
  status: 'done',
  started: '10:02',
  duration: '9m',
  summary:
    'Criteria: price at 25 seats, self-hosting, Go and TypeScript SDKs, audit log, EU data residency. Candidates confirmed.',
};
const LD_DONE: StepState = {
  status: 'done',
  started: '10:11',
  duration: '12m',
  summary: 'Best SDKs and audit log. No self-hosting. About $12k a year at 25 seats.',
  evidence: [{ kind: 'note', label: '9 sources cited', source: 'agent' }],
};
const UNLEASH_DONE: StepState = {
  status: 'done',
  started: '10:11',
  duration: '19m',
  summary: 'Self-hostable (Apache-2.0 core). Audit log is paid-only. Solid Go SDK.',
  evidence: [{ kind: 'note', label: '7 sources cited', source: 'agent' }],
};
const GB_FAILED: StepState = {
  status: 'failed',
  started: '10:23',
  duration: '11m',
  summary:
    'Couldn’t verify pricing or audit-log details: the docs site blocked automated access and the only cached copy is from 2024.',
  reason: 'Agent reported it could not finish · not retried automatically',
  attempts: [{ n: 1, status: 'failed', note: 'Agent could not verify sources' }],
};
const GB_DONE: StepState = {
  status: 'done',
  started: '10:37',
  duration: '14m',
  summary:
    'Self-hostable (MIT). Audit log included when self-hosted. Strong TypeScript SDK; Go SDK is community-maintained.',
  evidence: [{ kind: 'note', label: '6 sources cited', source: 'agent' }],
  attempts: [
    { n: 1, status: 'failed', note: 'Agent could not verify sources' },
    {
      n: 2,
      status: 'done',
      note: 'Retried by you with new instructions: “Use the GitHub README and the public pricing PDF.”',
    },
  ],
};
const FLAGSMITH_DONE: StepState = {
  status: 'done',
  started: '10:30',
  duration: '15m',
  summary:
    'Self-hostable (BSD-3). Audit log included. EU hosting available. Smaller SDK ecosystem.',
  evidence: [{ kind: 'note', label: '8 sources cited', source: 'agent' }],
};
const REPORT_DONE: StepState = {
  status: 'done',
  started: '10:51',
  duration: '10m',
  summary:
    'Recommend GrowthBook, self-hosted: meets 4 of 5 criteria at the lowest cost. Pick LaunchDarkly if we’d rather not run it ourselves.',
  evidence: [
    {
      kind: 'file',
      label: 'feature-flag-comparison.md',
      detail: 'Saved to Library',
      ok: true,
      source: 'sam',
    },
  ],
};

const A: ActivityEntry[] = [
  {
    at: '10:02',
    text: 'Your agent in “Pick a feature-flag service” started this one-off run (6 steps, up to 2 at once).',
  },
  { at: '10:02', text: 'Started “Agree criteria and shortlist” (Brainstormer).' },
  {
    at: '10:11',
    text: 'Shortlist done. Started LaunchDarkly and Unleash. GrowthBook and Flagsmith wait for a free slot (limit 2).',
    tone: 'success',
  },
  {
    at: '10:23',
    text: '“Evaluate LaunchDarkly” done. Started “Evaluate GrowthBook”.',
    tone: 'success',
  },
  { at: '10:30', text: '“Evaluate Unleash” done. Started “Evaluate Flagsmith”.', tone: 'success' },
  {
    at: '10:34',
    text: '“Evaluate GrowthBook” failed: sources blocked. Not retried automatically because the agent reported the problem. “Compare and write the report” is blocked until you retry or skip it.',
    tone: 'danger',
  },
  {
    at: '10:37',
    text: 'You retried “Evaluate GrowthBook” with new instructions (attempt 2).',
  },
  { at: '10:45', text: '“Evaluate Flagsmith” done.', tone: 'success' },
  {
    at: '10:51',
    text: '“Evaluate GrowthBook” done. All four evaluations finished. Started “Compare and write the report” (Claude Code — Opus 5).',
    tone: 'success',
  },
  {
    at: '11:01',
    text: 'Run done. Report saved to Library. Woke your agent in “Pick a feature-flag service” to summarize.',
    tone: 'success',
  },
];

const frame = (
  id: string,
  caption: string,
  status: RunFrame['status'],
  elapsed: string,
  activityCount: number,
  steps: RunFrame['steps']
): RunFrame => ({ id, caption, status, elapsed, steps, activity: A.slice(0, activityCount) });

export const RESEARCH_RUN: RunDef = {
  id: 'run-flags',
  title: 'Research: choosing a feature-flag service',
  origin: { kind: 'one_off', chatTitle: 'Pick a feature-flag service' },
  startedBy: 'your-agent',
  startedAgo: '41m ago',
  maxParallel: 2,
  steps: RESEARCH_STEPS,
  defaultFrame: 3,
  frames: [
    frame('flags-0', 'Started by your agent', 'running', '3m', 2, {
      criteria: {
        status: 'running',
        started: '10:02',
        duration: '3m',
        reason: 'Drafting criteria',
      },
      launchdarkly: W,
      unleash: W,
      growthbook: W,
      flagsmith: W,
      report: AFTER_ALL,
    }),
    frame('flags-1', '2 at once, 2 up next', 'running', '14m', 3, {
      criteria: CRITERIA_DONE,
      launchdarkly: { status: 'running', started: '10:11', duration: '3m' },
      unleash: { status: 'running', started: '10:11', duration: '3m' },
      growthbook: SLOT,
      flagsmith: SLOT,
      report: AFTER_ALL,
    }),
    frame('flags-2', 'One done, next one started', 'running', '27m', 4, {
      criteria: CRITERIA_DONE,
      launchdarkly: LD_DONE,
      unleash: { status: 'running', started: '10:11', duration: '16m' },
      growthbook: { status: 'running', started: '10:23', duration: '4m' },
      flagsmith: SLOT,
      report: AFTER_ALL,
    }),
    frame('flags-3', 'A step failed — needs attention', 'needs_attention', '41m', 6, {
      criteria: CRITERIA_DONE,
      launchdarkly: LD_DONE,
      unleash: UNLEASH_DONE,
      growthbook: GB_FAILED,
      flagsmith: { status: 'running', started: '10:30', duration: '11m' },
      report: { status: 'blocked', reason: 'Blocked: “Evaluate GrowthBook” failed' },
    }),
    frame('flags-4', 'You retried with new instructions', 'running', '44m', 7, {
      criteria: CRITERIA_DONE,
      launchdarkly: LD_DONE,
      unleash: UNLEASH_DONE,
      growthbook: {
        status: 'running',
        started: '10:37',
        duration: '1m',
        reason: 'Attempt 2 · new instructions from you',
        attempts: [
          { n: 1, status: 'failed', note: 'Agent could not verify sources' },
          { n: 2, status: 'running', note: 'Retried by you with new instructions' },
        ],
      },
      flagsmith: { status: 'running', started: '10:30', duration: '14m' },
      report: AFTER_ALL,
    }),
    frame('flags-5', 'Writing the report', 'running', '58m', 9, {
      criteria: CRITERIA_DONE,
      launchdarkly: LD_DONE,
      unleash: UNLEASH_DONE,
      growthbook: GB_DONE,
      flagsmith: FLAGSMITH_DONE,
      report: {
        status: 'running',
        started: '10:51',
        duration: '7m',
        reason: 'Writing feature-flag-comparison.md',
      },
    }),
    frame('flags-6', 'Done — report in Library', 'done', '59m', 10, {
      criteria: CRITERIA_DONE,
      launchdarkly: LD_DONE,
      unleash: UNLEASH_DONE,
      growthbook: GB_DONE,
      flagsmith: FLAGSMITH_DONE,
      report: REPORT_DONE,
    }),
    {
      id: 'flags-skipped',
      caption: 'You skipped the failed step',
      status: 'running',
      elapsed: '42m',
      steps: {
        criteria: CRITERIA_DONE,
        launchdarkly: LD_DONE,
        unleash: UNLEASH_DONE,
        growthbook: {
          ...GB_FAILED,
          status: 'skipped',
          reason: 'Skipped by you: “No reliable sources — compare the other three.”',
        },
        flagsmith: { status: 'running', started: '10:30', duration: '12m' },
        report: {
          status: 'waiting',
          reason: 'After “Evaluate Flagsmith” · GrowthBook was skipped',
        },
      },
      activity: [
        ...A.slice(0, 6),
        {
          at: '10:36',
          text: 'You skipped “Evaluate GrowthBook”. The report will compare the other three.',
          tone: 'muted',
        },
      ],
    },
  ],
};
