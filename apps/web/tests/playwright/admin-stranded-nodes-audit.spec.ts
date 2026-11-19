import { expect, type Page, test } from '@playwright/test';
import type { AdminStrandedNode } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
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
    operatorRemovable: true,
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
    cloudProvider: 'gcp',
    providerInstanceId: '5572383107926504222',
    cleanupBlockedReason: 'teardown_deletion_unconfirmed, backoff',
    operatorRemovable: false,
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
    /** Fail every list request after the first. */
    failRefetch?: boolean;
  } = {}
) {
  let listCalls = 0;
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
      listCalls++;
      if (options.failRefetch && listCalls > 1) {
        return respond(500, { error: 'INTERNAL_ERROR', message: 'boom' });
      }
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
    // A refusal that means the server may be live gets an explanation, not the action.
    await expect(page.getByRole('button', { name: /^Remove stuck node / })).toHaveCount(2);
    await expect(page.getByText(/The server may still exist\. Check Google Cloud/)).toBeVisible();
    await page.getByText('Last error').first().click();
    await expect(page.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
    const viewport = page.viewportSize();
    for (const name of [`Remove stuck node ${INCIDENT_ID}`, 'Refresh stuck nodes']) {
      const box = await page.getByRole('button', { name }).boundingBox();
      if ((viewport?.width ?? 1280) < 640) expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width, name).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
    }
    await screenshot(page, 'admin-stranded-nodes-normal');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('typed confirmation and note gate the removal, which posts and refreshes', async ({ page }) => {
    const { removals } = await setupMocks(page);
    await openInfrastructure(page);
    await page.getByRole('button', { name: `Remove stuck node ${INCIDENT_ID}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove a stuck node' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTitle(/name: node-01m7mtmv89f5zv23vsf0zvpjps/)).toBeVisible();
    const submit = dialog.getByRole('button', { name: 'Remove node' });
    const idField = dialog.getByLabel(/Type the node ID/);
    const noteField = dialog.getByLabel(/What did you check/);
    await expect(submit).toBeDisabled();
    // Each gate on its own: a wrong ID, a lowercase ID, and a blank note all keep it disabled.
    await noteField.fill('Searched the Hetzner console by name and label.');
    await idField.fill('01M7MTMV89F5ZV23VSF0ZVPJPX');
    await expect(submit).toBeDisabled();
    await expect(dialog.getByText('Does not match yet.')).toBeVisible();
    await idField.fill(INCIDENT_ID.toLowerCase());
    await expect(submit).toBeDisabled();
    await idField.fill(INCIDENT_ID);
    await noteField.fill('   ');
    await expect(submit).toBeDisabled();
    await noteField.fill('Searched the Hetzner console by name and label.');
    await expect(dialog.getByText('Matches.')).toBeVisible();
    await expect(submit).toBeEnabled();
    // The action row stays on screen inside the dialog, even at 375px.
    const submitBox = await submit.boundingBox();
    expect(submitBox!.y + submitBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await screenshot(page, 'admin-stranded-nodes-dialog');
    await assertNoOverflow(page);

    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(removals).toEqual([
      {
        id: INCIDENT_ID,
        body: { confirmation: INCIDENT_ID, note: 'Searched the Hetzner console by name and label.' },
      },
    ]);
    await expect(page.getByText(INCIDENT_ID, { exact: true })).toHaveCount(0);
    await expect(page.getByText('01M7A0000000000000000000B2')).toBeVisible();
  });

  test('Escape closes the dialog without posting', async ({ page }) => {
    const { removals } = await setupMocks(page);
    await openInfrastructure(page);
    await page.getByRole('button', { name: `Remove stuck node ${INCIDENT_ID}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove a stuck node' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(removals).toEqual([]);
    await expect(page.getByText(INCIDENT_ID, { exact: true })).toBeVisible();
  });

  test('keeps the list and says so when a refresh fails', async ({ page }) => {
    await setupMocks(page, { failRefetch: true });
    await openInfrastructure(page);
    await page.getByRole('button', { name: 'Refresh stuck nodes' }).click();
    await expect(page.getByText('Could not refresh. Showing the last list.')).toBeVisible();
    await expect(page.getByText(INCIDENT_ID, { exact: true })).toBeVisible();
    await assertNoOverflow(page);
  });

  test('shows the server-side refusal inside the dialog', async ({ page }) => {
    await setupMocks(page, { removeStatus: 409 });
    await openInfrastructure(page);
    await page.getByRole('button', { name: `Remove stuck node ${INCIDENT_ID}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove a stuck node' });
    await dialog.getByLabel(/Type the node ID/).fill(INCIDENT_ID);
    await dialog.getByLabel(/What did you check/).fill('checked');
    await dialog.getByRole('button', { name: 'Remove node' }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('still has server 777001');
    // The refusal is on screen, not below the fold.
    const alertBox = await alert.boundingBox();
    expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await screenshot(page, 'admin-stranded-nodes-refused');
    await assertNoOverflow(page);
  });

  test('many stuck nodes, capped with a total', async ({ page }) => {
    await setupMocks(page, { nodes: MANY, total: 64 });
    await openInfrastructure(page);
    await expect(page.getByText('Showing the 30 oldest of 64 stuck nodes.')).toBeVisible();
    await screenshot(page, 'admin-stranded-nodes-many');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { nodes: [] });
    await openInfrastructure(page);
    await expect(page.getByText(/No stuck nodes\./)).toBeVisible();
    await screenshot(page, 'admin-stranded-nodes-empty');
    await assertNoOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupMocks(page, { status: 500 });
    await openInfrastructure(page);
    await expect(page.getByText('Could not load stuck nodes.')).toBeVisible();
    await screenshot(page, 'admin-stranded-nodes-error');
    await assertNoOverflow(page);
  });
});
