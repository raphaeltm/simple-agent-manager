/**
 * Documentation screenshots — renders the REAL production components with mocked
 * API data and captures the images embedded in the public docs site
 * (apps/www/src/content/docs).
 *
 * Run with the docs output flag to write committed images:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots --project="Desktop (1280x800)"
 *
 * Without DOCS_SHOTS the images land in the gitignored tmp dir, so the spec is
 * safe to run as part of the normal visual-audit sweep.
 *
 * Covered surfaces:
 *   1. Guided subscription sign-in modal (Claude Code) — /settings/agents
 *   2. Cloud provider connect picker (all seven providers) — /settings/connections
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import { type AuditResponder, makeMockUser, seedTheme, setupAuditRoutes } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'docs@example.com',
  name: 'Docs User',
  role: 'superadmin',
  sessionId: 'docs-session',
  userId: 'docs-user',
});

const DOCS_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/docs');

/**
 * Capture a focused element (or the full page) into the docs image directory when
 * DOCS_SHOTS is set, otherwise into the gitignored tmp dir with a viewport suffix.
 */
async function docsShot(page: Page, name: string, locator?: ReturnType<Page['locator']>) {
  await page.waitForTimeout(500);
  const target = locator ?? page;
  if (process.env.DOCS_SHOTS) {
    mkdirSync(DOCS_IMAGE_DIR, { recursive: true });
    await target.screenshot({ path: `${DOCS_IMAGE_DIR}/${name}.png` });
    return;
  }
  const suffix = page.viewportSize()?.width ?? 'x';
  const tmp = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
  mkdirSync(tmp, { recursive: true });
  await target.screenshot({ path: `${tmp}/${name}-${suffix}.png` });
}

async function dismissOnboarding(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
}

// ---------------------------------------------------------------------------
// 1. Guided subscription sign-in (Claude Code)
// ---------------------------------------------------------------------------

const CLAUDE_AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  description: "Anthropic's AI coding agent",
  supportsAcp: true,
  configured: false,
  credentialHelpUrl: 'https://console.anthropic.com/settings/keys',
  fallbackCredentialSource: null,
};

const SETUP_SESSION = {
  id: 'docs-guided-claude',
  status: 'waiting_for_user',
  agentType: 'claude-code',
  expiresAt: new Date(Date.now() + 1_200_000).toISOString(),
  verificationUrl: 'https://claude.ai/oauth/device?client_id=sam-docs&code=' + 'x'.repeat(48),
  userCode: 'SAMD-4821',
  errorCode: null,
  errorMessage: null,
};

async function setupGuidedMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/agents') return respond(200, { agents: [CLAUDE_AGENT] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/agent-credential-setup-sessions/config') {
      return respond(200, {
        enabled: true,
        agentType: 'openai-codex',
        agentTypes: ['openai-codex', 'claude-code'],
      });
    }
    if (path === '/api/agent-credential-setup-sessions' && method === 'POST') {
      return respond(201, SETUP_SESSION);
    }
    if (path === `/api/agent-credential-setup-sessions/${SETUP_SESSION.id}`) {
      return respond(200, SETUP_SESSION);
    }
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.startsWith('/api/github')) return respond(200, []);
    return respond(200, {});
  });
}

test('docs: guided subscription sign-in modal (Claude Code)', async ({ page }) => {
  await dismissOnboarding(page);
  await seedTheme(page, 'dark');
  await setupGuidedMocks(page);

  await page.goto('/settings/agents');
  await expect(page.getByTestId('agent-card-claude-code')).toBeVisible();

  await page.getByRole('button', { name: 'OAuth Token (Pro/Max)' }).click();
  await page.getByRole('button', { name: 'Connect with Claude Code' }).click();

  const dialog = page.getByRole('dialog', { name: 'Connect with Claude Code' });
  await expect(dialog.getByRole('link', { name: 'Open Claude sign-in' })).toBeVisible();
  await expect(dialog.locator('code')).toHaveText(SETUP_SESSION.userCode);
  await expect(dialog.getByRole('button', { name: 'Copy code' })).toBeVisible();

  // Make the backdrop fully opaque so the settings page behind the modal does not
  // bleed through the card's rounded corners in the docs screenshot.
  await page.addStyleTag({
    content:
      '.glass-backdrop-dim{background:#0a0e0c !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  });

  // Screenshot just the modal card (not the full-viewport backdrop overlay).
  await docsShot(page, 'agent-guided-login', dialog.locator('.glass-panel-container'));
});

// ---------------------------------------------------------------------------
// 2. Cloud provider connect picker (all seven providers)
// ---------------------------------------------------------------------------

const RESOLUTION_CONSUMERS = [
  {
    consumerId: 'claude-code',
    consumerName: 'Claude Code',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Claude default key',
    credentialKind: 'api-key',
    configurationName: 'Claude Code default',
    statusReason: null,
    halted: false,
    validation: { status: 'valid', message: 'Credential format is valid' },
  },
  {
    consumerId: 'hetzner',
    consumerName: 'Hetzner Cloud',
    consumerKind: 'compute',
    source: 'unresolved',
    credentialName: null,
    credentialKind: null,
    configurationName: null,
    statusReason: null,
    halted: false,
    validation: undefined,
  },
];

async function setupCloudConnectMocks(page: Page) {
  await setupAuditRoutes(page, (path: string, respond: AuditResponder) => {
    if (path.includes('/api/auth')) return respond(200, MOCK_USER);
    if (path === '/api/credentials/resolution-status') {
      return respond(200, { consumers: RESOLUTION_CONSUMERS });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path === '/api/github/installations') return respond(200, []);
    return undefined;
  });
}

test('docs: cloud provider connect picker', async ({ page }) => {
  await dismissOnboarding(page);
  await seedTheme(page, 'dark');
  await setupCloudConnectMocks(page);

  await page.goto('/settings/connections');
  await page.waitForSelector('.glass-surface', { state: 'visible', timeout: 20000 });

  // The unresolved Hetzner (compute) row exposes a "Make default" action (its
  // onConnect handler) that opens the cloud provider picker.
  await page.getByRole('button', { name: 'Make default' }).click();

  // The picker renders a card for every provider; wait for the ones added most
  // recently so we know the full list is on screen.
  await expect(page.getByText('DigitalOcean', { exact: true })).toBeVisible();
  await expect(page.getByText('UpCloud', { exact: true })).toBeVisible();
  await expect(page.getByText('Infomaniak Public Cloud', { exact: true })).toBeVisible();

  const card = page.locator('.glass-surface').filter({ hasText: 'UpCloud' }).first();
  await docsShot(page, 'cloud-provider-connect', card);
});
