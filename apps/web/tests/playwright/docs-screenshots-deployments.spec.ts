/**
 * Documentation screenshot for a deployment whose pause stopped partway (App Deployments
 * guide, "If pausing doesn't finish"), on a desktop and a phone.
 *
 * Drives the REAL environment page with the shared Deployments mock and its `env-load`
 * fixture: an environment whose Stop failed while tearing down its server, the shape
 * `markEnvironmentStopFailed` writes. Every other state is audited in
 * `deployments-ui-audit.spec.ts`.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-deployments \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, test } from '@playwright/test';

import { PROJECT_ID } from './deployments-ui-fixtures';
import { mockApi } from './deployments-ui-mocks';
import { docsShot } from './docs-shot';

test("docs: a pause that didn't finish", async ({ page }) => {
  const mobile = (page.viewportSize()?.width ?? 0) < 500;
  await page.setViewportSize({ width: mobile ? 375 : 1280, height: mobile ? 1100 : 900 });
  await mockApi(page);
  await page.goto(`/projects/${PROJECT_ID}/deployments/env-load`);

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('load-test');
  await expect(
    page.getByText('SAM stopped partway, so the app may still be running.').first()
  ).toBeVisible();
  const problems = page.getByRole('region', { name: 'Needs your attention' });
  const pauseCard = problems.getByLabel("Pausing didn't finish");
  await expect(pauseCard.getByRole('button', { name: 'Pause again' })).toBeVisible();
  await expect(pauseCard.getByRole('button', { name: 'See the server' })).toBeVisible();
  await page.mouse.move(2, 2);

  // From the environment's name to the end of its problem card: the status and the fix.
  const top = await heading.boundingBox();
  const bottom = await problems.boundingBox();
  const viewport = page.viewportSize();
  if (!top || !bottom || !viewport) throw new Error('environment page has no geometry');
  const x = mobile ? 0 : Math.max(0, bottom.x - 24);
  const right = mobile ? viewport.width : bottom.x + bottom.width + 24;
  await docsShot(page, mobile ? 'deployment-pause-failed-mobile' : 'deployment-pause-failed', {
    clip: {
      x,
      y: Math.max(0, top.y - 24),
      width: right - x,
      height: bottom.y + bottom.height + 24 - Math.max(0, top.y - 24),
    },
  });
});
