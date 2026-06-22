/**
 * Staging verification for the unified deployment Variables/Secrets config
 * panel (combined PR #1381). Creates a throwaway deployment environment via
 * the API, then drives the Configuration subpage UI to add a non-secret
 * Variable (plaintext value shown) and a Secret (hidden after save), and
 * verifies the row states. Cleans up the environment afterward.
 */
import { expect, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';

test.describe.configure({ mode: 'serial' });

let projectId = '';
let envId = '';
let userId = '';
const ENV_NAME = `pw-cfg-${Date.now().toString(36)}`;

test.beforeAll(async ({ request }) => {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  const login = await request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(login.status()).toBe(200);

  const sessionResp = await request.get(`${STAGING_API}/api/auth/get-session`);
  expect(sessionResp.status()).toBe(200);
  const session = await sessionResp.json();
  userId = session.user?.id ?? '';
  expect(userId).not.toBe('');

  const projectsResp = await request.get(`${STAGING_API}/api/projects`);
  expect(projectsResp.status()).toBe(200);
  const projectsBody = await projectsResp.json();
  const projects = projectsBody.projects ?? projectsBody;
  expect(Array.isArray(projects) && projects.length > 0).toBe(true);
  projectId = projects[0].id;

  const createResp = await request.post(
    `${STAGING_API}/api/projects/${projectId}/environments`,
    { data: { name: ENV_NAME }, headers: { 'Content-Type': 'application/json' } },
  );
  expect(createResp.status()).toBe(201);
  const env = await createResp.json();
  envId = env.id;
});

test.afterAll(async ({ request }) => {
  if (projectId && envId) {
    await request.delete(`${STAGING_API}/api/projects/${projectId}/environments/${envId}`);
  }
});

test('manage Variables and Secrets from the Configuration tab', async ({ page }) => {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });

  // Suppress the first-visit onboarding overlay, which otherwise renders a
  // full-screen modal that intercepts all pointer events.
  await page.addInitScript((uid) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${uid}`, 'true');
  }, userId);

  await page.goto(`${STAGING_APP}/projects/${projectId}/deployments/${envId}?tab=config`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1200);

  const panel = page.locator(`#deployment-config-${envId}`);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Configuration', { exact: true })).toBeVisible();

  // Add a non-secret Variable — value should be visible after save.
  await panel.getByPlaceholder('DATABASE_URL').fill('PUBLIC_APP_DOMAIN');
  await panel.getByPlaceholder('Value').fill('app.example.com');
  await panel.getByRole('button', { name: /Add|Update/ }).click();
  await expect(panel.getByText('PUBLIC_APP_DOMAIN')).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText('app.example.com')).toBeVisible();
  await expect(panel.locator('span').filter({ hasText: /^Variable$/ })).toBeVisible();

  // Add a Secret — value should be hidden after save.
  await panel.getByPlaceholder('DATABASE_URL').fill('DATABASE_URL');
  await panel.getByText('Secret').click(); // toggle the Secret checkbox label
  await panel.getByPlaceholder('Hidden after save').fill('postgres://secret');
  await panel.getByRole('button', { name: /Add|Update/ }).click();
  await expect(panel.getByText('DATABASE_URL')).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText('Hidden after save')).toBeVisible();
  // Secret plaintext must NOT be rendered anywhere.
  await expect(page.getByText('postgres://secret')).toHaveCount(0);

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/staging-deployment-config.png`,
    fullPage: true,
  });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
