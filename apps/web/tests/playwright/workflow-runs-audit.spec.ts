/**
 * Visual, layout and interaction audit for Automation → Workflows: the run list, the run page
 * (steps, graph, activity, step details), the overview's workflow sections, and the event-wait
 * view. Runs at 375×667, 390×844 and 1280×800 with production-shaped mock data, including long
 * text, a 25-step fan-out, markup in names, and failing reads. Every surface is checked for
 * horizontal (and clipped) overflow and for tap targets under 44 px.
 */
import { expect, type Page, test, type TestInfo } from '@playwright/test';

import { audit } from './automation-audit-helpers';
import { PROJECT_ID, setupAutomationMocks } from './automation-fixtures';
import {
  DEADLINE,
  DONE,
  FAILED,
  longVariant,
  manyRuns,
  RELEASE,
  setupWorkflowMocks,
  specialVariant,
  WAITING,
  WIDE,
  type WorkflowMockOptions,
} from './workflow-fixtures';

const AUTOMATION = `/projects/${PROJECT_ID}/automation`;
const LIST = `${AUTOMATION}/workflows`;
const runPath = (id: string, query = '') => `${LIST}/${id}${query}`;

function onlyOn(names: string[]) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(!names.includes(testInfo.project.name), 'audited on phones and desktop');
  };
}
test.beforeEach(onlyOn(['iPhone SE (375x667)', 'iPhone 14 (390x844)', 'Desktop (1280x800)']));

const isDesktop = (testInfo: TestInfo) => testInfo.project.name.startsWith('Desktop');

async function open(page: Page, path: string, workflows: WorkflowMockOptions = {}, empty = false) {
  await setupAutomationMocks(page, { empty });
  await setupWorkflowMocks(page, workflows);
  await page.goto(path);
}

