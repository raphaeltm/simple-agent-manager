/**
 * Staging check for the sessions-first Nodes page: the real page against the real
 * GET /api/nodes/resource-usage. Run with SAM_PLAYWRIGHT_PRIMARY_USER set:
 *
 *   npx playwright test tests/playwright/staging-nodes-usage.spec.ts \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 *
 * With EXPECT_SESSION_WORKSPACE_ID set to a running workspace of the smoke user, it also
 * asserts that workspace's session row, its chat link and its usage history are on the page.
 */
import { expect, test } from '@playwright/test';

import { dismissStagingOnboarding, STAGING_APP, stagingLogin, stagingShot } from './staging-helpers';

test.skip(!process.env.SAM_PLAYWRIGHT_PRIMARY_USER, 'needs the staging smoke token');

test('Nodes page shows machines, sessions and their CPU and memory', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stagingLogin(page);

  const usageResponse = page.waitForResponse((res) =>
    res.url().endsWith('/api/nodes/resource-usage')
  );
  await page.goto(`${STAGING_APP}/nodes`);
  await dismissStagingOnboarding(page);

  const usage = await usageResponse;
  expect(usage.status(), await usage.text()).toBe(200);
  const body = (await usage.json()) as {
    windowMinutes: number;
    historyOmittedCount: number;
    workspaces: Array<{
      workspaceId: string;
      title: string;
      projectId: string | null;
      chatSessionId: string | null;
      series: { start: number[] };
    }>;
  };
  expect(body.windowMinutes).toBeGreaterThan(0);

  await expect(page.getByText(/Memory goes up/)).toBeVisible();
  await stagingShot(page, 'nodes-usage');

  const expected = process.env.EXPECT_SESSION_WORKSPACE_ID;
  if (expected) {
    const row = body.workspaces.find((w) => w.workspaceId === expected);
    expect(row, `workspace ${expected} missing from resource-usage`).toBeDefined();
    if (!row) return;
    expect(row.series.start.length, 'no usage history yet for the session').toBeGreaterThan(0);
    const link = page.getByRole('link', { name: row.title }).first();
    await expect(link).toBeVisible();
    if (row.projectId && row.chatSessionId) {
      await expect(link).toHaveAttribute(
        'href',
        `/projects/${row.projectId}/chat/${row.chatSessionId}`
      );
    }
    await expect(page.getByTestId('machine-chart').first()).toBeVisible();
    await link.scrollIntoViewIfNeeded();
    await stagingShot(page, 'nodes-usage-session');
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
