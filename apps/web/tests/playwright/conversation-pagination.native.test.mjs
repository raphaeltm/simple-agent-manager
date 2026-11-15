// Offline synthetic paginated transcript; no credentials or external API traffic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { setupProjectChatMocks } from './audit-routes.ts';
import { captureFullConversation } from './conversation-range.ts';

test(
  'native capture pages 1810 raw rows while automatic history loading removes its button',
  { timeout: 60000 },
  async () => {
    const latency = 500;
    const projectId = 'pagination-project',
      sessionId = 'pagination-session';
    let sequence = 0;
    const row = (id, role, content) => ({
      id,
      sessionId,
      role,
      content,
      createdAt: 200,
      sequence: ++sequence,
      toolMetadata: null,
    });
    const makeProse = (length) => {
      const sentence = 'The ocean tide follows the moon across this synthetic coastal inlet.\n\n';
      const code = '\n```typescript\nconst tide = "海🙂";\nconsole.log(tide);\n```\n';
      return (
        sentence
          .repeat(Math.ceil((length - code.length) / sentence.length))
          .slice(0, length - code.length) + code
      );
    };
    const off = makeProse(9442);
    const chunks = Array.from({ length: 1801 }, (_, i) =>
      off.slice(Math.floor((i * off.length) / 1801), Math.floor(((i + 1) * off.length) / 1801))
    );
    assert.equal(chunks.join(''), off);
    const messages = [
      row('boot-user', 'user', 'Synthetic startup.'),
      row('system', 'system', 'Synthetic system notice.'),
      row('startup-user', 'user', 'Synthetic first prompt.'),
      row('thinking-a', 'thinking', 'Synthetic thought.'),
      row('startup-answer', 'assistant', 'Synthetic startup reply.'),
      row('on-user', 'user', 'Synthetic ON prompt.'),
      row('thinking-b', 'thinking', 'Synthetic thought.'),
      row('on-answer', 'assistant', makeProse(9428)),
      row('off-user', 'user', 'Synthetic OFF prompt.'),
      ...chunks.map((content, i) => row(`off-${i}`, 'assistant', content)),
    ];
    assert.equal(messages.length, 1810);
    const expected = {
      itemIds: [
        'boot-user',
        'system',
        'startup-user',
        'thinking-a',
        'startup-answer',
        'on-user',
        'thinking-b',
        'on-answer',
        'off-user',
        'off-0',
      ],
      anchorIds: [
        'boot-user',
        'startup-user',
        'startup-answer',
        'on-user',
        'on-answer',
        'off-user',
        'off-0',
      ],
    };
    const project = {
      id: projectId,
      name: 'Offline pagination',
      repository: 'example/synthetic',
      repoProvider: 'github',
    };
    const session = {
      id: sessionId,
      workspaceId: null,
      taskId: null,
      topic: 'Synthetic paginated transcript',
      status: 'stopped',
      messageCount: messages.length,
      startedAt: 100,
      lastMessageAt: 200,
      createdAt: 100,
      updatedAt: 200,
      endedAt: 201,
      cleanupAt: null,
      isIdle: true,
      agentCompletedAt: 201,
      agentSessionId: null,
      viewerAccess: 'owner',
      agentType: 'openai-codex',
    };
    const browser = await chromium.launch();
    const result = { phases: [], requests: [] };
    try {
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort()
      );
      await page.addInitScript(() =>
        localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true')
      );
      await setupProjectChatMocks(page, { projectId, project, session, messages });
      await page.route(
        new RegExp(`/api/projects/${projectId}/sessions/${sessionId}(?:\\?.*)?$`),
        async (route) => {
          const query = new URL(route.request().url()).searchParams;
          const before = query.get('before');
          const limit = Number(query.get('limit') ?? 500);
          const seq = before ? JSON.parse(before)[1] : Infinity;
          const eligible = messages.filter((m) => m.sequence < seq),
            pageRows = eligible.slice(-limit);
          const request = {
            at: Date.now(),
            beforeSequence: Number.isFinite(seq) ? seq : null,
            rows: pageRows.length,
            hasMore: eligible.length > limit,
          };
          result.requests.push(request);
          await pause(latency);
          request.fulfilledAt = Date.now();
          return route.fulfill({
            status: 200,
            json: {
              session,
              messages: pageRows,
              hasMore: request.hasMore,
              state: { activity: 'idle', activityAt: 200, statusError: null },
            },
          });
        }
      );
      let first;
      for (const [name, width, reload] of [
        ['desktopLive', 1280, false],
        ['mobileLive', 375, false],
        ['desktopReload', 1280, true],
        ['mobileReload', 375, false],
      ]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        if (result.phases.length === 0)
          await page.goto(`/projects/${projectId}/chat/${sessionId}`, {
            waitUntil: 'domcontentloaded',
          });
        else if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(reload || result.phases.length === 0 ? 3000 : 500);
        const start = Date.now(),
          beforeRequests = result.requests.length;
        let phase;
        try {
          const capture = await captureFullConversation(page, expected);
          assert.equal(capture.inventoryVerified, true);
          assert.equal(capture.stableSweeps, 2);
          assert.equal(capture.codeBlocks, 2);
          assert.equal(capture.unpairedSurrogates, 0);
          assert.equal(capture.replacementChars, 0);
          if (first) assert.deepEqual(capture, first);
          first ??= capture;
          phase = {
            name,
            status: 'PASS',
            elapsedMs: Date.now() - start,
            inventory: capture.inventoryVerified,
            stableSweeps: capture.stableSweeps,
            renderedHash: capture.renderedHash,
          };
        } catch (error) {
          console.log(
            JSON.stringify({
              name,
              elapsedMs: Date.now() - start,
              diagnostic: error.captureDiagnostic ?? null,
            })
          );
          throw error;
        }
        phase.apiRequestsDuringCapture = result.requests.length - beforeRequests;
        result.phases.push(phase);
        console.log(
          JSON.stringify({ synthetic: true, latencyMs: latency, rawRows: 1810, ...phase })
        );
        if (name === 'desktopLive' || name === 'desktopReload')
          assert(phase.apiRequestsDuringCapture >= 3);
        assert(result.requests.some((r) => r.rows === 310 && !r.hasMore));
      }
    } finally {
      await browser.close();
    }
  }
);
