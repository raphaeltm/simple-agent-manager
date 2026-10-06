import { mkdirSync } from 'node:fs';

import { expect, type Page, type Route, test } from '@playwright/test';

const MOCK_USER = {
  user: {
    id: 'user-guided-claude',
    email: 'guided@example.com',
    name: 'Guided Claude User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-07-25T00:00:00Z',
    updatedAt: '2026-07-25T00:00:00Z',
  },
  session: {
    id: 'session-guided-claude',
    userId: 'user-guided-claude',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-07-25T00:00:00Z',
    updatedAt: '2026-07-25T00:00:00Z',
  },
};

const MOCK_CLAUDE_AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  description: "Anthropic's AI coding agent",
  supportsAcp: true,
  configured: false,
  credentialHelpUrl: 'https://console.anthropic.com/settings/keys',
  fallbackCredentialSource: null,
};

const CLAUDE_VERIFICATION_URL =
  'https://claude.ai/oauth/device?client_id=sam-playwright&challenge=' + 'x'.repeat(180);
const CLAUDE_USER_CODE = 'CLDE-PLAYWRIGHT-2026-LONG-CODE';
const CLAUDE_SUBMITTED_CODE = 'abc123#state-playwright';
const SETUP_SESSION = {
  id: 'setup-claude-guided-audit',
  status: 'waiting_for_user',
  agentType: 'claude-code',
  expiresAt: new Date(Date.now() + 1_200_000).toISOString(),
  verificationUrl: CLAUDE_VERIFICATION_URL,
  userCode: CLAUDE_USER_CODE,
  errorCode: null,
  errorMessage: null,
};
const COMPLETED_SETUP_SESSION = {
  ...SETUP_SESSION,
  status: 'completed',
  verificationUrl: null,
  userCode: null,
};

function respond(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupApiMocks(
  page: Page,
  seenSetupAgentTypes: string[],
  seenSubmittedCodes: string[],
  submissionResponse: Record<string, unknown> = COMPLETED_SETUP_SESSION
) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.includes('/api/auth/')) return respond(route, 200, MOCK_USER);
    if (path === '/api/agents') return respond(route, 200, { agents: [MOCK_CLAUDE_AGENT] });
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });

    const settingsMatch = path.match(/^\/api\/agent-settings\/([^/]+)$/);
    if (settingsMatch) {
      if (method === 'PUT') {
        const body = request.postDataJSON() as Record<string, unknown>;
        return respond(route, 200, {
          agentType: settingsMatch[1],
          model: body.model ?? null,
          permissionMode: body.permissionMode ?? 'default',
          allowedTools: null,
          deniedTools: null,
          additionalEnv: null,
          opencodeProvider: null,
          opencodeBaseUrl: null,
          providerMode: body.providerMode ?? null,
          createdAt: '2026-07-25T00:00:00Z',
          updatedAt: new Date().toISOString(),
        });
      }
      return respond(route, 404, { error: 'Not found' });
    }

    if (path === '/api/agent-credential-setup-sessions/config') {
      return respond(route, 200, {
        enabled: true,
        agentType: 'openai-codex',
        agentTypes: ['openai-codex', 'claude-code'],
      });
    }
    if (path === '/api/agent-credential-setup-sessions' && method === 'POST') {
      const body = request.postDataJSON() as { agentType?: string };
      seenSetupAgentTypes.push(body.agentType ?? '');
      return respond(route, 201, SETUP_SESSION);
    }
    if (path === `/api/agent-credential-setup-sessions/${SETUP_SESSION.id}`) {
      return respond(route, 200, SETUP_SESSION);
    }
    if (
      path === `/api/agent-credential-setup-sessions/${SETUP_SESSION.id}/verification-code` &&
      method === 'POST'
    ) {
      const body = request.postDataJSON() as { code?: string };
      seenSubmittedCodes.push(body.code ?? '');
      return respond(route, 200, submissionResponse);
    }
    if (path === `/api/agent-credential-setup-sessions/${SETUP_SESSION.id}/cancel`) {
      return respond(route, 200, { id: SETUP_SESSION.id, status: 'cancelled' });
    }

    if (path.startsWith('/api/notifications')) {
      return respond(route, 200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') return respond(route, 200, { projects: [] });
    if (path.startsWith('/api/github')) return respond(route, 200, []);
    if (path.endsWith('/health')) return respond(route, 200, { status: 'ok' });

    return respond(route, 200, {});
  });

  await page.context().route('https://claude.ai/**', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Claude sign-in</title><h1>Claude sign-in</h1>',
    })
  );
}

