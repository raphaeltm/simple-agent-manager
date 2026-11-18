import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-platform-config',
  userId: 'admin-platform-config',
});

type Source = 'runtime' | 'environment' | 'legacy-kv' | 'unset';
const LABELS: Record<Source, string> = {
  runtime: 'stored in SAM',
  environment: 'Worker environment fallback',
  'legacy-kv': 'legacy KV value',
  unset: 'not configured',
};
const LONG_ACTOR =
  'Operator With An Extraordinarily Long Display Name <operator.with.a.very.long.mailbox.name.for.testing@ops-team.long-subdomain.example.com>';

function field(source: Source, updatedByLabel: string | null = null) {
  const stored = source === 'runtime';
  return {
    configured: source !== 'unset',
    source,
    label: LABELS[source],
    updatedAt: stored ? '2026-11-12T04:07:00Z' : null,
    updatedBy: stored ? 'user-id' : null,
    updatedByLabel: stored ? updatedByLabel : null,
  };
}

function group(fields: Record<string, ReturnType<typeof field>>, label: string) {
  const values = Object.values(fields);
  const sources = values.map((item) => item.source);
  return {
    configured: values.every((item) => item.configured),
    source:
      (['runtime', 'environment', 'legacy-kv'] as const).find((s) => sources.includes(s)) ??
      'unset',
    label,
    clearable: sources.includes('runtime'),
    fields,
  };
}

const SETUP_ACTOR = 'first-run setup (unauthenticated)';

function platformStatus(gitlabCleared = false) {
  return {
    setupCompleted: true,
    setupForced: false,
    integrations: {
      githubOAuth: group(
        { clientId: field('runtime', LONG_ACTOR), clientSecret: field('environment') },
        'stored in SAM + Worker environment fallback'
      ),
      githubApp: group(
        {
          appId: field('environment'),
          appPrivateKey: field('environment'),
          appSlug: field('environment'),
        },
        'Worker environment fallback'
      ),
      githubWebhook: group({ webhookSecret: field('unset') }, 'not configured'),
      googleOAuth: group(
        {
          clientId: field('runtime', 'Admin User <admin@example.com>'),
          clientSecret: field('runtime', 'Admin User <admin@example.com>'),
        },
        'stored in SAM'
      ),
      googleInfrastructureOAuth: group(
        {
          clientId: field('runtime', 'Admin User <admin@example.com>'),
          clientSecret: field('runtime', 'Admin User <admin@example.com>'),
        },
        'stored in SAM'
      ),
      gitlabOAuth: gitlabCleared
        ? group(
            { host: field('unset'), clientId: field('unset'), clientSecret: field('unset') },
            'not configured'
          )
        : group(
            {
              host: field('runtime', SETUP_ACTOR),
              clientId: field('runtime', SETUP_ACTOR),
              clientSecret: field('runtime', SETUP_ACTOR),
            },
            'stored in SAM'
          ),
    },
    feedbackProject: {
      configured: true,
      source: 'environment',
      label: LABELS.environment,
      state: 'ready',
      projectId: 'feedback-project-1',
      project: { id: 'feedback-project-1', name: 'Platform Feedback', status: 'active' },
      message:
        'Report Issue, automated platform triage, incident trigger sweeps, and private incident MCP tools use this project for new feedback.',
      fields: { projectId: field('environment') },
    },
  };
}

const PLATFORM_STATUS = platformStatus();

