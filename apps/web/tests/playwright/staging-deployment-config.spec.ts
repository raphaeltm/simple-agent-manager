/**
 * Staging verification for an environment's settings (variables and secrets). Creates a
 * throwaway deployment environment via the API, then drives the environment page's
 * "Settings your app reads" section to add a plain setting (value shown) and a secret
 * (hidden after save), and verifies the rows. Cleans up the environment afterward.
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

test('manage settings and secrets from the environment page', async ({ page }) => {
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

  await page.goto(`${STAGING_APP}/projects/${projectId}/deployments/${envId}`, {
    waitUntil: 'networkidle',
  });

  const section = page.getByRole('region', { name: 'Settings your app reads' });
  await expect(section).toBeVisible();

  // Add a plain setting — its value is shown after saving.
  await section.getByRole('button', { name: 'Add' }).click();
  await section.getByLabel('Name').fill('PUBLIC_APP_DOMAIN');
  await section.getByLabel('Value').fill('app.example.com');
  await section.getByRole('button', { name: 'Add setting' }).click();
  await expect(section.getByText('PUBLIC_APP_DOMAIN')).toBeVisible({ timeout: 10000 });
  await expect(section.getByText('app.example.com')).toBeVisible();

  // Add a secret — its value is hidden after saving.
  await section.getByRole('button', { name: 'Add' }).click();
  await section.getByLabel('Name').fill('DATABASE_URL');
  await section.getByRole('switch', { name: 'Keep it secret' }).click();
  await section.getByLabel('Value').fill('postgres://secret');
  await section.getByRole('button', { name: 'Add setting' }).click();
  await expect(section.getByText('DATABASE_URL')).toBeVisible({ timeout: 10000 });
  await expect(section.getByText('Secret, hidden')).toBeVisible();
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
