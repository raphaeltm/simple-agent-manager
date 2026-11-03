import type { OperationsActionApproval } from '@simple-agent-manager/shared';
import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-approvals',
  userId: 'user-admin-approvals',
});

const LONG_REASON =
  'Node 01M6GW2S351QXF780VNGNCY4ZP has had zero active workspaces for 3h 12m, well past the 30 minute warm timeout plus grace. ' +
  'ops_why_is_node_alive shows the cleanup sweep skipped it 38 times with cleanup_backoff_until set after a Hetzner 412 placement error <script>alert(1)</script> 🚨 — ' +
  'see https://app.example.com/admin/infrastructure/nodes/01M6GW2S351QXF780VNGNCY4ZP/very/long/path/that/must/wrap-properly-on-mobile';

function approval(overrides: Partial<OperationsActionApproval>): OperationsActionApproval {
  return {
    id: '01M6H0000000000000000000A1',
    action: 'delete_node',
    targetType: 'node',
    targetId: '01M6GW2S351QXF780VNGNCY4ZP',
    reason: 'Empty node past its warm timeout',
    evidenceSummary: 'ops_why_is_node_alive: kept_active, 0 workspaces; 38 skipped sweeps',
    targetSummary: {
      nodeId: '01M6GW2S351QXF780VNGNCY4ZP',
      ownerUserId: '4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx',
      status: 'running',
      healthStatus: 'healthy',
      nodeRole: 'workspace',
      runtime: 'vm',
      lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    },
    requestingProjectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
    requestingTaskId: '01M6GW2GNDQWT8T9CZPHGT7EFZ',
    requestingSessionId: '78756258-ecde-416e-b2c0-846c9603172c',
    requesterUserId: ADMIN_USER.user.id,
    status: 'pending',
    autoApproved: false,
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    executionResult: null,
    createdAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    ...overrides,
  };
}

const NORMAL: OperationsActionApproval[] = [
  approval({ reason: LONG_REASON }),
  approval({
    id: '01M6H0000000000000000000A2',
    action: 'sleep_session',
    targetType: 'chat_session',
    targetId: '1d438cc7-aaaa-bbbb-cccc-dddddddddddd',
    reason: 'x',
    evidenceSummary: null,
    targetSummary: { chatSessionId: '1d438cc7-aaaa-bbbb-cccc-dddddddddddd', workspaceId: null },
  }),
  approval({
    id: '01M6H0000000000000000000A3',
    action: 'retry_snapshot',
    targetType: 'chat_session',
    targetId: 'chat-9',
    status: 'executed',
    autoApproved: true,
    decidedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
    executedAt: new Date(Date.now() - 49 * 60_000).toISOString(),
    executionResult: {
      status: 'accepted',
      message: 'Background snapshot queued; its step trace appears in ops_get_session_story',
    },
  }),
  approval({
    id: '01M6H0000000000000000000A4',
    action: 'cancel_stuck_task',
    targetType: 'task',
    targetId: '01M6GN7PP650TXB7X9D7302085',
    status: 'denied',
    decidedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    decidedBy: ADMIN_USER.user.id,
  }),
  approval({
    id: '01M6H0000000000000000000A5',
    action: 'restart_vm_agent',
    status: 'expired',
  }),
];

const MANY: OperationsActionApproval[] = Array.from({ length: 30 }, (_, i) =>
  approval({
    id: `01M6H00000000000000000M${String(i).padStart(3, '0')}`,
    targetId: `NODE-${i}`,
    status: i < 12 ? 'pending' : 'executed',
    executedAt: i < 12 ? null : new Date(Date.now() - i * 60_000).toISOString(),
    executionResult: i < 12 ? null : { status: 'succeeded', message: 'Node deleted' },
  })
);

async function dismissOnboardingWizard(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, ADMIN_USER.user.id);
}

