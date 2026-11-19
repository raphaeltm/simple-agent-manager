/**
 * Mock workflow runs for the Workflows audits, shaped exactly like the read contract
 * (`packages/shared/src/types/workflow.ts`): a run in progress with parallel review steps, a
 * failed run with blocked dependents, an event-wait step that is listening, a run that hit its
 * deadline, a finished run, plus long-text, 25-step and markup variants.
 */
import type { Page, Route } from '@playwright/test';
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepDetail,
} from '@simple-agent-manager/shared';

import { LONG_NAME, NOW, OWNER_ID, PROJECT_ID, SPECIAL_TEXT } from './automation-fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const OPUS = {
  profileId: 'profile-opus',
  profileName: 'Opus 5.5 Chat',
  agentType: 'claude-code',
  model: 'claude-opus-5-5',
};
const CODEX = {
  profileId: 'profile-codex',
  profileName: 'Codex 5.5 High',
  agentType: 'openai-codex',
  model: 'gpt-5.5',
};

const LONG_URL =
  'https://github.com/acme/simple-agent-manager/pull/2404/files#diff-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export const LONG_SUMMARY = `Drafted the release notes for 2026.10.21 and saved them to the project Library as library file 01M5H0Z9X1Y2Z3A4B5C6D7E8F9. They cover the Automation page, the new Workflows view, explicit agent choice, and eleven fixes. Links checked: ${LONG_URL}. Open questions for the reviewer: whether to mention the staging-only cap change, and whether the CLI section should move above the fixes.\n\nThe draft follows the house style: short sentences, one idea per bullet, no marketing words.`;

function step(
  overrides: Partial<WorkflowStepDetail> & Pick<WorkflowStepDetail, 'key' | 'title'>
): WorkflowStepDetail {
  return {
    kind: 'agent',
    status: 'waiting',
    reason: null,
    ordinal: 0,
    after: [],
    instructions: `Do the work for “${overrides.title}”. Save anything others need in the project Library and finish with complete_task.`,
    agent: OPUS,
    attemptId: `att-${overrides.key}`,
    taskId: null,
    sessionId: null,
    taskStatus: null,
    launchAttempts: 0,
    startedAt: null,
    finishedAt: null,
    updatedAt: iso(-5 * MIN),
    output: null,
    wait: null,
    ...overrides,
  };
}

function started(key: string, startedMs: number, finishedMs: number | null, taskStatus: string) {
  return {
    taskId: `task-${key}`,
    sessionId: `chat-${key}`,
    taskStatus,
    launchAttempts: 1,
    startedAt: iso(startedMs),
    finishedAt: finishedMs === null ? null : iso(finishedMs),
  };
}

function run(
  overrides: Partial<WorkflowRunDetail> & Pick<WorkflowRunDetail, 'id' | 'title' | 'steps'>
): WorkflowRunDetail {
  return {
    goal: 'Ship reviewed release notes to the project Library before the daily release.',
    status: 'active',
    startedByUserId: OWNER_ID,
    createdAt: iso(-3 * HOUR),
    updatedAt: iso(-5 * MIN),
    deadlineAt: iso(69 * HOUR),
    startedFrom: {
      taskId: 'task-planner',
      sessionId: 'chat-planner',
      title: 'Plan the 2026.10.21 release notes',
    },
    maxParallelSteps: 2,
    activity: [],
    ...overrides,
  };
}

