/**
 * Documentation screenshots for Automation → Workflows: the run list, a run on a wide screen
 * with the graph and one step's details, and a failed run on a phone.
 *
 * Every capture drives the real production pages with the mocked read contract used by
 * `workflow-runs-audit.spec.ts`, and asserts on what rendered before capturing, so a page that
 * stops rendering fails here instead of producing a stale image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-workflows \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 * then palette-compress them with
 *   pnpm --filter @simple-agent-manager/www compress:screenshots public/images/docs
 */
import { expect, type Page, test, type TestInfo } from '@playwright/test';

import { PROJECT_ID, setupAutomationMocks } from './automation-fixtures';
import { docsShot } from './docs-shot';
import { FAILED, RELEASE, setupWorkflowMocks } from './workflow-fixtures';

const LIST = `/projects/${PROJECT_ID}/automation/workflows`;

const isDesktop = (testInfo: TestInfo) => testInfo.project.name === 'Desktop (1280x800)';
const isPhone = (testInfo: TestInfo) => testInfo.project.name === 'iPhone SE (375x667)';

async function open(page: Page, path: string) {
  await setupAutomationMocks(page);
  await setupWorkflowMocks(page);
  await page.goto(path);
}

test('the list of workflow runs', async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), 'captured on desktop');
  await open(page, LIST);
  await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
  await expect(page.getByTestId('workflow-run-row')).toHaveCount(5);
  await docsShot(page, 'workflows-list');
});

test('a run: the graph, with one step open beside it', async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), 'captured on desktop');
  await open(page, `${LIST}/${RELEASE.id}?step=review-facts`);
  await expect(page.getByTestId('workflow-graph-node')).toHaveCount(RELEASE.steps.length);
  const details = page.getByRole('complementary', { name: 'Step details' });
  await expect(details.getByText('What it gets from earlier steps')).toBeVisible();
  await expect(details.getByText('What it produced')).toBeVisible();
  await docsShot(page, 'workflow-run-graph');
});

test('a failed run on a phone', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'captured on a phone');
  // A taller phone, so the whole callout and its three buttons fit in one image.
  await page.setViewportSize({ width: 375, height: 860 });
  await open(page, `${LIST}/${FAILED.id}`);
  await expect(page.getByTestId('workflow-attention')).toContainText('needs your attention');
  await expect(page.getByRole('button', { name: 'See the failed step' })).toBeVisible();
  await docsShot(page, 'workflow-run-failed-mobile');
});
