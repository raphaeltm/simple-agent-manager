/**
 * Marketing capture for the software-factory homepage (apps/www/src/components/factory/): the
 * workflow behind its running example, "Retry failed webhook deliveries". The lead agent's plan is
 * build, two reviews at once, apply both, then wait for CI on the pull request.
 *
 *   MARKETING_SHOTS=1 [MARKETING_THEME=light] npx playwright test marketing-shots-factory \
 *     --project="Desktop (1280x800)"
 *
 * Drives the real Workflows page with the read contract served by `workflow-fixtures.ts`.
 */
import { expect, test } from '@playwright/test';
import type { WorkflowRunDetail, WorkflowStepDetail } from '@simple-agent-manager/shared';

import { NOW, PROJECT_ID, setupAutomationMocks } from './automation-fixtures';
import { MARKETING_VIEWPORT, marketingShot } from './marketing-shots-helpers';
import { RELEASE, setupWorkflowMocks, WAITING } from './workflow-fixtures';

test.use(MARKETING_VIEWPORT);

const MIN = 60_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const BUILDER = { profileId: 'profile-builder', profileName: 'Careful Builder', agentType: 'claude-code', model: 'claude-opus-5-5' };
const REVIEWER = { profileId: 'profile-reviewer', profileName: 'Code Reviewer', agentType: 'openai-codex', model: 'gpt-6-astra' };

const base = RELEASE.steps[0] as WorkflowStepDetail;
const waitBase = WAITING.steps[1] as WorkflowStepDetail;

function agentStep(over: Partial<WorkflowStepDetail> & Pick<WorkflowStepDetail, 'key' | 'title'>): WorkflowStepDetail {
  return {
    ...base,
    status: 'waiting',
    after: [],
    output: null,
    taskId: null,
    sessionId: null,
    taskStatus: null,
    launchAttempts: 0,
    startedAt: null,
    finishedAt: null,
    attemptId: `att-${over.key}`,
    instructions: `Do the work for “${over.title}”. Save anything others need in the project Library and finish with complete_task.`,
    ...over,
  };
}

const started = (key: string, from: number, to: number | null, taskStatus: string) => ({
  taskId: `task-${key}`,
  sessionId: `chat-${key}`,
  taskStatus,
  launchAttempts: 1,
  startedAt: iso(from),
  finishedAt: to === null ? null : iso(to),
});

const WEBHOOK_RUN: WorkflowRunDetail = {
  ...RELEASE,
  id: 'run-webhook-retries',
  title: 'Retry failed webhook deliveries',
  goal: 'Retry failed webhook deliveries with backoff for up to 3 days, reviewed and green in CI.',
  startedFrom: { taskId: 'task-lead', sessionId: 'chat-lead', title: 'Plan: retry failed webhook deliveries' },
  createdAt: iso(-95 * MIN),
  updatedAt: iso(-4 * MIN),
  activity: [],
  steps: [
    agentStep({
      key: 'build',
      title: 'Build the retry schedule',
      status: 'completed',
      ordinal: 0,
      agent: BUILDER,
      ...started('build', -95 * MIN, -52 * MIN, 'completed'),
      output: {
        summary: 'Opened PR #482: retries back off from 1 minute to 12 hours over 3 days, and the delivery log shows each attempt.',
        branch: 'sam/retry-webhook-deliveries',
        prUrl: 'https://github.com/northwind-labs/payments-api/pull/482',
        evidence: { testsRun: [{ command: 'pnpm test tests/unit/delivery', passed: true }], notes: null },
        handoffs: [],
      },
    }),
    agentStep({
      key: 'review-code',
      title: 'Review the code',
      status: 'completed',
      ordinal: 1,
      after: ['build'],
      agent: REVIEWER,
      ...started('review-code', -50 * MIN, -21 * MIN, 'completed'),
      output: {
        summary: 'One change asked for: cap the retry log at 20 entries per event. Otherwise ready.',
        branch: null,
        prUrl: null,
        evidence: null,
        handoffs: [],
      },
    }),
    agentStep({
      key: 'try-it',
      title: 'Try it against a flaky endpoint',
      status: 'running',
      ordinal: 2,
      after: ['build'],
      agent: BUILDER,
      ...started('try-it', -50 * MIN, null, 'in_progress'),
    }),
    agentStep({ key: 'apply', title: 'Apply both reviews', ordinal: 3, after: ['review-code', 'try-it'], agent: BUILDER }),
    {
      ...waitBase,
      key: 'wait-ci',
      title: 'Wait for CI on PR #482',
      status: 'waiting',
      ordinal: 4,
      after: ['apply'],
      startedAt: null,
      wait: {
        ...(waitBase.wait as NonNullable<WorkflowStepDetail['wait']>),
        description: 'CI to finish on pull request #482',
        subject: { type: 'pull_request', id: '482' },
        listeningSince: null as unknown as string,
      },
    },
  ],
};

test('sam-factory-workflow', async ({ page }) => {
  await setupAutomationMocks(page);
  await setupWorkflowMocks(page, { runs: [WEBHOOK_RUN] });
  await page.goto(`/projects/${PROJECT_ID}/automation/workflows/${WEBHOOK_RUN.id}?step=review-code`);

  await expect(page.getByTestId('workflow-graph-node')).toHaveCount(WEBHOOK_RUN.steps.length);
  await expect(page.getByRole('heading', { name: 'Retry failed webhook deliveries' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await marketingShot(page, 'sam-factory-workflow');
});
