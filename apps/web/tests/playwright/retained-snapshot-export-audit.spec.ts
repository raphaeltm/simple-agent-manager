import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeIdleSessionState,
  makeMockProject,
  makeMockUser,
  screenshot,
  setupSleepingChatMocks,
} from './audit-helpers';

test.use({ serviceWorkers: 'block' });

const nativeFixture = process.env.SAM_RETAINED_EXPORT_NATIVE === '1';
const binary = Buffer.from([0, 255, 1, 128, 10, 0, 42]);
let actualDownloads = 0;
const artifactServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url?.endsWith('/retained-snapshot/wip'))
    actualDownloads++;
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="session-session-1-wip.bundle"',
    'Cache-Control': 'private, no-store',
    'Content-Length': binary.length,
    'Access-Control-Allow-Origin': 'http://localhost:4173',
    'Access-Control-Allow-Credentials': 'true',
  });
  response.end(binary);
});

test.beforeAll(async () => {
  if (!nativeFixture) return;
  await new Promise<void>((resolve) => artifactServer.listen(8787, '127.0.0.1', resolve));
  const address = artifactServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic attachment server unavailable');
});
test.afterAll(async () =>
  !nativeFixture
    ? undefined
    : new Promise<void>((resolve, reject) =>
        artifactServer.close((error) => (error ? reject(error) : resolve()))
      )
);

for (const isMine of [true, false]) {
  test(`stopped session retained export ${isMine ? 'owner' : 'other member'}`, async ({ page }) => {
    const user = makeMockUser({
      userId: 'user-test-1',
      sessionId: 'session-test-1',
      name: 'Synthetic Owner',
      email: 'owner@example.com',
      role: 'user',
    });
    const session = {
      id: 'session-1',
      projectId: 'proj-test-1',
      topic: 'Retained work — synthetic & private <example> '.repeat(5),
      status: 'stopped',
      workspaceId: null,
      nodeId: null,
      taskId: null,
      isMine,
      createdByUserId: isMine ? 'user-test-1' : 'other-user',
      startedAt: Date.parse('2026-01-15T10:00:00Z'),
      stoppedAt: Date.parse('2026-01-15T10:05:00Z'),
    };
    await page.addInitScript(() =>
      window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true')
    );
    await setupSleepingChatMocks(page, {
      user,
      project: makeMockProject(),
      session,
      messages: [],
      state: makeIdleSessionState(),
      ownTask: {},
    });
    let mutations = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
        mutations++;
    });
    await page.route('**/retained-snapshot/*', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': 'http://localhost:4173',
          'Access-Control-Allow-Credentials': 'true',
        },
        body: '{"error":"NOT_FOUND"}',
      })
    );
    await page.goto('/projects/proj-test-1/chat/session-1');
    if (!isMine) {
      await expect(page.getByText('No messages in this session.', { exact: true })).toBeVisible();
      await expect(page.getByTestId('retained-snapshot-export')).toHaveCount(0);
    } else {
      const summary = page.getByText('Download saved work', { exact: true });
      expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(56);
      await summary.click();
      await expect(
        page.getByRole('button', { name: 'Download manifest', exact: true })
      ).toBeVisible();
      const button = page.getByRole('button', { name: 'Download WIP bundle', exact: true });
      await expect(button).toBeVisible();
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(56);
      await button.click();
      await expect(page.getByRole('alert')).toContainText('Saved work could not be downloaded.');
      await expect(button).toBeEnabled();
      await assertNoOverflow(page);
      await screenshot(page, 'retained-export-owner-error');
      if (nativeFixture) {
        await page.unroute('**/retained-snapshot/*');
        // Use actual HTTP bytes: mocked Chromium attachment bodies can be cancelled. The audit
        // build points VITE_API_URL at this actual synthetic localhost API server.
        await page.route('**/retained-snapshot/*', (route) =>
          route.request().method() !== 'HEAD'
            ? route.continue()
            : route.fulfill({
                status: 200,
                headers: {
                  'Cache-Control': 'private, no-store',
                  'Content-Length': String(binary.length),
                  'Access-Control-Allow-Origin': 'http://localhost:4173',
                  'Access-Control-Allow-Credentials': 'true',
                },
                body: '',
              })
        );
        const downloadPromise = page.waitForEvent('download');
        await button.click();
        await expect(page.getByRole('alert')).toHaveCount(0);
        const download = await downloadPromise;
        expect(download.url()).toContain('/retained-snapshot/wip');
        expect(download.suggestedFilename()).toBe('session-session-1-wip.bundle');
        expect(await readFile((await download.path())!)).toEqual(binary);
        expect(actualDownloads).toBeGreaterThan(0);
        await expect(page.getByRole('alert')).toHaveCount(0);
      }
    }
    expect(mutations).toBe(0);
    await assertNoOverflow(page);
    await screenshot(
      page,
      `retained-export-${isMine ? (nativeFixture ? 'owner-success' : 'owner-unavailable') : 'other-member'}`
    );
  });
}

test('retained export with populated transcript and thirty session choices', async ({ page }) => {
  const session = {
    id: 'session-1',
    projectId: 'proj-test-1',
    topic: 'Saved changes',
    status: 'stopped',
    workspaceId: null,
    nodeId: null,
    taskId: null,
    isMine: true,
    createdByUserId: 'user-test-1',
    startedAt: Date.parse('2026-01-15T10:00:00Z'),
    stoppedAt: Date.parse('2026-01-15T10:05:00Z'),
  };
  const messages = Array.from({ length: 35 }, (_, index) => ({
    id: `synthetic-message-${index}`,
    sessionId: session.id,
    role: index % 2 ? 'assistant' : 'user',
    messageIndex: index,
    content:
      index === 34
        ? 'Synthetic transcript ends here.'
        : `Synthetic message ${index}: saved changes 🌱 <script>example</script> & text`,
    createdAt: '2026-01-15T10:01:00Z',
  }));
  await page.addInitScript(() =>
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true')
  );
  await setupSleepingChatMocks(page, {
    user: makeMockUser({
      userId: 'user-test-1',
      sessionId: 'session-test-1',
      name: 'Synthetic Owner',
      email: 'owner@example.com',
      role: 'user',
    }),
    project: makeMockProject(),
    session,
    messages,
    state: makeIdleSessionState(),
    ownTask: {},
  });
  await page.route('**/api/projects/proj-test-1/sessions', (route) =>
    route.fulfill({
      status: 200,
      json: {
        sessions: Array.from({ length: 35 }, (_, index) => ({
          ...session,
          id: index === 0 ? session.id : `synthetic-session-${index}`,
          topic:
            index === 0 ? session.topic : index === 1 ? 'A' : `Synthetic saved session ${index}`,
        })),
        total: 35,
      },
    })
  );
  await page.goto('/projects/proj-test-1/chat/session-1');
  await expect(page.getByText('Synthetic transcript ends here.', { exact: true })).toBeVisible();
  const summary = page.getByText('Download saved work', { exact: true });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Download manifest', exact: true })).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'retained-export-populated-many-sessions');
});