/** Activity entries for every started/finished step, oldest first. */
function activityOf(detail: WorkflowRunDetail): WorkflowRunDetail['activity'] {
  const entries: WorkflowRunDetail['activity'] = [];
  for (const s of detail.steps) {
    if (s.startedAt) entries.push({ at: s.startedAt, stepKey: s.key, state: 'starting' });
    if (s.startedAt && s.status !== 'starting')
      entries.push({ at: s.startedAt, stepKey: s.key, state: 'running' });
    if (s.finishedAt) entries.push({ at: s.finishedAt, stepKey: s.key, state: s.status });
    if (s.status === 'blocked') entries.push({ at: s.updatedAt, stepKey: s.key, state: 'blocked' });
  }
  if (detail.status !== 'active')
    entries.push({
      at: detail.updatedAt,
      stepKey: null,
      state: detail.status === 'completed' ? 'completed' : 'needs_attention',
    });
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

const withActivity = (detail: WorkflowRunDetail) => ({ ...detail, activity: activityOf(detail) });

export const RELEASE = withActivity(
  run({
    id: 'run-release',
    title: 'Write and review the 2026.10.21 release notes',
    steps: [
      step({
        key: 'draft',
        title: 'Draft the release notes',
        status: 'completed',
        ordinal: 0,
        ...started('draft', -170 * MIN, -120 * MIN, 'completed'),
        output: {
          summary:
            'Draft saved as Library file 01M5H0Z9X1Y2Z3A4B5C6D7E8F9. Covers eleven fixes and the Workflows view.',
          branch: 'sam/release-notes-2026-10-21',
          prUrl: 'https://github.com/acme/simple-agent-manager/pull/2404',
          evidence: {
            testsRun: [
              { command: 'pnpm --filter @simple-agent-manager/www build', passed: true },
              { command: 'pnpm lint:links docs', passed: true },
            ],
            notes: 'Checked every link in the draft.',
          },
          handoffs: [
            {
              id: 'handoff-1',
              artifactRefs: [
                { type: 'library_file', ref: '01M5H0Z9X1Y2Z3A4B5C6D7E8F9' },
                { type: 'url', ref: 'https://simple-agent-manager.org/blog/2026-10-21' },
              ],
            },
          ],
        },
      }),
      step({
        key: 'review-tone',
        title: 'Review tone and wording',
        status: 'running',
        ordinal: 1,
        after: ['draft'],
        agent: CODEX,
        ...started('review-tone', -118 * MIN, null, 'in_progress'),
      }),
      step({
        key: 'review-facts',
        title: 'Check every claim against merged PRs',
        status: 'completed',
        ordinal: 2,
        after: ['draft'],
        ...started('review-facts', -118 * MIN, -60 * MIN, 'completed'),
        output: {
          summary:
            'All eleven fixes match merged PRs. Two PR numbers were wrong and are corrected in review notes (Library 01M5H1A2B3C4D5E6F7G8H9J0K1).',
          branch: null,
          prUrl: null,
          evidence: null,
          handoffs: [
            {
              id: 'handoff-2',
              artifactRefs: [{ type: 'library_file', ref: '01M5H1A2B3C4D5E6F7G8H9J0K1' }],
            },
          ],
        },
      }),
      step({
        key: 'revise',
        title: 'Apply both reviews',
        ordinal: 3,
        after: ['review-tone', 'review-facts'],
      }),
      step({
        key: 'publish',
        title: 'Publish to the blog',
        ordinal: 4,
        after: ['revise'],
        agent: CODEX,
      }),
    ],
  })
);

export const FAILED = withActivity(
  run({
    id: 'run-flaky',
    title: 'Fix the flaky upload test and ship it',
    status: 'needs_attention',
    createdAt: iso(-26 * HOUR),
    updatedAt: iso(-20 * HOUR),
    goal: 'Find why the library upload test fails one run in five, fix it, and ship the fix.',
    steps: [
      step({
        key: 'investigate',
        title: 'Find the cause',
        status: 'completed',
        ordinal: 0,
        ...started('investigate', -26 * HOUR, -24 * HOUR, 'completed'),
        output: {
          summary:
            'The test races the R2 mock: the upload resolves before the metadata write. Fix: await the write.',
          branch: 'sam/flaky-upload',
          prUrl: null,
          evidence: null,
          handoffs: [],
        },
      }),
      step({
        key: 'fix',
        title: 'Fix and test it',
        status: 'failed',
        ordinal: 1,
        after: ['investigate'],
        reason:
          'Agent process exited with code 1: 3 tests failed in apps/api (library-upload.test.ts: "metadata write is awaited", "retries a failed write", "reports a partial upload")',
        ...started('fix', -24 * HOUR, -20 * HOUR, 'failed'),
      }),
      step({
        key: 'ship',
        title: 'Open the pull request',
        status: 'blocked',
        ordinal: 2,
        after: ['fix'],
        reason: 'Blocked: fix did not succeed',
        updatedAt: iso(-20 * HOUR),
      }),
    ],
  })
);

export const WAITING = withActivity(
  run({
    id: 'run-wait',
    title: 'Merge the docs fix once CI passes',
    createdAt: iso(-50 * MIN),
    steps: [
      step({
        key: 'implement',
        title: 'Fix the broken docs links',
        status: 'completed',
        ordinal: 0,
        ...started('implement', -50 * MIN, -20 * MIN, 'completed'),
        output: {
          summary: 'Opened PR #2405 with the link fixes.',
          branch: 'sam/docs-links',
          prUrl: 'https://github.com/acme/simple-agent-manager/pull/2405',
          evidence: null,
          handoffs: [],
        },
      }),
      step({
        key: 'wait-ci',
        title: 'Wait for CI',
        kind: 'wait',
        agent: null,
        status: 'running',
        ordinal: 1,
        after: ['implement'],
        startedAt: iso(-19 * MIN),
        wait: {
          description: 'CI to finish on pull request #2405',
          source: 'github',
          eventTypes: ['check_suite.completed'],
          subject: { type: 'pull_request', id: '2405' },
          listeningSince: iso(-19 * MIN),
          timeoutAt: iso(41 * MIN),
          matchedEvent: null,
          timedOut: false,
        },
      }),
      step({ key: 'merge', title: 'Merge it', ordinal: 2, after: ['wait-ci'] }),
    ],
  })
);

export const DEADLINE = withActivity(
  run({
    id: 'run-deadline',
    title: 'Nightly dependency upgrade',
    status: 'needs_attention',
    createdAt: iso(-75 * HOUR),
    updatedAt: iso(-3 * HOUR),
    deadlineAt: iso(-3 * HOUR),
    steps: [
      step({
        key: 'upgrade',
        title: 'Upgrade dependencies',
        status: 'failed',
        ordinal: 0,
        reason:
          'Workflow deadline exceeded; inspect any already-running task before starting another run',
        ...started('upgrade', -74 * HOUR, -3 * HOUR, 'in_progress'),
      }),
      step({
        key: 'verify',
        title: 'Run the full suite',
        status: 'failed',
        ordinal: 1,
        after: ['upgrade'],
        reason:
          'Workflow deadline exceeded; inspect any already-running task before starting another run',
      }),
    ],
  })
);

export const DONE = withActivity(
  run({
    id: 'run-done',
    title: 'Weekly ideas review',
    status: 'completed',
    createdAt: iso(-8 * 24 * HOUR),
    updatedAt: iso(-8 * 24 * HOUR + 2 * HOUR),
    deadlineAt: iso(-5 * 24 * HOUR),
    steps: [
      step({
        key: 'collect',
        title: 'Collect new ideas',
        status: 'completed',
        ordinal: 0,
        ...started('collect', -8 * 24 * HOUR, -8 * 24 * HOUR + HOUR, 'completed'),
        output: {
          summary: 'Found 6 new ideas.',
          branch: null,
          prUrl: null,
          evidence: null,
          handoffs: [],
        },
      }),
      step({
        key: 'rank',
        title: 'Rank them',
        status: 'completed',
        ordinal: 1,
        after: ['collect'],
        ...started('rank', -8 * 24 * HOUR + HOUR, -8 * 24 * HOUR + 2 * HOUR, 'completed'),
        output: {
          summary: 'Ranked; top pick is workflow templates.',
          branch: null,
          prUrl: null,
          evidence: null,
          handoffs: [],
        },
      }),
    ],
  })
);

/** 25 steps: one start, a fan-out of eight, a merge, and a chain, to stress the graph and list. */
export const WIDE = withActivity(
  run({
    id: 'run-wide',
    title: 'Audit every package for unused exports',
    steps: [
      step({
        key: 'plan',
        title: 'Split the audit by package',
        status: 'completed',
        ordinal: 0,
        ...started('plan', -2 * HOUR, -110 * MIN, 'completed'),
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        step({
          key: `pkg-${i + 1}`,
          title: `Audit package ${i + 1}`,
          status: i < 3 ? 'completed' : i < 5 ? 'running' : 'waiting',
          ordinal: i + 1,
          after: ['plan'],
          agent: i % 2 ? CODEX : OPUS,
          ...(i < 5
            ? started(
                `pkg-${i + 1}`,
                -100 * MIN,
                i < 3 ? -40 * MIN : null,
                i < 3 ? 'completed' : 'in_progress'
              )
            : {}),
        })
      ),
      step({
        key: 'merge',
        title: 'Merge the findings',
        ordinal: 9,
        after: Array.from({ length: 8 }, (_, i) => `pkg-${i + 1}`),
      }),
      ...Array.from({ length: 15 }, (_, i) =>
        step({
          key: `fix-${i + 1}`,
          title: `Fix finding ${i + 1}`,
          ordinal: 10 + i,
          after: [i === 0 ? 'merge' : `fix-${i}`],
        })
      ),
    ],
  })
);

/** Every text field at its longest, with a long URL and an unbroken token. */
export function longVariant(detail: WorkflowRunDetail): WorkflowRunDetail {
  return {
    ...detail,
    title: `${detail.title}: ${LONG_NAME}`,
    goal: `${LONG_SUMMARY}\n\n${LONG_SUMMARY}`,
    startedFrom: detail.startedFrom && {
      ...detail.startedFrom,
      title: `${detail.startedFrom.title} ${LONG_NAME}`,
    },
    steps: detail.steps.map((s) => ({
      ...s,
      title: `${s.title} ${LONG_NAME}`,
      instructions: `${s.instructions}\n\n${LONG_SUMMARY}`,
      reason: s.reason ? `${s.reason} ${'x'.repeat(120)} ${LONG_URL}` : s.reason,
      agent: s.agent && {
        ...s.agent,
        profileName: `${s.agent.profileName} with a very long profile name for reviewers`,
      },
      output: s.output && {
        ...s.output,
        summary: LONG_SUMMARY,
        branch: s.output.branch
          ? `${s.output.branch}-${'with-a-very-long-branch-name-'.repeat(4)}`
          : null,
        prUrl: s.output.prUrl ? LONG_URL : null,
      },
    })),
  };
}

export function specialVariant(detail: WorkflowRunDetail): WorkflowRunDetail {
  return {
    ...detail,
    title: `${detail.title} ${SPECIAL_TEXT}`,
    goal: `${detail.goal} <script>window.__automationXss=1</script>`,
    steps: detail.steps.map((s) => ({
      ...s,
      title: `${s.title} ${SPECIAL_TEXT}`,
      output: s.output && {
        ...s.output,
        summary: `${s.output.summary ?? ''} ${SPECIAL_TEXT}`,
        prUrl: s.output.prUrl ? 'javascript:window.__automationXss=1' : null,
      },
    })),
  };
}

export const summaryOf = (detail: WorkflowRunDetail): WorkflowRunSummary => ({
  id: detail.id,
  title: detail.title,
  status: detail.status,
  startedByUserId: detail.startedByUserId,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
  deadlineAt: detail.deadlineAt,
  steps: detail.steps.map(({ key, title, kind, status, reason }) => ({
    key,
    title,
    kind,
    status,
    reason,
  })),
});

export const NORMAL_RUNS = [WAITING, RELEASE, FAILED, DEADLINE, DONE];

/** Thirty runs for paging and long lists: alternating states, every third with a long title. */
export function manyRuns(): WorkflowRunDetail[] {
  return Array.from({ length: 30 }, (_, i) => {
    const base = [RELEASE, FAILED, DONE][i % 3] ?? RELEASE;
    return {
      ...base,
      id: `run-many-${i}`,
      title: `${base.title} #${i + 1}${i % 3 === 0 ? ` ${LONG_NAME}` : ''}`,
      createdAt: iso(-(i + 1) * HOUR),
    };
  });
}

export interface WorkflowMockOptions {
  runs?: WorkflowRunDetail[];
  /** Answer every workflow read with this status. */
  failWith?: 500 | 404;
  /** Page size for the list; cursors are the next index. */
  pageSize?: number;
}

/**
 * Serve the workflow routes. Register after `setupAutomationMocks`: later Playwright routes win
 * for the URLs they match.
 */
export async function setupWorkflowMocks(page: Page, options: WorkflowMockOptions = {}) {
  const runs = options.runs ?? NORMAL_RUNS;
  await page.route(`**/api/projects/${PROJECT_ID}/workflows**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (options.failWith === 500)
      return respond(500, {
        error: 'INTERNAL_ERROR',
        message: 'The project store did not answer in time.',
      });
    const detail = url.pathname.match(/\/workflows\/([^/]+)$/);
    if (detail) {
      const found = runs.find((r) => r.id === decodeURIComponent(detail[1] ?? ''));
      if (!found || options.failWith === 404)
        return respond(404, { error: 'NOT_FOUND', message: 'Workflow run not found' });
      return respond(200, { run: found });
    }
    const status = url.searchParams.get('status');
    const limit = Number(url.searchParams.get('limit')) || options.pageSize || 20;
    const start = Number(url.searchParams.get('cursor')) || 0;
    const matching = runs
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = matching.slice(start, start + limit).map(summaryOf);
    const next = start + limit < matching.length ? String(start + limit) : null;
    return respond(200, { runs: page, nextCursor: next });
  });
}
