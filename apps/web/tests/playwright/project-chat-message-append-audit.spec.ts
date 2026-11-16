import { expect, test, type WebSocketRoute } from '@playwright/test';

import { assertNoOverflow, setupProjectChatMocks } from './audit-helpers';

const projectId = 'append-audit-project';
const sessionId = 'append-audit-session';
const first = 'A streamed reply 🙂';
const longUrl = 'https://example.com/a/very/long/path/'.repeat(6);
const suffix =
  '\n\nUnicode 日本語 and **bold text** stay visible. <script>literal</script> ' + longUrl;

test('canonical appends stream once, retain their anchor, and survive reload', async ({
  page,
}, info) => {
  let socket: WebSocketRoute | undefined;
  const message = {
    id: 'canonical-message',
    sessionId,
    role: 'assistant',
    content: first,
    toolMetadata: null,
    createdAt: 100,
    sequence: 1,
  };
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
      name: 'Stream audit',
      repository: 'example/audit',
      repoProvider: 'github',
    },
    session: {
      id: sessionId,
      workspaceId: null,
      taskId: null,
      topic: 'Canonical streaming',
      status: 'active',
      messageCount: 1,
      startedAt: Date.now() - 1000,
      lastMessageAt: Date.now(),
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
  await page.goto(`/projects/${projectId}/chat/${sessionId}`);
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  const anchor = page.locator('[data-comment-anchor]');
  const anchorId = await anchor.getAttribute('data-comment-anchor');
  expect(anchorId).toBeTruthy();
  await expect.poll(() => socket !== undefined).toBe(true);
  expect(new URL(socket!.url()).searchParams.get('messageAppend')).toBe('message-append-v1');
  const frame = JSON.stringify({
    type: 'message.append',
    payload: {
      id: message.id,
      sessionId,
      content: suffix,
      offset: first.length,
      revision: first.length + suffix.length,
    },
  });
  socket!.send(frame);
  socket!.send(frame);
  await expect(page.getByText('bold text', { exact: true })).toHaveCount(1);
  await expect(page.getByText('bold text', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: longUrl, exact: true })).toBeVisible();
  await expect(anchor).toHaveAttribute('data-comment-anchor', anchorId!);
  await assertNoOverflow(page);
  await page.waitForTimeout(500);
  const viewport = info.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `../../.tmp/playwright-screenshots/message-append-${viewport}.png`,
  });
  message.content += suffix;
  await page.reload();
  await expect(page.getByText('bold text', { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-comment-anchor]')).toHaveAttribute(
    'data-comment-anchor',
    anchorId!
  );
  await assertNoOverflow(page);
});