async function setupMocks(
  page: Page,
  options: { approvals?: OperationsActionApproval[]; status?: number; body?: unknown } = {}
) {
  let approvals = structuredClone(options.approvals ?? NORMAL);
  const decisions: Array<{ id: string; decision: string }> = [];
  await dismissOnboardingWizard(page);
  await setupAuditRoutes(page, (path, respond, route) => {
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
    if (path === '/api/admin/operations/approvals') {
      return respond(options.status ?? 200, options.body ?? { approvals });
    }
    const decide = path.match(/^\/api\/admin\/operations\/approvals\/([^/]+)\/decision$/);
    if (decide && route.request().method() === 'POST') {
      const id = decodeURIComponent(decide[1] ?? '');
      const { decision } = route.request().postDataJSON() as { decision: string };
      decisions.push({ id, decision });
      approvals = approvals.map((a) =>
        a.id === id
          ? {
              ...a,
              status: decision === 'approve' ? 'approved' : 'denied',
              decidedAt: new Date().toISOString(),
              decidedBy: ADMIN_USER.user.id,
            }
          : a
      );
      return respond(200, { approval: approvals.find((a) => a.id === id), delivered: true });
    }
    return undefined;
  });
  return { decisions };
}

async function openApprovals(page: Page, query = '') {
  await page.goto(`/admin/approvals${query}`);
  await page.waitForTimeout(700);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Approvals', selected: true })).toBeVisible();
}

test.describe('Admin → Approvals', () => {
  test('pending and settled approvals with long text and special characters', async ({ page }) => {
    await setupMocks(page);
    await openApprovals(page);
    await expect(page.getByText('Waiting for you (2)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(2);
    await expect(page.getByText('Recent decisions')).toBeVisible();
    // The script tag renders as text, never as markup.
    await expect(page.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
    await screenshot(page, 'admin-approvals-normal');
    await assertNoOverflow(page);

    // The Approve and Deny buttons are tappable side by side and stay inside the viewport.
    const approve = page.getByTestId('approval-01M6H0000000000000000000A1').getByRole('button', {
      name: 'Approve',
    });
    const deny = page.getByTestId('approval-01M6H0000000000000000000A1').getByRole('button', {
      name: 'Deny',
    });
    const [a, d] = [await approve.boundingBox(), await deny.boundingBox()];
    const viewport = page.viewportSize();
    expect(a!.height).toBeGreaterThanOrEqual(44);
    expect(a!.x + a!.width).toBeLessThanOrEqual(d!.x + 1);
    expect(d!.x + d!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
    await approve.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/admin-approvals-buttons-${viewport?.width}x${viewport?.height}.png`,
    });
  });

  test('tapping Approve posts the decision and moves it to recent decisions', async ({ page }) => {
    const { decisions } = await setupMocks(page);
    await openApprovals(page, '?approval=01M6H0000000000000000000A1');
    const item = page.getByTestId('approval-01M6H0000000000000000000A1');
    await expect(item).toHaveClass(/ring-2/);

    await item.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByText('Waiting for you (1)')).toBeVisible();
    expect(decisions).toEqual([{ id: '01M6H0000000000000000000A1', decision: 'approve' }]);
    await expect(
      page.getByTestId('approval-01M6H0000000000000000000A1').getByText('approved')
    ).toBeVisible();
    await screenshot(page, 'admin-approvals-after-approve');
    await assertNoOverflow(page);
  });

  test('many approvals', async ({ page }) => {
    await setupMocks(page, { approvals: MANY });
    await openApprovals(page);
    await expect(page.getByText('Waiting for you (12)')).toBeVisible();
    await screenshot(page, 'admin-approvals-many');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { approvals: [] });
    await openApprovals(page);
    await expect(page.getByText(/Nothing to approve/)).toBeVisible();
    await expect(page.getByText('Recent decisions')).toHaveCount(0);
    await screenshot(page, 'admin-approvals-empty');
    await assertNoOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupMocks(page, {
      status: 500,
      body: { error: 'INTERNAL', message: 'D1 unavailable' },
    });
    await openApprovals(page);
    await expect(page.getByText('D1 unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await screenshot(page, 'admin-approvals-error');
    await assertNoOverflow(page);
  });
});
