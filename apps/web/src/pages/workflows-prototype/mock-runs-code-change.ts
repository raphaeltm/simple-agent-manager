/**
 * PROTOTYPE ONLY — the repeatable "Code change with review & tests" workflow and
 * one scripted run of it (Run #14). Each frame is a full snapshot so the
 * prototype can step through progress, an automatic infrastructure retry, the
 * approval step, rejection and cancellation deterministically.
 */
import type { ActivityEntry, RunDef, RunFrame, StepDef, StepState } from './model';

export const CODE_CHANGE_STEPS: StepDef[] = [
  {
    key: 'plan',
    title: 'Plan the change',
    kind: 'agent',
    profileId: 'brainstormer',
    after: [],
    instructions:
      'Read the code around the problem, reproduce it, and write a short plan. Do not change code.',
  },
  {
    key: 'implement',
    title: 'Implement the change',
    kind: 'agent',
    profileId: 'codex',
    after: ['plan'],
    mustOpenPr: true,
    instructions:
      'Make the change on a new branch with a regression test, then open a pull request.',
  },
  {
    key: 'review',
    title: 'Review the code',
    kind: 'agent',
    profileId: 'cto',
    after: ['implement'],
    instructions:
      'Review the pull request for correctness, security and payment edge cases. Leave findings on the PR.',
  },
  {
    key: 'tests',
    title: 'Run tests on staging',
    kind: 'agent',
    profileId: 'opus',
    after: ['implement'],
    instructions: 'Deploy the branch to staging and run the end-to-end export suite.',
  },
  {
    key: 'fix',
    title: 'Fix review findings',
    kind: 'agent',
    profileId: 'codex',
    after: ['review', 'tests'],
    instructions: 'Address every review finding and any test failure. Push to the same branch.',
  },
  {
    key: 'approve',
    title: 'Your approval: merge?',
    kind: 'approval',
    after: ['fix'],
    instructions: 'Owner decision before anything reaches production.',
    question: 'Check the PR, the review findings and the staging results. Merge to main?',
  },
  {
    key: 'merge',
    title: 'Merge and watch the deploy',
    kind: 'agent',
    profileId: 'codex',
    after: ['approve'],
    instructions: 'Merge once checks are green, then watch the production deploy and report.',
  },
];

const W = (reason: string): StepState => ({ status: 'waiting', reason });

const PLAN_DONE: StepState = {
  status: 'done',
  started: '09:18',
  duration: '13m',
  summary:
    'Reproduced it: exportCsv() drops the final row when the file has no trailing newline (exporter.ts:88). Plan: fix the slice, add a regression test, check the statement export too.',
  evidence: [{ kind: 'note', label: 'Plan written', source: 'agent' }],
};

const IMPL_DONE: StepState = {
  status: 'done',
  started: '09:31',
  duration: '16m',
  summary: 'Fixed the off-by-one, added exports-last-row.test.ts and opened PR #482.',
  evidence: [
    {
      kind: 'pr',
      label: 'PR #482',
      detail: 'Fix CSV export dropping the last row',
      ok: true,
      source: 'sam',
    },
    { kind: 'branch', label: 'fix/csv-last-row', source: 'sam' },
    { kind: 'tests', label: 'Unit tests: 386 passed', ok: true, source: 'agent' },
  ],
};

const REVIEW_DONE: StepState = {
  status: 'done',
  started: '09:47',
  duration: '21m',
  summary:
    '2 findings: the statement export has the same slice bug, and there is no test for an empty file.',
  evidence: [{ kind: 'note', label: '2 findings on PR #482', source: 'agent' }],
};

const TESTS_DONE: StepState = {
  status: 'done',
  started: '09:47',
  duration: '28m',
  summary: 'End-to-end export suite: 214 passed. A 10,000-row staging export matches the ledger.',
  evidence: [
    { kind: 'tests', label: 'E2E: 214 passed', ok: true, source: 'agent' },
    { kind: 'deploy', label: 'Staging build 7f3c2a1', ok: true, source: 'sam' },
  ],
  attempts: [
    {
      n: 1,
      status: 'failed',
      note: 'Machine was lost at 09:52 — retried automatically',
      auto: true,
    },
    { n: 2, status: 'done', note: 'Passed' },
  ],
};

