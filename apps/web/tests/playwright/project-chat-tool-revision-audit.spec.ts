import { expect, test, type WebSocketRoute } from '@playwright/test';

import { assertNoOverflow, setupProjectChatMocks } from './audit-helpers';

const projectId = 'tool-revision-audit';
const sessionId = 'tool-revision-session';
const title = 'Run canonical tool ' + 'Unicode 日本語 <script> '.repeat(12);

test('expanded canonical tool replaces lazy output by revision and survives reload', async ({
  page,
}, info) => {
  let socket: WebSocketRoute | undefined;
  const message = {
    id: 'canonical-tool',
    sessionId,
    role: 'tool',
    content: 'old output',
    createdAt: 100,
    sequence: 1,
    toolMetadata: {
      toolCallId: 'call-a',
      _samToolCanonicalId: 'canonical-tool',
      _samToolRevision: 1,
      title,
      kind: 'execute',
      status: 'in_progress',
      contentSize: 100,
    },
  };
  let output = 'Old canonical output';
  let loads = 0;
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    if (new URL(ws.url()).searchParams.get('sessionId') === sessionId) socket = ws;
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });
  });
  await setupProjectChatMocks(page, {
    projectId,
    project: {
      id: projectId,
      name: 'Canonical tool audit',
      repository: 'example/tools',
      repoProvider: 'github',
    },
    session: {
      id: sessionId,
      workspaceId: null,
      taskId: null,
      topic: 'Canonical tool revision',
      status: 'active',
      messageCount: 1,
      createdAt: 100,
      updatedAt: 100,
      endedAt: null,
      cleanupAt: null,
      isIdle: false,
      agentCompletedAt: null,
      agentSessionId: null,
      viewerAccess: 'owner',
      agentType: 'openai-codex',
    },
    messages: [message],
  });
  await page.route(`**/sessions/${sessionId}/messages/canonical-tool/tool-content`, (route) => {
    loads++;
    return route.fulfill({ json: { content: [{ type: 'terminal', output }] } });
  });
  await page.goto(`/projects/${projectId}/chat/${sessionId}`);
  await expect.poll(() => socket !== undefined).toBe(true);
  expect(new URL(socket!.url()).searchParams.get('toolReplace')).toBe('tool-replace-v1');
  await page.getByRole('button', { name: /1 tool call/ }).click();
  await page.getByRole('button', { name: /^Run canonical tool/ }).click();
  await expect(page.getByText('Old canonical output', { exact: true })).toBeVisible();
  output = 'Updated canonical output 🙂\n' + 'https://example.com/long-unbroken-output/'.repeat(8);
  message.content = 'Updated canonical output';
  message.toolMetadata = { ...message.toolMetadata, _samToolRevision: 2, status: 'completed' };
  socket!.send(
    JSON.stringify({
      type: 'messages.batch',
      payload: { sessionId, messages: [message], count: 1 },
    })
  );
  await expect(page.getByText(/Updated canonical output 🙂/)).toBeVisible();
  await expect(page.getByText('Old canonical output', { exact: true })).toHaveCount(0);
  expect(loads).toBe(2);
  await assertNoOverflow(page);
  await page.waitForTimeout(500);
  const viewport = info.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `../../.tmp/playwright-screenshots/tool-revision-${viewport}.png`,
    fullPage: true,
  });
  await page.reload();
  await page.getByRole('button', { name: /1 tool call/ }).click();
  await page.getByRole('button', { name: /^Run canonical tool/ }).click();
  await expect(page.getByText(/Updated canonical output 🙂/)).toBeVisible();
  await assertNoOverflow(page);
});

test('many canonical tools keep lazy error and empty states usable', async ({ page }, info) => {
  const messages = Array.from({ length: 32 }, (_, index) => ({
    id: `tool-${index}`,
    sessionId,
    role: 'tool',
    content: '',
    createdAt: 100 + index,
    sequence: index + 1,
    toolMetadata: {
      toolCallId: `call-${index}`,
      _samToolCanonicalId: `tool-${index}`,
      _samToolRevision: 1,
      title: index === 0 ? 'Error output' : index === 1 ? 'X' : `Command ${index}`,
      kind: 'execute',
      status: 'completed',
      contentSize: 100,
    },
  }));
  await setupProjectChatMocks(page, {
    projectId,
    project: {
      id: projectId,
      name: 'Canonical tools',
      repository: 'example/tools',
      repoProvider: 'github',
    },
    session: {
      id: sessionId,
      workspaceId: null,
      taskId: null,
      topic: 'Canonical tool stress',
      status: 'stopped',
      messageCount: 32,
      createdAt: 100,
      updatedAt: 200,
      endedAt: 200,
      cleanupAt: null,
      isIdle: false,
      agentCompletedAt: null,
      agentSessionId: null,
      viewerAccess: 'owner',
      agentType: 'openai-codex',
    },
    messages,
  });
  await page.route('**/messages/tool-0/tool-content', (route) =>
    route.fulfill({ status: 500, json: { error: 'TEST_ERROR', message: 'Unavailable' } })
  );
  await page.route('**/messages/tool-1/tool-content', (route) =>
    route.fulfill({ json: { content: [] } })
  );
  await page.goto(`/projects/${projectId}/chat/${sessionId}`);
  await page.getByRole('button', { name: /32 tool calls/ }).click();
  await page.getByRole('button', { name: /^Error output/ }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Failed to load content.' })
  ).toBeVisible();
  await page.getByRole('button', { name: /^X execute/ }).click();
  await expect(page.getByText('No output.', { exact: true })).toBeVisible();
  await assertNoOverflow(page);
  await page.waitForTimeout(500);
  await page
    .getByRole('alert')
    .filter({ hasText: 'Failed to load content.' })
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `../../.tmp/playwright-screenshots/tool-stress-${info.project.name.startsWith('iPhone') ? 'mobile' : 'desktop'}.png`,
    fullPage: true,
  });
});