test.describe('Workflows list', () => {
  test('normal: problems first, then running, then finished', async ({ page }) => {
    await open(page, LIST);
    await expect(page.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toBeVisible();
    const rows = page.getByTestId('workflow-run-row');
    await expect(rows).toHaveCount(5);
    // Attention first, newest first within each group.
    await expect(rows.nth(0)).toContainText('Fix the flaky upload test');
    await expect(rows.nth(0)).toContainText('“Fix and test it” failed · 1 step did not start');
    await expect(rows.nth(1)).toContainText('Nightly dependency upgrade');
    await expect(rows.nth(2)).toContainText('Merge the docs fix');
    await expect(rows.nth(2)).toContainText('Listening on “Wait for CI”');
    await expect(rows.nth(3)).toContainText('Working on “Review tone and wording”');
    await expect(rows.nth(4)).toContainText('All 2 steps done');
    await expect(rows.nth(0)).toContainText('Started by you');
    await expect(rows.nth(0)).toHaveAttribute('href', runPath('run-flaky'));
    // No controls the engine does not have.
    await expect(
      page.getByRole('button', { name: /retry|cancel|pause|new workflow/i })
    ).toHaveCount(0);
    await audit(page, 'workflows-list');
  });

  test('status chips narrow the list and live in the URL', async ({ page }) => {
    await open(page, `${LIST}?status=needs_attention`);
    await expect(page.getByRole('radio', { name: 'Needs attention' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(page.getByTestId('workflow-run-row')).toHaveCount(2);
    await page.getByRole('radio', { name: 'Done' }).click();
    await expect(page).toHaveURL(/status=completed/);
    await expect(page.getByTestId('workflow-run-row')).toHaveCount(1);
    await expect(page.getByTestId('workflow-run-row')).toContainText('Weekly ideas review');
  });

  test('empty: explains how to start one, with no create button', async ({ page }) => {
    await open(page, LIST, { runs: [] });
    await expect(page.getByRole('heading', { name: 'No workflows yet' })).toBeVisible();
    await expect(page.getByText(/Plan this as a workflow/)).toBeVisible();
    await expect(page.getByTestId('automation-root').getByRole('button')).toHaveCount(0);
    await audit(page, 'workflows-empty');
  });

  test('many runs with long titles page in with "Show older workflows"', async ({ page }) => {
    await open(page, LIST, { runs: manyRuns(), pageSize: 20 });
    await expect(page.getByTestId('workflow-run-row')).toHaveCount(20);
    await page.getByRole('button', { name: 'Show older workflows' }).click();
    await expect(page.getByTestId('workflow-run-row')).toHaveCount(30);
    await expect(page.getByRole('button', { name: 'Show older workflows' })).toHaveCount(0);
    await audit(page, 'workflows-many-long');
  });

  test('a failed read says so and offers a retry', async ({ page }) => {
    await open(page, LIST, { failWith: 500 });
    await expect(page.getByRole('alert')).toContainText('Could not load workflows');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await audit(page, 'workflows-error');
  });
});

test.describe('Workflow run page', () => {
  test('normal: stages, progress, and the default view for the screen', async ({
    page,
  }, testInfo) => {
    await open(page, runPath(RELEASE.id));
    await expect(page.getByRole('heading', { name: RELEASE.title, level: 1 })).toBeVisible();
    await expect(page.getByTestId('workflow-progress-sentence')).toHaveText(
      '2 of 5 steps done · 1 running · 2 waiting'
    );
    await expect(page.getByTestId('workflow-attention')).toHaveCount(0);
    if (isDesktop(testInfo)) {
      // Wide screens open on the graph, with the run's details beside it.
      await expect(page.getByRole('tab', { name: 'Graph' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(page.getByTestId('workflow-graph-node')).toHaveCount(5);
      await expect(page.getByTestId('workflow-graph-scroll-hint')).toHaveCount(0);
      await expect(page.getByTestId('workflow-run-about')).toBeVisible();
      await expect(page.locator('.react-flow__edge')).toHaveCount(5);
      await audit(page, 'workflow-run-graph');
      await page.getByRole('tab', { name: 'Steps' }).click();
    } else {
      await expect(page.getByRole('tab', { name: 'Steps' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    }
    const steps = page.getByTestId('workflow-steps');
    await expect(steps.getByText('First', { exact: true })).toBeVisible();
    await expect(steps.getByText('Then · at the same time')).toBeVisible();
    await expect(steps.getByText('Finally', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workflow-step-card')).toHaveCount(5);
    await expect(
      page.locator('[data-testid="workflow-step-card"][data-step="revise"]')
    ).toContainText('Starts after “Review tone and wording” finishes.');
    await audit(page, 'workflow-run-steps');
  });

  test('a step shows its inputs, outputs, evidence and chat', async ({ page }, testInfo) => {
    await open(page, runPath(RELEASE.id, '?view=steps'));
    await page.getByTestId('workflow-step-card').filter({ hasText: 'Check every claim' }).click();
    const detail = page.getByTestId('workflow-step-detail');
    await expect(detail).toBeVisible();
    await expect(page).toHaveURL(/step=review-facts/);
    await expect(
      detail.getByRole('heading', { name: 'Check every claim against merged PRs' })
    ).toBeVisible();
    await expect(detail.getByText('What it gets from earlier steps')).toBeVisible();
    await expect(detail.getByText(/Draft saved as Library file/)).toBeVisible();
    await expect(detail.getByRole('link', { name: 'Open the chat' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/chat/chat-review-facts`
    );
    await expect(
      detail.getByRole('link', { name: /Library file 01M5H1A2B3C4D5E6F7G8H9J0K1/ })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/library?preview=01M5H1A2B3C4D5E6F7G8H9J0K1`);
    // The draft's pull request is a real external link from the inputs section.
    await expect(detail.getByRole('link', { name: /Pull request/ }).first()).toHaveAttribute(
      'href',
      'https://github.com/acme/simple-agent-manager/pull/2404'
    );
    if (!isDesktop(testInfo)) {
      // On phones the step replaces the list; "All steps" goes back to it.
      await expect(page.getByTestId('workflow-steps')).toHaveCount(0);
      await audit(page, 'workflow-step-detail');
      await page.getByRole('button', { name: 'All steps' }).click();
      await expect(page.getByTestId('workflow-steps')).toBeVisible();
      await expect(page).not.toHaveURL(/step=/);
    } else {
      // On wide screens it sits beside the steps, which stay in place.
      const box = await detail.boundingBox();
      const list = await page.getByTestId('workflow-steps').boundingBox();
      expect(box && list && box.x).toBeGreaterThan((list?.x ?? 0) + (list?.width ?? 0) - 1);
      await audit(page, 'workflow-step-detail');
    }
  });

  test('the draft step shows the evidence its agent reported', async ({ page }) => {
    await open(page, runPath(RELEASE.id, '?view=steps&step=draft'));
    const detail = page.getByTestId('workflow-step-detail');
    await expect(detail.getByText('What it produced')).toBeVisible();
    await expect(detail.getByText("Reported by the step's agent.")).toBeVisible();
    await expect(detail.getByText('pnpm lint:links docs')).toBeVisible();
    await expect(detail.getByRole('link', { name: 'Open the pull request' })).toHaveAttribute(
      'href',
      'https://github.com/acme/simple-agent-manager/pull/2404'
    );
  });

  test('failed run: the reason, what did not start, and real next steps', async ({ page }) => {
    await open(page, runPath(FAILED.id));
    const callout = page.getByTestId('workflow-attention');
    await expect(callout).toContainText('This workflow needs your attention');
    await expect(callout).toContainText(
      '“Fix and test it” failed: Agent process exited with code 1'
    );
    await expect(callout).toContainText('1 step did not start');
    await expect(callout).toContainText('SAM does not retry failed steps');
    await expect(callout.getByRole('link', { name: 'Open its chat' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/chat/chat-fix`
    );
    await expect(
      callout.getByRole('link', { name: 'Open the chat that started it' })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/chat-planner`);
    await audit(page, 'workflow-run-failed');
    await callout.getByRole('button', { name: 'See the failed step' }).click();
    await expect(page).toHaveURL(/step=fix/);
    await expect(page.getByTestId('workflow-step-explanation')).toContainText('3 tests failed');
    // A blocked step points at the step that failed.
    await open(page, runPath(FAILED.id, '?view=steps&step=ship'));
    await expect(page.getByTestId('workflow-step-explanation')).toHaveText(
      'Did not start because “Fix and test it” did not succeed.'
    );
    await page.getByRole('button', { name: 'See the step that failed' }).click();
    await expect(page).toHaveURL(/step=fix/);
  });

  test('a run that hit its deadline says so in the engine’s words', async ({ page }) => {
    await open(page, runPath(DEADLINE.id));
    await expect(page.getByTestId('workflow-attention')).toContainText(
      'Workflow deadline exceeded'
    );
    await expect(page.getByTestId('workflow-progress-sentence')).toHaveText(
      '0 of 2 steps done · 2 failed'
    );
  });

  test('an event-wait step shows what it listens for and when it gives up', async ({ page }) => {
    await open(page, runPath(WAITING.id, '?view=steps&step=wait-ci'));
    const detail = page.getByTestId('workflow-step-detail');
    await expect(detail).toContainText('Step 2 of 3 · waits for an event');
    await expect(detail.getByText('Listening', { exact: true })).toBeVisible();
    // The fixture's clock starts when the file loads, so the countdown may have moved a minute.
    await expect(page.getByTestId('workflow-step-explanation')).toHaveText(
      /^Listening for CI to finish on pull request #2405\. Gives up in 4\d min\.$/
    );
    await expect(detail.getByText('What it waits for')).toBeVisible();
    await expect(detail.getByText('check_suite.completed')).toBeVisible();
    // A wait step has no agent chat to open.
    await expect(detail.getByRole('link', { name: 'Open the chat' })).toHaveCount(0);
    await audit(page, 'workflow-wait-step');
  });

  test('25 steps with an eight-way fan-out stay readable in both views', async ({
    page,
  }, testInfo) => {
    await open(page, runPath(WIDE.id, '?view=graph'), { runs: [WIDE] });
    await expect(page.getByTestId('workflow-graph-node')).toHaveCount(25);
    const graph = page.getByTestId('workflow-graph');
    const box = await graph.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.width).toBeLessThanOrEqual(viewport?.width ?? 0);
    // Too wide to read when shrunk: it scrolls sideways, says so, and opens on its middle,
    // where the start, the merge and the chain are.
    await expect(page.getByTestId('workflow-graph-scroll-hint')).toBeVisible();
    const start = await page
      .locator('[data-testid="workflow-graph-node"][data-step="plan"]')
      .boundingBox();
    expect(start && box && start.x >= box.x && start.x + start.width <= box.x + box.width).toBe(
      true
    );
    await audit(page, 'workflow-run-wide-graph');
    await page.getByRole('tab', { name: 'Steps' }).click();
    await expect(page.getByTestId('workflow-step-card')).toHaveCount(25);
    if (isDesktop(testInfo)) {
      // Steps that run at the same time sit side by side on wide screens.
      const first = await page.getByTestId('workflow-step-card').nth(1).boundingBox();
      const second = await page.getByTestId('workflow-step-card').nth(2).boundingBox();
      expect(first && second && Math.abs(first.y - second.y)).toBeLessThan(2);
    }
    await audit(page, 'workflow-run-wide-steps');
  });

  test('long text wraps everywhere', async ({ page }) => {
    const long = longVariant(FAILED);
    await open(page, runPath(long.id, '?view=steps&step=fix'), { runs: [long] });
    await expect(page.getByTestId('workflow-step-detail')).toBeVisible();
    await audit(page, 'workflow-run-long-text');
    await page.getByRole('button', { name: 'Show all' }).first().click();
    await expect(page.getByRole('button', { name: 'Show less' }).first()).toBeVisible();
  });

  test('markup in agent text renders as text and unsafe links are not links', async ({ page }) => {
    const special = specialVariant(RELEASE);
    await open(page, runPath(special.id, '?view=steps&step=draft'), { runs: [special] });
    await expect(page.getByTestId('workflow-step-detail')).toBeVisible();
    expect(
      await page.evaluate(() => (window as { __automationXss?: number }).__automationXss)
    ).toBeUndefined();
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await audit(page, 'workflow-run-special-characters');
  });

  test('activity reads as a story and links to its steps', async ({ page }) => {
    await open(page, runPath(DONE.id, '?view=activity'));
    const activity = page.getByTestId('workflow-activity');
    await expect(activity).toContainText('“Collect new ideas” finished');
    await expect(activity).toContainText('The workflow finished');
    await audit(page, 'workflow-run-activity');
    await activity.getByRole('button', { name: /“Rank them” finished/ }).click();
    await expect(page).toHaveURL(/step=rank/);
  });

  test('a missing run and a failed read are told apart', async ({ page }) => {
    await open(page, runPath('run-gone'));
    await expect(page.getByText('This workflow run is not here')).toBeVisible();
    await audit(page, 'workflow-run-not-found');
    await open(page, runPath(RELEASE.id), { failWith: 500 });
    await expect(page.getByRole('alert')).toContainText('Could not load this workflow');
  });
});

test.describe('Workflows on the Automation overview', () => {
  test('runs that need attention join the section; the panel links to all', async ({ page }) => {
    await open(page, AUTOMATION);
    const attention = page.getByTestId('automation-attention');
    await expect(attention.getByTestId('workflow-attention-panel')).toHaveCount(2);
    await expect(attention).toContainText('“Fix and test it” failed · 1 step did not start');
    await expect(
      attention.getByRole('link', { name: 'See what went wrong' }).first()
    ).toHaveAttribute('href', /\/automation\/workflows\/run-(flaky|deadline)\?step=/);
    const panel = page.getByTestId('automation-workflows');
    await expect(panel.getByTestId('workflow-run-row')).toHaveCount(5);
    await expect(panel.getByRole('link', { name: 'All', exact: true })).toHaveAttribute(
      'href',
      LIST
    );
    await audit(page, 'automation-overview-workflows');
  });

  test('a project with no automation and no workflows still shows where workflows live', async ({
    page,
  }) => {
    await open(page, AUTOMATION, { runs: [] }, true);
    await expect(page.getByText('Nothing runs on its own yet')).toBeVisible();
    const panel = page.getByTestId('automation-workflows');
    await expect(panel.getByRole('link', { name: /No workflows yet/ })).toHaveAttribute(
      'href',
      LIST
    );
    await audit(page, 'automation-overview-no-workflows');
  });
});
