// Start the local web app on 127.0.0.1:4173, then run with Node 24 native stripping:
// node --test apps/web/tests/playwright/conversation-range.native.test.mjs
// Do not use tsx: transformed callbacks can reference __name in the browser.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { captureFullConversation } from './conversation-range.ts';

// The shared fixture predates native TS imports. Resolve its sole extensionless
// dependency without transforming any code or browser callbacks.
const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier === './audit-routes' && context.parentURL.endsWith('/audit-helpers.ts')
        ? './audit-routes.ts'
        : specifier,
      context
    );
  },
});
const { setupProjectChatMocks } = await import('./audit-helpers.ts');
hook.deregister();

test(
  'native capture traverses tall real Markdown with all grouped, system and typed rows',
  { timeout: 90000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
      const page = await context.newPage();
      // This test may only reach its local app; every API request is synthetic.
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort()
      );
      // Diagnostic metadata must stay useful without serializing page/error text.
      await page.setContent('<p>Synthetic private page text</p>');
      page.setDefaultTimeout(50);
      await assert.rejects(captureFullConversation(page), (error) => {
        assert.deepEqual(error.captureDiagnostic, {
          stage: 'scroller',
          step: 0,
          sweeps: 0,
          captured: 0,
          expected: null,
        });
        return true;
      });
      page.setDefaultTimeout(30000);
      const projectId = 'native-range-project',
        sessionId = 'native-range-session';
      let sequence = 0;
      const row = (id, role, content, toolMetadata = null) => ({
        id,
        sessionId,
        role,
        content,
        toolMetadata,
        createdAt: 200,
        sequence: ++sequence,
      });
      const prose =
        '海🙂\n\n'.repeat(3600) +
        '\n```typescript\nconst tide = "日本語 🙂";\nconsole.log(tide);\n```\n\n[Forecast](https://example.com/tides)\n';
      const chunks = prose.match(/.{1,4}/gs);
      assert.equal(chunks.length, 4525);
      assert(prose.length >= 18000 && prose.length < 19000);
      const messages = [
        row('user', 'user', 'Describe synthetic tides.'),
        row('system', 'system', 'Synthetic system status.'),
        ...chunks.map((content, index) =>
          row(index ? `chunk-${index}` : 'assistant', 'assistant', content)
        ),
        ...Array.from({ length: 40 }, (_, index) =>
          row(`tool-${index}`, 'tool', 'Synthetic tool output.', {
            toolCallId: `call-${index}`,
            title: `Read synthetic module ${index}`,
            kind: 'read',
            status: 'completed',
          })
        ),
        row('assistant-tail', 'assistant', 'Synthetic final result.'),
        row('card', 'tool', 'Synthetic input card.', {
          toolCallId: 'question-call',
          toolName: 'request_human_input',
          title: 'request_human_input',
          status: 'completed',
          rawOutput: [
            {
              type: 'text',
              text: JSON.stringify({ humanInputRequest: { id: 'question', sessionId } }),
            },
          ],
        }),
      ];
      await setupProjectChatMocks(page, {
        projectId,
        project: {
          id: projectId,
          name: 'Native range audit',
          repository: 'example/audit',
          repoProvider: 'github',
        },
        session: {
          id: sessionId,
          workspaceId: null,
          taskId: null,
          topic: 'Synthetic sparse history',
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
        },
        messages,
      });
      await page.route(
        new RegExp(
          `/api/projects/${projectId}/sessions/${sessionId}/attention/question(?:\\?.*)?$`
        ),
        (route) =>
          route.fulfill({
            status: 200,
            json: {
              request: {
                id: 'question',
                reason: 'Synthetic tide choice?',
                options: [],
                category: 'input',
                createdAt: 200,
                resolvedAt: 201,
                resolvedAnswer: 'Synthetic answer.',
                expired: false,
                canAnswer: false,
              },
              session: { id: sessionId },
              messages: [],
            },
          })
      );
      const expected = {
        itemIds: ['user', 'system', 'assistant', 'tool-0', 'assistant-tail', 'card'],
        anchorIds: ['user', 'assistant', 'assistant-tail'],
      };
      const assertProse = async () => {
        const scroller = page.locator('[data-sam-conversation-scroller="true"]');
        await scroller.evaluate((element) => {
          element.scrollTop = 0;
        });
        const prose = page.locator('[data-conversation-item-id="assistant"] .prose');
        await prose.waitFor({ state: 'attached' });
        assert.deepEqual(await prose.locator('p').allTextContents(), [
          ...Array.from({ length: 3600 }, () => '海🙂'),
          'Forecast',
        ]);
        // The app renders syntax-highlighted div/span lines inside pre,
        // including separate line-number spans, rather than a code element.
        assert.deepEqual(
          await prose.locator('pre .token-line > span:last-child').allTextContents(),
          ['const tide = "日本語 🙂";', 'console.log(tide);']
        );
        assert.equal(
          await prose.getByRole('link', { name: 'Forecast', exact: true }).getAttribute('href'),
          'https://example.com/tides'
        );
      };
      let first;
      let loaded = false;
      for (const [width, reload] of [
        [375, false],
        [1280, false],
        [1280, true],
        [375, false],
      ]) {
        await page.setViewportSize({ width, height: 812 });
        if (!loaded) await page.goto(`/projects/${projectId}/chat/${sessionId}`);
        else if (reload) await page.reload();
        loaded = true;
        await page.getByTestId('human-input-card').waitFor();
        if (!first) {
          await assertProse();
          // A consistently truncated transcript must fail even if all four
          // capture hashes would otherwise agree. Restore through real reload.
          await page
            .locator('[data-conversation-item-id="assistant"] .prose p')
            .first()
            .evaluate((paragraph) => paragraph.remove());
          await assert.rejects(assertProse(), { code: 'ERR_ASSERTION' });
          await page.reload();
          await page.getByTestId('human-input-card').waitFor();
          await assertProse();
        }
        const started = Date.now();
        const capture = await captureFullConversation(page, expected);
        assert.equal(capture.inventoryVerified, true);
        assert(capture.renderedChars >= 14400);
        assert.equal(capture.stableSweeps, 2);
        assert.equal(capture.codeBlocks, 1);
        assert.equal(capture.typedCards, 1);
        assert.equal(capture.unpairedSurrogates, 0);
        assert.equal(capture.replacementChars, 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        );
        if (first) assert.deepEqual(capture, first);
        first ??= capture;
        console.log(
          JSON.stringify({
            synthetic: true,
            width,
            logicalChunks: chunks.length,
            durationMs: Date.now() - started,
          })
        );
      }
    } finally {
      await browser.close();
    }
  }
);
