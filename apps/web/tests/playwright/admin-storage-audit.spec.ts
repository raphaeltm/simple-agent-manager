import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-storage',
  userId: 'user-admin-storage',
});

const LONG_REASON =
  'attempts_exhausted:Error: Compact archive R2 deadline exceeded after 3 attempts on migration 67927ce6 ' +
  '(session 1d438cc7, 8,962 messages) — see project_data_archive_migrations for the poisoned row <script>alert(1)</script> 🚨';

const BREAKERS = {
  breakers: [
    {
      projectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
      projectName:
        'SAM — simple-agent-manager with an intentionally very long project name to stress wrapping',
      repository: 'raphaeltm/simple-agent-manager',
      state: 'open',
      reason: LONG_REASON,
      openedAt: Date.now() - 2 * 86_400_000,
      updatedAt: Date.now() - 3_600_000,
    },
    {
      projectId: 'project-frozen',
      projectName: 'Frozen project',
      repository: 'org/frozen',
      state: 'frozen',
      reason: 'operator freeze',
      openedAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 86_400_000,
    },
    {
      projectId: 'project-deleted',
      projectName: null,
      repository: null,
      state: 'open',
      reason: null,
      openedAt: null,
      updatedAt: Date.now() - 10 * 86_400_000,
    },
    {
      projectId: 'project-closed',
      projectName: 'Healthy project',
      repository: 'org/healthy',
      state: 'closed',
      reason: 'Closed from admin UI',
      openedAt: null,
      updatedAt: Date.now() - 5 * 86_400_000,
    },
  ],
  skippedRows: 0,
  limit: 25,
};

const TELEMETRY = {
  telemetry: [
    {
      project_id: '01KHRJGANBBWGDY1NZ0KVF0D4J',
      project_name:
        'SAM — simple-agent-manager with an intentionally very long project name to stress wrapping',
      repository: 'raphaeltm/simple-agent-manager',
      measured_at: Date.now() - 60_000,
      database_size_bytes: 10_097_864_704,
      limit_bytes: 10_000_000_000,
      usage_ratio: 1.0097864704,
      status: 'degraded',
      growth_rate_bytes_per_day: 30_925_756,
      estimated_days_to_limit: 0,
      cleanup_health: 'running',
      last_error: null,
      updated_at: Date.now() - 60_000,
    },
    {
      project_id: 'project-frozen',
      project_name: 'Frozen project',
      repository: 'org/frozen',
      measured_at: Date.now() - 600_000,
      database_size_bytes: 4_200_000_000,
      limit_bytes: 10_000_000_000,
      usage_ratio: 0.42,
      status: 'warning',
      growth_rate_bytes_per_day: 120_000_000,
      estimated_days_to_limit: 48,
      cleanup_health: 'not_needed',
      last_error: null,
      updated_at: Date.now() - 600_000,
    },
    {
      project_id: 'p',
      project_name: 'X',
      repository: 'o/r',
      measured_at: Date.now(),
      database_size_bytes: 1_024,
      limit_bytes: 10_000_000_000,
      usage_ratio: 0.0000001,
      status: 'ok',
      growth_rate_bytes_per_day: null,
      estimated_days_to_limit: null,
      cleanup_health: null,
      last_error: 'Compact archive R2 deadline exceeded',
      updated_at: Date.now(),
    },
  ],
};

/**
 * The first-run cloud onboarding wizard overlays every authenticated page when the
 * mocked user has no credentials. It would cover the surface under test (see
 * .claude/rules/62), so mark it dismissed before the app boots.
 */
async function dismissOnboardingWizard(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, ADMIN_USER.user.id);
}

async function respondJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(
  page: Page,
  options: {
    breakers?: unknown;
    telemetry?: unknown;
    breakerStatus?: number;
    telemetryStatus?: number;
  }
) {
  await dismissOnboardingWizard(page);
  await setupAuditRoutes(page, (path, respond) => {
    if (path === '/api/auth/get-session') return respond(200, ADMIN_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path === '/api/admin/project-data/storage/archive-sharding/circuit-breakers') {
      return respond(options.breakerStatus ?? 200, options.breakers ?? BREAKERS);
    }
    if (path === '/api/admin/project-data/storage') {
      return respond(options.telemetryStatus ?? 200, options.telemetry ?? TELEMETRY);
    }
    return undefined;
  });
}

async function openStoragePage(page: Page) {
  await page.goto('/admin/storage');
  await page.waitForTimeout(700);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Storage', selected: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Archive circuit breakers' })).toBeVisible();
}

