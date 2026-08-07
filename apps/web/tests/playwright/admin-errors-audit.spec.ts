import { type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-errors',
  userId: 'user-admin-errors',
});

function makeError(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: 'api',
    level: 'error',
    message: `Error in service handler for ${id}`,
    stack: 'Error: Something broke\n  at handler (api/routes/tasks.ts:42:3)\n  at dispatch (hono/router.ts:100:5)',
    context: { path: '/api/projects/proj-1/tasks', method: 'POST', projectId: 'proj-1' },
    userId: 'user-abc123',
    nodeId: 'node-xyz456',
    workspaceId: 'ws-def789',
    taskId: 'task-ghi012',
    sessionId: 'session-jkl345',
    ipAddress: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    timestamp: new Date(Date.now() - Math.random() * 86400000).toISOString(),
    ...overrides,
  };
}

const LONG_MSG = 'A'.repeat(300) + ' This is a very long error message that should wrap properly on mobile and desktop viewports without causing horizontal overflow.';
const SPECIAL_CHARS = 'Error: <script>alert("xss")</script> — unicode: 日本語 emoji: 🔥💥 & "quotes" \'single\' `backtick`';

const NORMAL_ERRORS = Array.from({ length: 5 }, (_, i) => makeError(`err-${i}`));
const LONG_TEXT_ERRORS = [
  makeError('err-long-msg', { message: LONG_MSG }),
  makeError('err-long-stack', {
    stack: Array.from({ length: 50 }, (_, i) => `  at function${i} (module${i}.ts:${i * 10}:${i})`).join('\n'),
  }),
  makeError('err-special', { message: SPECIAL_CHARS }),
];
const MANY_ERRORS = Array.from({ length: 50 }, (_, i) => makeError(`err-many-${i}`));

async function setupErrorMocks(
  page: Page,
  errors: unknown[],
  options: { diagnoses?: unknown[]; runs?: unknown[] } = {},
) {
  await setupAuditRoutes(page, (path, respond) => {
    if (path === '/api/auth/get-session') return respond(200, ADMIN_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path.startsWith('/api/admin/observability/errors')) {
      return respond(200, {
        errors,
        cursor: null,
        hasMore: errors.length > 20,
        total: errors.length,
      });
    }
    if (path.startsWith('/api/admin/observability/diagnoses')) {
      return respond(200, {
        diagnoses: options.diagnoses ?? [],
        runs: options.runs ?? [],
      });
    }
    return undefined;
  });
}

test.describe('Admin Errors — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('normal data — no overflow', async ({ page }) => {
    await setupErrorMocks(page, NORMAL_ERRORS);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-normal-mobile');
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupErrorMocks(page, LONG_TEXT_ERRORS);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-long-text-mobile');
  });

  test('empty state', async ({ page }) => {
    await setupErrorMocks(page, []);
    await page.goto('/admin/errors');
    await page.waitForTimeout(2000);
    await screenshot(page, 'admin-errors-empty-mobile');
    await assertNoOverflow(page);
  });

  test('many items', async ({ page }) => {
    await setupErrorMocks(page, MANY_ERRORS);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-many-mobile');
  });

  test('special characters render safely', async ({ page }) => {
    await setupErrorMocks(page, [makeError('err-special', { message: SPECIAL_CHARS })]);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-special-chars-mobile');
  });

  test('ID pills visible and properly wrapped', async ({ page }) => {
    await setupErrorMocks(page, [
      makeError('err-ids', {
        userId: 'user-01KY7M8N1RBC4ZV6ZKSNG878B3',
        nodeId: 'node-01KY7M8N1RBC4ZV6ZKSNG878B3',
        workspaceId: 'ws-01KY7M8N1RBC4ZV6ZKSNG878B3',
        taskId: 'task-01KY7M8N1RBC4ZV6ZKSNG878B3',
        sessionId: 'session-01KY7M8N1RBC4ZV6ZKSNG878B3',
      }),
    ]);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-id-pills-mobile');
  });

  test('filters with URL params', async ({ page }) => {
    await setupErrorMocks(page, NORMAL_ERRORS);
    await page.goto('/admin/errors?source=api&level=error&nodeId=n1');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-filters-mobile');
  });
});

test.describe('Admin Errors — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data — no overflow', async ({ page }) => {
    await setupErrorMocks(page, NORMAL_ERRORS);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-normal-desktop');
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupErrorMocks(page, LONG_TEXT_ERRORS);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-long-text-desktop');
  });

  test('many items', async ({ page }) => {
    await setupErrorMocks(page, MANY_ERRORS);
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-many-desktop');
  });

  test('expanded error details', async ({ page }) => {
    await setupErrorMocks(page, [
      makeError('err-details', {
        stack: 'Error: test\n  at handler (api.ts:42:3)',
        context: { path: '/api/test', method: 'POST', status: 500 },
      }),
    ]);
    await page.goto('/admin/errors');
    await page.waitForTimeout(2000);
    await screenshot(page, 'admin-errors-pre-expand-desktop');
    const expandBtn = page.getByLabel('Show error details');
    const visible = await expandBtn.isVisible().catch(() => false);
    if (visible) {
      await expandBtn.click();
      await page.waitForTimeout(500);
    }
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-expanded-desktop');
  });

  test('diagnosis runs visible', async ({ page }) => {
    await setupErrorMocks(page, NORMAL_ERRORS, {
      runs: [
        {
          id: 'run-1',
          status: 'completed',
          errorId: 'err-0',
          startTime: '2026-08-07T11:00:00Z',
          endTime: '2026-08-07T12:00:00Z',
          currentStep: 'done',
          heartbeatAt: null,
          deadlineAt: null,
          usage: { turns: 3, totalTokens: 500 },
          diagnosis: { diagnosis: 'Root cause found' },
        },
      ],
    });
    await page.goto('/admin/errors');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'admin-errors-with-diagnosis-desktop');
  });
});