const FIX_DONE: StepState = {
  status: 'done',
  started: '10:15',
  duration: '12m',
  summary:
    'Fixed both findings in a3f9c21: patched the statement export and added the empty-file test.',
  evidence: [
    { kind: 'commit', label: 'a3f9c21', source: 'sam' },
    { kind: 'pr', label: 'PR #482', detail: 'Checks 14/14 passing', ok: true, source: 'sam' },
  ],
};

const APPROVED: StepState = {
  status: 'approved',
  decidedBy: 'You · 10:31',
  comment: 'Looks good — ship it.',
};

const MERGE_DONE: StepState = {
  status: 'done',
  started: '10:31',
  duration: '21m',
  summary: 'Merged PR #482 (squash 9b1e44d). Production deploy finished; error rate unchanged.',
  evidence: [
    { kind: 'commit', label: '9b1e44d', source: 'sam' },
    { kind: 'deploy', label: 'Production deploy', ok: true, source: 'sam' },
  ],
};

const A: ActivityEntry[] = [
  { at: '09:18', text: 'Run #14 started by you from “Code change with review & tests” v3.' },
  { at: '09:18', text: 'Started “Plan the change” (Brainstormer).' },
  {
    at: '09:31',
    text: '“Plan the change” done. Started “Implement the change” with the plan in its first message.',
    tone: 'success',
  },
  {
    at: '09:47',
    text: '“Implement the change” opened PR #482. Started “Review the code” and “Run tests on staging” at the same time (2 of 2 slots).',
    tone: 'success',
  },
  {
    at: '09:52',
    text: '“Run tests on staging” lost its machine. Retrying automatically (attempt 2 of 2).',
    tone: 'warning',
  },
  { at: '10:08', text: '“Review the code” done with 2 findings.', tone: 'success' },
  {
    at: '10:15',
    text: '“Run tests on staging” passed. Started “Fix review findings”.',
    tone: 'success',
  },
  {
    at: '10:27',
    text: '“Fix review findings” done. Waiting for your approval before merge — notified you.',
    tone: 'warning',
  },
  {
    at: '10:31',
    text: 'You approved: “Looks good — ship it.” Started “Merge and watch the deploy”.',
    tone: 'success',
  },
  { at: '10:52', text: 'Run done: 7 of 7 steps, 1 automatic retry.', tone: 'success' },
];

const frame = (
  id: string,
  caption: string,
  status: RunFrame['status'],
  elapsed: string,
  activityCount: number,
  steps: RunFrame['steps']
): RunFrame => ({ id, caption, status, elapsed, steps, activity: A.slice(0, activityCount) });

