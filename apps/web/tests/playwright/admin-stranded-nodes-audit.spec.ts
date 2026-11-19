import { expect, type Page, test } from '@playwright/test';
import type { AdminStrandedNode } from '@simple-agent-manager/shared';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  screenshotSectionNearHeading,
  setupAuditRoutes,
} from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-stranded',
  userId: 'user-admin-stranded',
});

const INCIDENT_ID = '01M7MTMV89F5ZV23VSF0ZVPJPS';
const LONG_ERROR =
  'Stop failed during managed node teardown: teardown_credential_generation_changed: node=01M7MTMV89F5ZV23VSF0ZVPJPS provider=hetzner: ' +
  'the platform credential this node was placed with was re-saved or rotated <script>alert(1)</script> 🚨 ' +
  'see https://app.example.com/admin/infrastructure/nodes/01M7MTMV89F5ZV23VSF0ZVPJPS/a/very/long/unbroken/path/that/must/wrap-on-mobile-without-overflowing';

function strandedNode(overrides: Partial<AdminStrandedNode>): AdminStrandedNode {
  return {
    id: INCIDENT_ID,
    ownerUserId: 'staging2-agent-user',
    ownerEmail: 'agent-user@staging2.example.com',
    nodeRole: 'workspace',
    cloudProvider: 'hetzner',
    providerInstanceId: null,
    vmLocation: 'nbg1',
    createdAt: '2026-11-17T13:20:22.000Z',
    lastHeartbeatAt: null,
    cleanupBlockedSince: '2026-11-17T13:50:00.000Z',
    cleanupBlockedReason: 'teardown_credential_generation_changed',
    errorMessage: LONG_ERROR,
    ...overrides,
  };
}

const NORMAL: AdminStrandedNode[] = [
  strandedNode({}),
  strandedNode({
    id: '01M7A0000000000000000000B2',
    providerInstanceId: '150100869',
    nodeRole: 'deployment',
    cleanupBlockedReason: 'teardown_delete_refused',
    errorMessage: null,
    ownerEmail: null,
    lastHeartbeatAt: '2026-11-16T09:00:00.000Z',
  }),
  strandedNode({
    id: 'x',
    cleanupBlockedSince: null,
    cleanupBlockedReason: null,
    errorMessage: null,
    ownerEmail: `${'a'.repeat(120)}@example.com`,
  }),
];

const MANY: AdminStrandedNode[] = Array.from({ length: 30 }, (_, i) =>
  strandedNode({
    id: `01M7A00000000000000000M${String(i).padStart(3, '0')}`,
    cleanupBlockedReason:
      i % 2 ? 'teardown_allocation_unresolved' : 'teardown_credential_unavailable',
    errorMessage: i % 3 ? null : 'short error',
  })
);

async function setupMocks(
  page: Page,
  options: {
    nodes?: AdminStrandedNode[];
    total?: number;
    status?: number;
    removeStatus?: number;
  } = {}
) {
  let nodes = structuredClone(options.nodes ?? NORMAL);
  const removals: Array<{ id: string; body: unknown }> = [];
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, ADMIN_USER.user.id);
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
    if (path.startsWith('/api/admin/capacity-pools')) {
      return respond(503, { error: 'SERVICE_UNAVAILABLE', message: 'not part of this audit' });
    }
    if (path === '/api/admin/nodes/stranded') {
      return respond(
        options.status ?? 200,
        options.status && options.status >= 400
          ? { error: 'INTERNAL_ERROR', message: 'boom' }
          : { nodes, total: options.total ?? nodes.length }
      );
    }
    const remove = path.match(/^\/api\/admin\/nodes\/([^/]+)\/operator-deletion$/);
    if (remove && route.request().method() === 'POST') {
      const id = decodeURIComponent(remove[1] ?? '');
      removals.push({ id, body: route.request().postDataJSON() });
      if (options.removeStatus && options.removeStatus >= 400) {
        return respond(options.removeStatus, {
          error: 'CONFLICT',
          message:
            'hetzner still has server 777001 for this node. Delete it there first, then try again.',
        });
      }
      nodes = nodes.filter((node) => node.id !== id);
      return respond(200, { success: true });
    }
    return undefined;
  });
  return { removals };
}