async function navigateToAgentSettings(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
  await page.goto('/settings/agents');
  await expect(page.getByTestId('agent-card-claude-code')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    overflow.docOverflow,
    `Document scrollWidth (${overflow.docWidth}) exceeds viewport (${overflow.viewportWidth})`
  ).toBe(false);
  expect(
    overflow.bodyOverflow,
    `Body scrollWidth (${overflow.bodyWidth}) exceeds viewport (${overflow.viewportWidth})`
  ).toBe(false);
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `${viewport.width}x${viewport.height}` : 'unknown-viewport';
  const dir = '../../.codex/tmp/playwright-screenshots';
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}-${suffix}.png`, fullPage: true });
}

test('Claude guided connect uses native URL/copy controls without terminal output', async ({
  page,
}) => {
  const seenSetupAgentTypes: string[] = [];
  const seenSubmittedCodes: string[] = [];
  await setupApiMocks(page, seenSetupAgentTypes, seenSubmittedCodes);
  await navigateToAgentSettings(page);

  await page.getByRole('button', { name: 'OAuth Token (Pro/Max)' }).click();
  const connect = page.getByRole('button', { name: 'Connect with Claude Code' });
  await expect(connect).toBeVisible();
  await connect.click();

  expect(seenSetupAgentTypes).toEqual(['claude-code']);

  const open = page.getByRole('link', { name: 'Open Claude sign-in' });
  const copy = page.getByRole('button', { name: 'Copy code' });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', CLAUDE_VERIFICATION_URL);
  await expect(copy).toBeVisible();
  await expect(page.locator('code')).toHaveText(CLAUDE_USER_CODE);
  await expect(page.getByLabel('Paste the code Claude shows you')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue sign-in' })).toBeDisabled();
  await expect(page.getByTestId('codex-terminal')).toHaveCount(0);
  const modal = page.getByRole('dialog', { name: 'Connect with Claude Code' });
  await expect(modal.locator('pre, textarea, [data-testid*="terminal"]')).toHaveCount(0);

  await assertNoOverflow(page);

  const [signInPage] = await Promise.all([page.context().waitForEvent('page'), open.click()]);
  await signInPage.waitForLoadState('domcontentloaded');
  expect(new URL(signInPage.url()).hostname).toBe('claude.ai');
  await signInPage.close();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copy.click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CLAUDE_USER_CODE);

  await screenshot(page, 'claude-guided-connect-modal');
  await assertNoOverflow(page);

  await page.getByLabel('Paste the code Claude shows you').fill(CLAUDE_SUBMITTED_CODE);
  await page.getByRole('button', { name: 'Continue sign-in' }).click();
  expect(seenSubmittedCodes).toEqual([CLAUDE_SUBMITTED_CODE]);
  await expect(page.getByText('Claude Code connected')).toBeVisible();
});

test('Claude guided connect submits by keyboard and surfaces exchange failure', async ({
  page,
}) => {
  const seenSetupAgentTypes: string[] = [];
  const seenSubmittedCodes: string[] = [];
  await setupApiMocks(page, seenSetupAgentTypes, seenSubmittedCodes, {
    ...SETUP_SESSION,
    status: 'failed',
    errorCode: 'code_incomplete',
    errorMessage:
      'The pasted code was incomplete. Copy the entire code Claude shows — it has a # in the middle — then start again.',
  });
  await navigateToAgentSettings(page);

  await page.getByRole('button', { name: 'OAuth Token (Pro/Max)' }).click();
  await page.getByRole('button', { name: 'Connect with Claude Code' }).click();
  const input = page.getByLabel('Paste the code Claude shows you');
  await input.fill(CLAUDE_SUBMITTED_CODE);
  await input.press('Enter');

  expect(seenSubmittedCodes).toEqual([CLAUDE_SUBMITTED_CODE]);
  await expect(page.getByRole('alert')).toContainText(/pasted code was incomplete/i);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await assertNoOverflow(page);
});