export const CSV_RUN: RunDef = {
  id: 'run-csv',
  title: 'Fix: CSV export drops the last row',
  origin: { kind: 'saved', workflowId: 'code-change', version: 3, runNumber: 14 },
  startedBy: 'you',
  startedAgo: '1h 12m ago',
  maxParallel: 2,
  inputs: [
    {
      label: 'What should change?',
      value:
        'CSV export drops the last row when the file ends without a trailing newline. Starter-plan customers see missing refunds in exported statements.',
    },
    {
      label: 'How we’ll know it’s fixed',
      value:
        'A 10,000-row export matches the ledger exactly. A regression test covers the no-trailing-newline case.',
    },
  ],
  steps: CODE_CHANGE_STEPS,
  defaultFrame: 5,
  frames: [
    frame('csv-0', 'Just started', 'running', '2m', 2, {
      plan: { status: 'running', started: '09:18', duration: '2m', reason: 'Reading exporter.ts' },
      implement: W('After “Plan the change”'),
      review: W('After “Implement the change”'),
      tests: W('After “Implement the change”'),
      fix: W('After review and tests'),
      approve: W('After “Fix review findings”'),
      merge: W('After your approval'),
    }),
    frame('csv-1', 'Plan done, implementing', 'running', '16m', 3, {
      plan: PLAN_DONE,
      implement: {
        status: 'running',
        started: '09:31',
        duration: '3m',
        reason: 'Editing exporter.ts',
      },
      review: W('After “Implement the change”'),
      tests: W('After “Implement the change”'),
      fix: W('After review and tests'),
      approve: W('After “Fix review findings”'),
      merge: W('After your approval'),
    }),
    frame('csv-2', 'PR opened, review and tests in parallel', 'running', '31m', 4, {
      plan: PLAN_DONE,
      implement: IMPL_DONE,
      review: { status: 'running', started: '09:47', duration: '4m', reason: 'Reading PR #482' },
      tests: { status: 'starting', started: '09:47', reason: 'Getting a machine ready' },
      fix: W('After review and tests'),
      approve: W('After “Fix review findings”'),
      merge: W('After your approval'),
    }),
    frame('csv-3', 'Machine lost, retried automatically', 'running', '38m', 5, {
      plan: PLAN_DONE,
      implement: IMPL_DONE,
      review: {
        status: 'running',
        started: '09:47',
        duration: '11m',
        reason: 'Checking statement export',
      },
      tests: {
        status: 'running',
        started: '09:53',
        duration: '2m',
        reason: 'Attempt 2 of 2 · first machine was lost',
        attempts: [
          {
            n: 1,
            status: 'failed',
            note: 'Machine was lost at 09:52 — retried automatically',
            auto: true,
          },
          { n: 2, status: 'running', note: 'Running' },
        ],
      },
      fix: W('After review and tests'),
      approve: W('After “Fix review findings”'),
      merge: W('After your approval'),
    }),
    frame('csv-4', 'Review and tests done, fixing findings', 'running', '58m', 7, {
      plan: PLAN_DONE,
      implement: IMPL_DONE,
      review: REVIEW_DONE,
      tests: TESTS_DONE,
      fix: {
        status: 'running',
        started: '10:15',
        duration: '6m',
        reason: 'Patching statement export',
      },
      approve: W('After “Fix review findings”'),
      merge: W('After your approval'),
    }),
    frame('csv-5', 'Waiting for your approval', 'needs_you', '1h 12m', 8, {
      plan: PLAN_DONE,
      implement: IMPL_DONE,
      review: REVIEW_DONE,
      tests: TESTS_DONE,
      fix: FIX_DONE,
      approve: { status: 'needs_you', reason: 'Asked 4m ago · only you can approve' },
      merge: W('After your approval'),
    }),
    frame('csv-6', 'Approved, merging', 'running', '1h 14m', 9, {
      plan: PLAN_DONE,
      implement: IMPL_DONE,
      review: REVIEW_DONE,
      tests: TESTS_DONE,
      fix: FIX_DONE,
      approve: APPROVED,
      merge: { status: 'running', started: '10:31', duration: '2m', reason: 'Waiting for checks' },
    }),
    frame('csv-7', 'Done', 'done', '1h 34m', 10, {
      plan: PLAN_DONE,
      implement: IMPL_DONE,
      review: REVIEW_DONE,
      tests: TESTS_DONE,
      fix: FIX_DONE,
      approve: APPROVED,
      merge: MERGE_DONE,
    }),
    // ---- branches reached through the owner's actions -------------------
    {
      id: 'csv-rejected',
      caption: 'You rejected the merge',
      status: 'needs_attention',
      elapsed: '1h 13m',
      steps: {
        plan: PLAN_DONE,
        implement: IMPL_DONE,
        review: REVIEW_DONE,
        tests: TESTS_DONE,
        fix: FIX_DONE,
        approve: {
          status: 'rejected',
          decidedBy: 'You · 10:30',
          comment: 'Don’t ship before the month-end close. Merge after Nov 1.',
        },
        merge: { status: 'blocked', reason: 'Your approval was declined' },
      },
      activity: [
        ...A.slice(0, 8),
        {
          at: '10:30',
          text: 'You rejected “Your approval: merge?”. Nothing else can run — retry the approval or cancel the run.',
          tone: 'danger',
        },
      ],
    },
    {
      id: 'csv-cancelled',
      caption: 'You cancelled the run',
      status: 'cancelled',
      elapsed: '33m',
      steps: {
        plan: PLAN_DONE,
        implement: IMPL_DONE,
        review: { status: 'cancelled', reason: 'Stopped by you · branch pushed first' },
        tests: { status: 'cancelled', reason: 'Stopped by you · branch pushed first' },
        fix: { status: 'cancelled', reason: 'Not started' },
        approve: { status: 'cancelled', reason: 'Not started' },
        merge: { status: 'cancelled', reason: 'Not started' },
      },
      activity: [
        ...A.slice(0, 4),
        {
          at: '09:51',
          text: 'You cancelled the run. Asked 2 running steps to push their work, then stopped them.',
          tone: 'muted',
        },
      ],
    },
  ],
};