async function openInfrastructure(page: Page) {
  await page.goto('/admin/infrastructure');
  await page.waitForTimeout(700);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Stuck nodes' })).toBeVisible();
}

test.describe('Admin → Infrastructure → Stuck nodes', () => {
  test('lists stuck nodes with long text and special characters', async ({ page }) => {
    await setupMocks(page);
    await openInfrastructure(page);
    await expect(page.getByText(INCIDENT_ID, { exact: true })).toBeVisible();
    await expect(page.getByText(/has been re-saved since/)).toBeVisible();
    await expect(page.getByText('No failed teardown recorded yet', { exact: false })).toBeVisible();
    // Only nodes SAM has failed to tear down get the action.
    await expect(page.getByRole('button', { name: 'Server is gone…' })).toHaveCount(2);
    await expect(page.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
    const button = page.getByRole('button', { name: 'Server is gone…' }).first();
    const box = await button.boundingBox();
    const viewport = page.viewportSize();
    if ((viewport?.width ?? 1280) < 640) expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
    await screenshotSectionNearHeading(page, 'Stuck nodes', 'admin-stranded-nodes-normal');
    await assertNoOverflow(page);
  });

  test('typed confirmation and note gate the removal, which posts and refreshes', async ({
    page,
  }) => {
    const { removals } = await setupMocks(page);
    await openInfrastructure(page);
    await page.getByRole('button', { name: 'Server is gone…' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Remove a stuck node' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/No server ID was ever recorded/)).toBeVisible();
    const submit = dialog.getByRole('button', { name: 'Remove node' });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel(/Type the node ID/).fill(INCIDENT_ID);
    await expect(submit).toBeDisabled();
    await dialog
      .getByLabel(/What did you check/)
      .fill('Searched the Hetzner console by name and label.');
    await expect(submit).toBeEnabled();
    await screenshot(page, 'admin-stranded-nodes-dialog');
    await assertNoOverflow(page);

    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(removals).toEqual([
      {
        id: INCIDENT_ID,
        body: {
          confirmation: INCIDENT_ID,
          note: 'Searched the Hetzner console by name and label.',
        },
      },
    ]);
    await expect(page.getByText(INCIDENT_ID, { exact: true })).toHaveCount(0);
    await expect(page.getByText('01M7A0000000000000000000B2')).toBeVisible();
  });

  test('shows the server-side refusal inside the dialog', async ({ page }) => {
    await setupMocks(page, { removeStatus: 409 });
    await openInfrastructure(page);
    await page.getByRole('button', { name: 'Server is gone…' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Remove a stuck node' });
    await dialog.getByLabel(/Type the node ID/).fill(INCIDENT_ID);
    await dialog.getByLabel(/What did you check/).fill('checked');
    await dialog.getByRole('button', { name: 'Remove node' }).click();
    await expect(dialog.getByRole('alert')).toContainText('still has server 777001');
    await screenshot(page, 'admin-stranded-nodes-refused');
    await assertNoOverflow(page);
  });

  test('many stuck nodes, capped with a total', async ({ page }) => {
    await setupMocks(page, { nodes: MANY, total: 64 });
    await openInfrastructure(page);
    await expect(page.getByText('Showing the 30 oldest of 64 stuck nodes.')).toBeVisible();
    await screenshotSectionNearHeading(page, 'Stuck nodes', 'admin-stranded-nodes-many');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { nodes: [] });
    await openInfrastructure(page);
    await expect(page.getByText('No stuck nodes.')).toBeVisible();
    await screenshotSectionNearHeading(page, 'Stuck nodes', 'admin-stranded-nodes-empty');
    await assertNoOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupMocks(page, { status: 500 });
    await openInfrastructure(page);
    await expect(page.getByText('Could not load stuck nodes.')).toBeVisible();
    await screenshotSectionNearHeading(page, 'Stuck nodes', 'admin-stranded-nodes-error');
    await assertNoOverflow(page);
  });
});
