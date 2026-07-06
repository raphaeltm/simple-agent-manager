import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-users',
  userId: 'admin-users',
});

const USERS = [
  {
    id: 'admin-users',
    email: 'admin@example.com',
    name: 'Admin User',
    avatarUrl: null,
    role: 'superadmin',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 'pending-long',
    email: 'pending.user.with.a.very.long.email.address+approval-flow@example-subdomain.example.com',
    name: 'Pending User With A Very Long Display Name That Must Wrap Cleanly',
    avatarUrl: null,
    role: 'user',
    status: 'pending',
    createdAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'active-admin',
    email: 'operator@example.com',
    name: 'Operator Admin',
    avatarUrl: null,
    role: 'admin',
    status: 'active',
    createdAt: '2026-07-03T00:00:00.000Z',
  },
];

async function respondJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupMocks(page: Page, initialRequireApproval: boolean) {
  let requireApproval = initialRequireApproval;
  const updateBodies: unknown[] = [];

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

    if (path === '/api/admin/users') {
      return respondJson(route, 200, { users: USERS });
    }

    if (path === '/api/admin/signup-approval' && request.method() === 'GET') {
      return respondJson(route, 200, {
        config: {
          requireApproval,
          source: 'runtime',
          updatedAt: '2026-07-06T12:00:00.000Z',
          updatedBy: 'admin-users',
        },
      });
    }

    if (path === '/api/admin/signup-approval' && request.method() === 'PUT') {
      const body = request.postDataJSON();
      updateBodies.push(body);
      requireApproval = body.requireApproval;
      return respondJson(route, 200, {
        config: {
          requireApproval,
          source: 'runtime',
          updatedAt: '2026-07-06T12:05:00.000Z',
          updatedBy: 'admin-users',
        },
      });
    }

    return respondJson(route, 200, {});
  });

  return { updateBodies };
}

test.describe('AdminUsers signup approval setting', () => {
  test('approval off state with long pending user data', async ({ page }) => {
    await setupMocks(page, false);

    await page.goto('/admin/users');
    await expect(page.getByText('Signup approval')).toBeVisible();
    await expect(page.getByText('Approval off')).toBeVisible();
    await expect(page.getByText('Pending User With A Very Long Display Name')).toBeVisible();
    await screenshot(page, 'admin-users-signup-approval-off');
    await assertNoOverflow(page);
  });

  test('toggle persists approval on', async ({ page }) => {
    const api = await setupMocks(page, false);

    await page.goto('/admin/users');
    await page.getByRole('switch', { name: 'Turn signup approval on' }).click();
    await expect(page.getByText('Approval on')).toBeVisible();
    expect(api.updateBodies).toEqual([{ requireApproval: true }]);
    await screenshot(page, 'admin-users-signup-approval-on');
    await assertNoOverflow(page);
  });
});