test.describe('AdminStorage', () => {
  test('open, frozen, deleted-project and closed breakers with long text and special characters', async ({
    page,
  }) => {
    await setupMocks(page, {});
    await openStoragePage(page);
    // Only non-closed breakers expose the close control.
    await expect(page.getByRole('button', { name: /close breaker/i })).toHaveCount(3);
    await expect(page.getByText('Healthy project')).toBeVisible();
    await screenshot(page, 'admin-storage-breakers');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, {
      breakers: { breakers: [], skippedRows: 0, limit: 25 },
      telemetry: { telemetry: [] },
    });
    await openStoragePage(page);
    await expect(page.getByText('No archive circuit breakers recorded.')).toBeVisible();
    await expect(page.getByText('No storage telemetry recorded yet.')).toBeVisible();
    await screenshot(page, 'admin-storage-empty');
    await assertNoOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupMocks(page, {
      breakerStatus: 500,
      breakers: { error: 'INTERNAL', message: 'D1 unavailable' },
      telemetryStatus: 500,
      telemetry: { error: 'INTERNAL', message: 'D1 unavailable' },
    });
    await page.goto('/admin/storage');
    await page.waitForTimeout(700);
    await expect(page.getByRole('alert').first()).toContainText('D1 unavailable');
    await screenshot(page, 'admin-storage-error');
    await assertNoOverflow(page);
  });

  test('closing a breaker posts state=closed with the reason and refreshes the list', async ({
    page,
  }) => {
    let breakers = structuredClone(BREAKERS);
    const postBodies: Array<{ path: string; body: unknown }> = [];
    await dismissOnboardingWizard(page);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/auth/get-session') return respondJson(route, 200, ADMIN_USER);
      if (path === '/api/dashboard/active-tasks') return respondJson(route, 200, { tasks: [] });
      if (path === '/api/trial-status') return respondJson(route, 200, { isTrial: false });
      if (path === '/api/projects') return respondJson(route, 200, { projects: [], total: 0 });
      if (path === '/api/notifications/unread-count') return respondJson(route, 200, { count: 0 });
      if (path === '/api/notifications') {
        return respondJson(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
      }
      if (path.startsWith('/api/credentials')) return respondJson(route, 200, []);
      if (path === '/api/github/installations') return respondJson(route, 200, []);
      if (path === '/api/workspaces') return respondJson(route, 200, []);
      if (path.startsWith('/api/provider-catalog'))
        return respondJson(route, 200, { catalogs: [] });
      if (path === '/api/admin/project-data/storage') return respondJson(route, 200, TELEMETRY);
      if (path === '/api/admin/project-data/storage/archive-sharding/circuit-breakers') {
        return respondJson(route, 200, breakers);
      }
      const match = path.match(
        /^\/api\/admin\/project-data\/storage\/([^/]+)\/archive-sharding\/circuit-breaker$/
      );
      if (match && request.method() === 'POST') {
        const body = request.postDataJSON() as { state: string; reason: string };
        postBodies.push({ path, body });
        breakers = {
          ...breakers,
          breakers: breakers.breakers.map((b) =>
            b.projectId === decodeURIComponent(match[1])
              ? {
                  ...b,
                  state: body.state,
                  reason: body.reason,
                  openedAt: null,
                  updatedAt: Date.now(),
                }
              : b
          ),
        };
        return respondJson(route, 200, {
          result: {
            projectId: match[1],
            state: body.state,
            reason: body.reason,
            frozenMigrations: 0,
            frozenLocations: 0,
            updatedAt: Date.now(),
            note: 'Circuit breaker closed for future archive work.',
          },
        });
      }
      return respondJson(route, 200, {});
    });

    await openStoragePage(page);
    const samCard = page.getByTestId('breaker-01KHRJGANBBWGDY1NZ0KVF0D4J');
    await samCard.getByRole('button', { name: /close breaker/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await screenshot(page, 'admin-storage-close-dialog');
    await assertNoOverflow(page);

    await dialog.getByLabel('Reason').fill('Archive fix deployed; resume drain');
    await dialog.getByRole('button', { name: /^close breaker$/i }).click();

    await expect(dialog).toHaveCount(0);
    await expect(samCard.getByText('Closed', { exact: true })).toBeVisible();
    await expect(samCard.getByRole('button', { name: /close breaker/i })).toHaveCount(0);
    expect(postBodies).toEqual([
      {
        path: '/api/admin/project-data/storage/01KHRJGANBBWGDY1NZ0KVF0D4J/archive-sharding/circuit-breaker',
        body: { state: 'closed', reason: 'Archive fix deployed; resume drain' },
      },
    ]);
    await screenshot(page, 'admin-storage-after-close');
    await assertNoOverflow(page);
  });
});