async function respondJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupMocks(
  page: Page,
  authenticated = true,
  googleLogin = true,
  gitlabLogin = true
) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-admin-platform-config', 'true');
  });
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  let gitlabCleared = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/auth/get-session')
      return respondJson(route, 200, authenticated ? ADMIN_USER : null);
    if (path === '/api/config/login-providers') {
      return respondJson(route, 200, { github: true, google: googleLogin, gitlab: gitlabLogin });
    }
    if (path === '/api/dashboard/active-tasks') return respondJson(route, 200, { tasks: [] });
    if (path === '/api/trial-status') return respondJson(route, 200, { isTrial: false });
    if (path === '/api/credentials') return respondJson(route, 200, []);
    if (path === '/api/credentials/agent') return respondJson(route, 200, { credentials: [] });
    if (path === '/api/github/installations') return respondJson(route, 200, []);
    if (path === '/api/projects') {
      return respondJson(route, 200, {
        projects: [
          {
            id: 'feedback-project-1',
            name: 'Platform Feedback',
            repository: 'raphaeltm/simple-agent-manager',
            githubRepoId: 123,
            defaultBranch: 'main',
            repoProvider: 'github',
            status: 'active',
            activeWorkspaceCount: 0,
            activeSessionCount: 0,
            lastActivityAt: null,
            createdAt: '2026-08-21T00:00:00.000Z',
            taskCountsByStatus: {},
            linkedWorkspaces: 0,
          },
          {
            id: 'feedback-project-2',
            name: 'Long Private Feedback Project With Operators Watching Every Incident',
            repository: 'raphaeltm/simple-agent-manager',
            githubRepoId: 124,
            defaultBranch: 'main',
            repoProvider: 'github',
            status: 'active',
            activeWorkspaceCount: 0,
            activeSessionCount: 0,
            lastActivityAt: null,
            createdAt: '2026-08-21T00:00:00.000Z',
            taskCountsByStatus: {},
            linkedWorkspaces: 0,
          },
        ],
        nextCursor: new URL(request.url()).searchParams.has('cursor') ? null : 'next-project-page',
      });
    }
    if (path === '/api/notifications/unread-count') return respondJson(route, 200, { count: 0 });
    if (path === '/api/notifications') {
      return respondJson(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    }

    if (path === '/api/admin/connector/connections')
      return respondJson(route, 200, { connections: [], nextCursor: null });
    if (path === '/api/admin/connector/clients')
      return respondJson(route, 200, { clients: [], nextCursor: null });
    if (path === '/api/admin/connector/settings') return respondJson(route, 200, { settings: {} });
    if (path === '/api/admin/agent-email')
      return respondJson(route, 200, {
        enabled: true,
        domain: 'agents.example.com',
        loopback: { lastSent: null, lastReceived: null },
      });

    if (path === '/api/admin/platform-config') {
      if (request.method() === 'PUT') {
        const body = JSON.parse(request.postData() ?? '{}') as { config?: { clear?: string[] } };
        gitlabCleared ||= Boolean(body.config?.clear?.includes('gitlabOAuth'));
      }
      return respondJson(route, 200, {
        status: gitlabCleared ? platformStatus(true) : PLATFORM_STATUS,
      });
    }

    return respondJson(route, 200, {});
  });
}

