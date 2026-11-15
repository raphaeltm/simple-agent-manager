import { expect, test, type WebSocketRoute } from '@playwright/test';

import { assertNoOverflow, setupProjectChatMocks } from './audit-helpers';
import { captureFullConversation } from './conversation-range';

test('OFF and ON streaming preserve ordered messages, cards, links and code over paged virtualized history', async ({
  context,
}) => {
  test.setTimeout(120000);
  const results = [];
  const modes = process.env.CHAT_HISTORY_AUDIT_BASELINE === 'main' ? [false] : [false, true];
  for (const enabled of modes) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const projectId = `history-audit-project-${enabled ? 'on' : 'off'}`;
    const sessionId = `history-audit-session-${enabled ? 'on' : 'off'}`;
    const replies = Array.from(
      { length: 20 },
      (_, turn) =>
        Array.from({ length: 5 }, (_, line) => {
          const number = turn * 5 + line;
          return (
            `${number + 1}. Ocean tides rise and fall while 日本語 and 🙂 remain readable across streamed boundaries.\n` +
            (number === 49
              ? '\n```typescript\nconst tide = 1;\nconst shore = "sea";\nconsole.log(tide, shore);\n```\n\n'
              : '')
          );
        }).join('') +
        `\n\n[Forecast ${turn}](https://example.com/tides/${turn}?phase=high)\n\n` +
        (turn === 19 ? 'STREAM_HISTORY_COMPLETE' : '')
    );
    const chunks = replies.map((reply) => reply.match(/.{1,12}/gs)!);
    const sentChunks = chunks.reduce((total, parts) => total + parts.length, 0);
    expect(sentChunks).toBeGreaterThan(500);
    const session = {
      id: sessionId,
      workspaceId: null,
      taskId: null,
      topic: 'Streamed history audit',
      status: 'active',
      messageCount: sentChunks + 42,
      startedAt: 100,
      lastMessageAt: 200,
      createdAt: 100,
      updatedAt: 200,
      endedAt: null,
      cleanupAt: null,
      isIdle: false,
      agentCompletedAt: null as number | null,
      agentSessionId: null,
      viewerAccess: 'owner',
      agentType: 'openai-codex',
    };
    type Message = {
      id: string;
      sessionId: string;
      role: string;
      content: string;
      toolMetadata: Record<string, unknown> | null;
      createdAt: number;
      sequence: number;
    };
    const stored: Message[] = [];
    const expected = { itemIds: [] as string[], anchorIds: [] as string[] };
    let sequence = 0;
    const row = (
      id: string,
      role: string,
      content: string,
      toolMetadata: Record<string, unknown> | null = null
    ): Message => ({
      id,
      sessionId,
      role,
      content,
      toolMetadata,
      createdAt: 200,
      sequence: ++sequence,
    });
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
      if (new URL(ws.url()).searchParams.get('sessionId') === sessionId) socket = ws;
      ws.onMessage((raw) => {
        if (JSON.parse(String(raw)).type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
    // One initial prompt makes the active conversation available before streaming.
    const initial = row('history-user-0', 'user', 'Describe the tide forecast for turn 0.');
    stored.push(initial);
    await setupProjectChatMocks(page, {
      projectId,
      project: {
        id: projectId,
        name: 'History audit',
        repository: 'example/audit',
        repoProvider: 'github',
      },
      session,
      messages: stored,
    });
    await page.route(
      new RegExp(
        `/api/projects/${projectId}/sessions/${sessionId}/attention/history-question(?:\\?.*)?$`
      ),
      (route) =>
        route.fulfill({
          status: 200,
          json: {
            request: {
              id: 'history-question',
              reason: 'Which tide forecast should be saved?',
              options: [],
              category: 'input',
              createdAt: 200,
              resolvedAt: 201,
              resolvedAnswer: 'Save the high tide forecast.',
              expired: false,
              canAnswer: false,
            },
            session: { id: sessionId, topic: session.topic },
            messages: [],
          },
        })
    );
    let historyReads = 0;
    await page.route(
      new RegExp(`/api/projects/${projectId}/sessions/${sessionId}(?:/messages)?(?:\\?.*)?$`),
      (route) => {
        const url = new URL(route.request().url());
        const before = url.searchParams.get('before');
        const after = url.searchParams.get('after');
        if (before) historyReads++;
        const key = (raw: string) => Number(JSON.parse(raw)[1]);
        const available = stored.filter(
          (message) =>
            (!before || message.sequence < key(before)) && (!after || message.sequence > key(after))
        );
        const messages = after ? available.slice(0, 100) : available.slice(-100);
        return route.fulfill({
          status: 200,
          json: { session, messages, hasMore: available.length > messages.length },
        });
      }
    );
    await page.goto(`/projects/${projectId}/chat/${sessionId}`);
    await expect.poll(() => socket !== undefined).toBe(true);
    const send = (message: Message) => {
      stored.push(message);
      socket!.send(
        JSON.stringify({ type: 'messages.batch', payload: { sessionId, messages: [message] } })
      );
    };
    for (let turn = 0; turn < chunks.length; turn++) {
      const userId = `history-user-${turn}`;
      if (turn > 0) send(row(userId, 'user', `Describe the tide forecast for turn ${turn}.`));
      expected.itemIds.push(userId);
      expected.anchorIds.push(userId);
      const canonicalId = `history-reply-${turn}`;
      expected.itemIds.push(canonicalId);
      expected.anchorIds.push(canonicalId);
      let canonical: Message | undefined;
      let offset = 0;
      for (let index = 0; index < chunks[turn]!.length; index++) {
        const chunk = row(
          index === 0 ? canonicalId : `history-chunk-${turn}-${index}`,
          'assistant',
          chunks[turn]![index]!
        );
        if (!enabled || index === 0) {
          send(chunk);
          if (index === 0) canonical = chunk;
        } else {
          canonical!.content += chunk.content;
          socket!.send(
            JSON.stringify({
              type: 'message.append',
              payload: {
                id: canonicalId,
                sessionId,
                content: chunk.content,
                offset,
                revision: offset + chunk.content.length,
              },
            })
          );
        }
        offset += chunk.content.length;
      }
      const toolId = `history-tool-${turn}`;
      send(
        row(toolId, 'tool', 'Forecast checked.', {
          toolCallId: `forecast-${turn}`,
          title: `Check forecast ${turn}`,
          kind: 'read',
          status: 'completed',
        })
      );
      expected.itemIds.push(toolId);
      await page.waitForTimeout(20);
    }
    const planId = 'history-plan';
    send(
      row(
        planId,
        'plan',
        JSON.stringify([
          { content: 'Save the completed tide forecast.', priority: 'medium', status: 'completed' },
        ])
      )
    );
    expected.itemIds.push(planId);
    const cardId = 'history-input-card';
    send(
      row(cardId, 'tool', '(tool update)', {
        toolCallId: 'history-input-call',
        toolName: 'request_human_input',
        title: 'request_human_input',
        status: 'completed',
        rawOutput: [
          {
            type: 'text',
            text: JSON.stringify({ humanInputRequest: { id: 'history-question', sessionId } }),
          },
        ],
      })
    );
    expected.itemIds.push(cardId);
    // End the synthetic turn before auditing: live followOutput and pending
    // virtual measurements must not compete with our history traversal.
    session.agentCompletedAt = 201;
    session.isIdle = true;
    socket!.send(
      JSON.stringify({
        type: 'session.agent_completed',
        payload: { sessionId, agentCompletedAt: 201 },
      })
    );
    socket!.send(
      JSON.stringify({ type: 'session.activity', payload: { sessionId, activity: 'idle' } })
    );
    const settleTail = async () => {
      const scroller = page.locator('[data-sam-conversation-scroller="true"]');
      await expect
        .poll(async () => {
          const invoked = await page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Scroll to bottom"]'
            );
            button?.click();
            return Boolean(button);
          });
          if (!invoked) {
            await scroller.evaluate((element) =>
              element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
            );
          }
          await page.waitForTimeout(100);
          const card = page.getByTestId('human-input-card');
          return (
            (await card.count()) === 1 &&
            (await card.innerText()).includes('Answered: Save the high tide forecast.')
          );
        })
        .toBe(true);
    };
    await settleTail();
    const live = await captureFullConversation(page, expected);
    expect(live.itemIds).toHaveLength(62);
    expect(live.renderedChars).toBeGreaterThan(8000);
    expect(live.codeBlocks).toBeGreaterThan(0);
    expect(live.typedCards).toBeGreaterThan(0);
    await assertNoOverflow(page);
    await page.reload();
    await settleTail();
    const reloaded = await captureFullConversation(page, expected);
    expect(reloaded).toEqual(live);
    if (!enabled) expect(historyReads).toBeGreaterThan(0);
    console.log(
      JSON.stringify({
        mode: enabled ? 'ON' : 'OFF',
        sentChunks,
        storedRows: stored.length,
        historyReads,
        renderedHash: live.renderedHash,
        renderedItems: live.itemIds.length,
        anchors: live.anchorIds.length,
        inventoryVerified: live.inventoryVerified,
        stableSweeps: live.stableSweeps,
        renderedChars: live.renderedChars,
        unicodeScalarCount: live.unicodeScalarCount,
        unpairedSurrogates: live.unpairedSurrogates,
        replacementChars: live.replacementChars,
        codeBlocks: live.codeBlocks,
        typedCards: live.typedCards,
      })
    );
    results.push(live);
    await page.close();
  }
  if (modes.length === 2) expect(results[1]).toEqual(results[0]);
});
