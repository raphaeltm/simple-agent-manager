/**
 * Documentation screenshots for the SAM Connector guide
 * (apps/www/src/content/docs/docs/guides/sam-connector.md): the account's Settings → Access
 * page, where a person copies the Connector URL and sees their connected apps, and the approval
 * page an AI app sends them to.
 *
 * Every capture drives the REAL production pages with mocked API data and asserts on what
 * rendered, so a page that stops rendering fails the capture instead of shipping a stale image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). Stress cases (long untrusted app
 * names, many connections, errors) live in `connector-audit.spec.ts`; these fixtures are ordinary
 * on purpose, because readers compare their own page against them.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-connector \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 *
 * Each test self-selects its viewport, so running both projects writes the desktop and phone
 * images without either overwriting the other.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { docsShot } from './docs-shot';

const MOCK_USER = makeMockUser({
  email: 'docs@example.com',
  name: 'Docs User',
  sessionId: 'session-docs-connector',
  userId: 'user-docs-connector',
});

const HOUR = 3_600_000;
const NOW = Date.now();
const SCOPES = ['sam.read', 'sam.write', 'offline_access'];
const CONNECTOR_URL = 'https://api.example.com/connect/mcp';

/** Responses by path; anything else gets an empty object, which every page here tolerates. */
const RESPONSES: Record<string, unknown> = {
  '/api/connector/settings': {
    enabled: true,
    writeEnabled: true,
    url: CONNECTOR_URL,
  },
  '/api/connector/connections': {
    connections: [
      {
        id: 'grant-chatgpt',
        userId: MOCK_USER.user.id,
        clientId: 'client-chatgpt',
        clientName: 'ChatGPT',
        scopes: SCOPES,
        createdAt: NOW - 3 * 24 * HOUR,
        lastUsedAt: NOW - 2 * HOUR,
        revokedAt: null,
      },
    ],
    nextCursor: null,
  },
  '/api/connector/consent': {
    handle: 'docs-consent-handle',
    clientName: 'ChatGPT',
    redirectHost: 'chatgpt.com',
    loopback: false,
    scopes: SCOPES,
  },
  '/api/auth/api-tokens': [],
  '/api/projects': { projects: [], nextCursor: null },
  '/api/notifications/unread-count': { count: 0 },
  '/api/credentials': [],
  '/api/github/installations': [],
};

async function openPage(page: Page, path: string) {
  await seedTheme(page, 'dark');
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
  await page.route('**/api/**', (route: Route) => {
    const { pathname } = new URL(route.request().url());
    const body = pathname.startsWith('/api/auth/get-session')
      ? MOCK_USER
      : (RESPONSES[pathname] ?? {});
    return route.fulfill({ status: 200, json: body });
  });
  await page.goto(path);
  // Liveness: without this, a crash page would be captured as happily as the real one.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

async function openAccessSettings(page: Page) {
  await openPage(page, '/settings/access');
  await expect(page.getByRole('heading', { name: 'Connect an AI app' })).toBeVisible();
  // The URL also appears in the collapsed command examples, so look for the copyable box.
  await expect(page.locator('code', { hasText: CONNECTOR_URL })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add to Claude' })).toBeVisible();
  const connected = page.getByRole('region', { name: 'Connected apps' });
  await expect(connected.getByText('ChatGPT', { exact: true })).toBeVisible();
  await expect(connected.getByRole('button', { name: 'Revoke' })).toBeVisible();
  return connected;
}

test('docs: connector settings on the Access page', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  const connected = await openAccessSettings(page);
  const heading = page.getByRole('heading', { name: 'Connect an AI app' });
  // The app shell and the settings page each render a <main>; crop to the page's own.
  const pageMain = page.locator('main').filter({ has: heading }).last();
  await expect(page.getByRole('tab', { name: 'Access', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const tabs = await page.getByRole('tablist').boundingBox();
  const bottom = await connected.boundingBox();
  const area = await pageMain.boundingBox();
  if (!tabs || !bottom || !area) throw new Error('Access page regions did not lay out');
  // From the settings tabs down to the end of Connected apps: the API tokens card below is
  // unchanged and would only push the part the guide describes off the image.
  const y = tabs.y - 16;
  await docsShot(page, 'connector-access', {
    clip: { x: area.x, y, width: area.width, height: bottom.y + bottom.height + 24 - y },
  });
});

test('docs: connector settings on the Access page on a phone', async ({ page }) => {
  test.skip(!isMobile(page), 'mobile capture');
  await page.setViewportSize({ width: 375, height: 1000 });
  await openAccessSettings(page);
  await docsShot(page, 'connector-access-mobile');
});

async function openConsent(page: Page) {
  await openPage(page, '/oauth/consent?request=client_id%3Dclient-chatgpt');
  await expect(page.getByRole('heading', { name: 'ChatGPT wants access' })).toBeVisible();
  await expect(page.getByText('chatgpt.com', { exact: true })).toBeVisible();
  await expect(page.getByText('Start, steer, and stop work as you')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled();
}

test('docs: connector approval page', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await openConsent(page);
  // The page centres a narrow column on a full-screen background; crop to the column.
  const column = await page.getByRole('main').locator('section').first().boundingBox();
  if (!column) throw new Error('Consent column did not lay out');
  const pad = 40;
  await docsShot(page, 'connector-consent', {
    clip: {
      x: column.x - pad,
      y: column.y - pad,
      width: column.width + 2 * pad,
      height: column.height + 2 * pad,
    },
  });
});

test('docs: connector approval page on a phone', async ({ page }) => {
  test.skip(!isMobile(page), 'mobile capture');
  await openConsent(page);
  await docsShot(page, 'connector-consent-mobile');
});