test.describe('Platform config admin UI', () => {
  test('admin integrations page shows the shared config store', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/admin/integrations');
    await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
    await expect(page.getByTestId('platform-config-form')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save integrations' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Google infrastructure OAuth' })).toBeVisible();
    await expect(page.getByText(/\/auth\/google\/callback/)).toBeVisible();
    await expect(page.getByText(/\/api\/deployment\/gcp\/callback/)).toBeVisible();
    const gitlab = page.getByTestId('integration-gitlab-oauth');
    await expect(gitlab.getByTestId('platform-section-audit')).toContainText(
      'by first-run setup (unauthenticated)'
    );
    await expect(gitlab).not.toContainText('environment fallback');
    await expect(page.getByTestId('integration-github-oauth')).toContainText(
      'stored in SAM + Worker environment fallback'
    );
    await expect(page.getByRole('heading', { name: 'Operations project' })).toBeVisible();
    await expect(page.getByLabel('Operations project')).toHaveValue('feedback-project-1');
    await expect(page.getByTestId('feedback-project-status')).toContainText(
      'Report Issue, automated platform triage'
    );
    await expect(
      page.getByRole('button', { name: 'Clear stored Google infrastructure OAuth values' })
    ).toBeVisible();
    // Env-only and unset groups offer nothing to clear.
    await expect(page.getByRole('button', { name: 'Clear stored GitHub App values' })).toHaveCount(
      0
    );
    await expect(
      page.getByRole('button', { name: 'Clear stored GitHub Webhooks values' })
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load more projects' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-admin');
    await page.getByRole('heading', { name: 'Operations project' }).scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-admin-feedback');
  });

  test('clearing GitLab asks for confirmation, sends only the clear, and updates without reload', async ({
    page,
  }) => {
    await setupMocks(page);
    await page.goto('/admin/integrations');
    const gitlab = page.getByTestId('integration-gitlab-oauth');
    await gitlab.scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-gitlab-stored-by-setup');
    // Mark the document so a full reload would be detectable.
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

    await gitlab.getByRole('button', { name: 'Clear stored GitLab OAuth values' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear GitLab OAuth?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('its sign-in button disappears');
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-clear-confirm');

    const saveRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/admin/platform-config' &&
        request.method() === 'PUT'
    );
    await dialog.getByRole('button', { name: 'Clear stored values' }).click();
    const body = JSON.parse((await saveRequest).postData() ?? '{}') as { config?: unknown };
    expect(body.config).toEqual({ clear: ['gitlabOAuth'] });

    await expect(dialog).toHaveCount(0);
    await expect(gitlab).toContainText('not configured');
    await expect(gitlab.getByRole('button', { name: /^Clear stored/ })).toHaveCount(0);
    await expect(page.getByText('Stored integration values cleared.')).toBeVisible();
    await expect(page.locator('#integration-heading-gitlabOAuth')).toBeFocused();
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)
    ).toBe(true);
    await gitlab.scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-gitlab-cleared');
  });

  test('admin feedback project selector sends the selected project to the platform config API', async ({
    page,
  }) => {
    await setupMocks(page);
    await page.goto('/admin/integrations');
    await page.getByLabel('Operations project').selectOption('feedback-project-2');
    const saveRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/admin/platform-config' &&
        request.method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save integrations' }).click();

    const body = JSON.parse((await saveRequest).postData() ?? '{}') as {
      config?: { feedback?: { projectId?: string; remove?: boolean } };
    };
    expect(body.config?.feedback).toEqual({ projectId: 'feedback-project-2' });
    await assertNoOverflow(page);
  });

  test('login surfaces include Google sign-in', async ({ page }) => {
    await setupMocks(page, false);

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with GitLab' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-landing-login');

    await page.goto('/device?code=ABCD-1234');
    await expect(page.getByRole('button', { name: 'Log in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with GitLab' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-device-login');
  });

  test('login surfaces hide Google when the login client is not configured', async ({ page }) => {
    await setupMocks(page, false, false);

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in with GitLab' })).toBeVisible();

    await page.goto('/device?code=ABCD-1234');
    await expect(page.getByRole('button', { name: 'Log in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with Google' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Log in with GitLab' })).toBeVisible();
  });
});

test('admin feedback project list retries its first page without losing integration edits', async ({
  page,
}) => {
  await setupMocks(page);
  let unavailable = true;
  await page.route('**/api/projects?*', (route) =>
    unavailable
      ? respondJson(route, 503, {
          error: 'UNAVAILABLE',
          message: 'Projects temporarily unavailable',
        })
      : route.fallback()
  );
  await page.goto('/admin/integrations');
  await expect(page.getByTestId('platform-config-form')).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry project list' });
  await expect(retry).toBeVisible();
  await retry.scrollIntoViewIfNeeded();
  await assertNoOverflow(page);
  await screenshot(page, 'platform-config-project-list-retry');
  unavailable = false;
  await retry.click();
  await expect(page.getByRole('option', { name: /Long Private Feedback Project/ })).toBeAttached();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save integrations' })).toBeVisible();
});
