/**
 * Shared helpers for the marketing screenshot specs (`marketing-shots-*.spec.ts`).
 *
 * These specs render the REAL production components with mocked API data and
 * capture the images embedded in the public marketing site
 * (apps/www/src/data/features.ts → apps/www/public/images/features).
 *
 * Run with the marketing output flag to write committed images:
 *   MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-collab.spec.ts --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in the gitignored tmp dir, so the
 * specs are safe to run as part of the normal visual-audit sweep.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { makeMockUser } from './audit-helpers';

/** Spacious desktop viewport shared by every marketing capture (2x → 2880x1800). */
export const MARKETING_VIEWPORT = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  colorScheme: 'dark' as const,
};

const FEATURE_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/features');

/**
 * Shared fictional world so every marketing screenshot reads as one team's
 * project. Keep names, ids, and repo consistent across specs.
 */
export const NORTHWIND = {
  projectId: 'proj-payments',
  projectName: 'Payments API',
  repository: 'northwind-labs/payments-api',
  defaultBranch: 'main',
  owner: { id: 'user-priya', name: 'Priya Natarajan', email: 'priya@northwindlabs.dev' },
  members: [
    { id: 'user-marcus', name: 'Marcus Chen', email: 'marcus@northwindlabs.dev' },
    { id: 'user-elena', name: 'Elena Rossi', email: 'elena@northwindlabs.dev' },
    { id: 'user-tomas', name: 'Tomás Alvarez', email: 'tomas@northwindlabs.dev' },
    { id: 'user-aisha', name: 'Aisha Okafor', email: 'aisha@northwindlabs.dev' },
  ],
} as const;

/** The signed-in user for every marketing capture: the project owner. */
export const MARKETING_USER = makeMockUser({
  email: NORTHWIND.owner.email,
  name: NORTHWIND.owner.name,
  role: 'superadmin',
  sessionId: 'marketing-session',
  userId: NORTHWIND.owner.id,
});

/** Prevents the first-run onboarding wizard from covering the surface. */
export async function dismissOnboarding(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MARKETING_USER.user.id);
}

/**
 * Capture a focused element (or the viewport) into the marketing feature image
 * directory when MARKETING_SHOTS is set, otherwise into the gitignored tmp dir.
 */
export async function marketingShot(
  page: Page,
  name: string,
  locator?: ReturnType<Page['locator']>,
) {
  await page.waitForTimeout(700);
  const target = locator ?? page;
  if (process.env.MARKETING_SHOTS) {
    mkdirSync(FEATURE_IMAGE_DIR, { recursive: true });
    await target.screenshot({ path: `${FEATURE_IMAGE_DIR}/${name}.png` });
    return;
  }
  const tmp = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');
  mkdirSync(tmp, { recursive: true });
  await target.screenshot({ path: `${tmp}/${name}.png` });
}
