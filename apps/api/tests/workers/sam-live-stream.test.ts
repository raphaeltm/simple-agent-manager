/**
 * Live SAM answers in workerd with the real Mastra agent: only model HTTP is stubbed,
 * and the stub streams in gated pieces so the test owns the midpoint of the answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SamRuntimeStub, startSamRuntime } from './support/sam-native-runtime';

const MODEL = '@cf/google/gemma-4-26b-a4b-it';
type Body = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }> };
const modelRequests: Array<{ body: Body; headers: Headers }> = [];
let reply: (body: Body, index: number) => Response = () => new Response('unset', { status: 500 });
let env: Awaited<ReturnType<typeof startSamRuntime>>;

beforeAll(async () => {
  env = await startSamRuntime(async (request) => {
    if (!request.url.startsWith('https://gateway.ai.cloudflare.com/'))
      throw new Error(`Unexpected external HTTP boundary: ${request.url}`);
    const body = (await request.json()) as Body;
    modelRequests.push({ body, headers: request.headers });
    return reply(body, modelRequests.length - 1);
  });
});
afterAll(async () => {
  await env?.close();
});
beforeEach(() => {
  modelRequests.length = 0;
});

const base = { id: 'completion', model: MODEL, created: 1, object: 'chat.completion.chunk' };
const content = (text: string) => ({
  ...base,
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});
const finish = (reason = 'stop', usage?: Record<string, number>) => ({
  ...base,
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...(usage ? { usage } : {}),
});
const usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** An SSE completion whose pieces are sent one by one; a promise holds the stream there. */
function gated(parts: Array<unknown | Promise<void>>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const part of parts) {
          if (part instanceof Promise) await part;
          else controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

type LiveEvent = { type: string; [key: string]: unknown };
function follow(response: Response) {
  const events: LiveEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const done = (async () => {
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames)
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as LiveEvent);
    }
  })();
  const text = () => {
    let value = '';
    for (const event of events) {
      if (event.type === 'snapshot') value = String(event.text);
      if (event.type === 'draft-reset') value = '';
      if (event.type === 'text') value = value.slice(0, Number(event.at)) + String(event.text);
    }
    return value;
  };
  return { events, text, done };
}

async function setup() {
  const userId = `sam-live-${crypto.randomUUID()}`;
  await env.DATABASE.prepare("INSERT INTO users(id,email,name,status) VALUES(?,?,?,'active')")
    .bind(userId, `${userId}@example.test`, 'SAM Live Test')
    .run();
  const stub = env.SAM_SESSION.get(env.SAM_SESSION.idFromName(userId)) as SamRuntimeStub;
  await stub.testEnvironment({ SAM_RATE_LIMIT_RPM: '30', SAM_MODEL: MODEL });
  const request = (path: string, method = 'GET', body?: unknown, asUser = userId) =>
    stub.fetch(`https://sam-session${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-sam-user-id': asUser },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await request('/settings', 'PATCH', { enabled: true })).status).toBe(200);
  const start = async (message: string) => {
    const response = await request('/turns', 'POST', { requestKey: crypto.randomUUID(), message });
    expect(response.status).toBe(202);
    return ((await response.json()) as { turn: { id: string } }).turn.id;
  };
  const turn = async (id: string) => {
    const page = (await (await request('/turns')).json()) as {
      conversationId: string;
      turns: Array<{ id: string; state: string; response: string | null; live?: unknown }>;
    };
    return { page, turn: page.turns.find((item) => item.id === id) };
  };
  return { userId, request, start, turn };
}

describe('SAM live answer stream in workerd', () => {
  it('streams the answer while the model is still writing and stores exactly that answer', async () => {
    const { request, start, turn } = await setup();
    const midpoint = deferred();
    reply = () =>
      gated([
        content('Shipped today: the '),
        content('mobile scroll fix '),
        midpoint.promise,
        content('and live answers.'),
        finish('stop', usage),
      ]);
    const id = await start('What shipped today?');
    const stream = await request(`/turns/${id}/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const live = follow(stream);
    // The midpoint: the model has not finished, yet the reader already has the words.
    await vi.waitFor(() => expect(live.text()).toBe('Shipped today: the mobile scroll fix '), {
      timeout: 10_000,
      interval: 20,
    });
    const running = await turn(id);
    expect(running.turn).toMatchObject({
      state: 'running',
      live: { text: 'Shipped today: the mobile scroll fix ', phase: 'writing' },
    });
    midpoint.release();
    await live.done;
    expect(live.events[0]).toMatchObject({ type: 'snapshot', turnId: id });
    expect(live.events.at(-1)).toEqual({ type: 'done', state: 'completed' });
    const finished = await turn(id);
    expect(finished.turn).toMatchObject({ state: 'completed' });
    expect(finished.turn?.response).toBe('Shipped today: the mobile scroll fix and live answers.');
    expect(live.text()).toBe(finished.turn?.response);
    expect(finished.turn).not.toHaveProperty('live');
    // Upstream is a real stream, pinned to the conversation for prefix-cache hits,
    // and the model is told the current time.
    expect(modelRequests[0]?.body.stream).toBe(true);
    expect(modelRequests[0]?.headers.get('x-session-affinity')).toBe(
      `sam-${finished.page.conversationId}`
    );
    const system = String(modelRequests[0]?.body.messages?.[0]?.content);
    const stamp = system.match(/Current time: (\S+) \(/)?.[1];
    expect(Math.abs(Date.parse(stamp ?? '') - Date.now())).toBeLessThan(60_000);
  });

  it('reports each tool step as it starts and finishes, then streams the final answer', async () => {
    const { request, start } = await setup();
    const toolRunning = deferred();
    reply = (_body, index) =>
      index === 0
        ? gated([
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-projects',
                        type: 'function',
                        function: { name: 'sam_projects_list', arguments: '{"limit":5}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            finish('tool_calls', usage),
          ])
        : gated([toolRunning.promise, content('You have no projects yet.'), finish('stop', usage)]);
    const id = await start('List my projects');
    const live = follow(await request(`/turns/${id}/stream`));
    await vi.waitFor(
      () =>
        expect(live.events).toContainEqual({
          type: 'tool',
          activity: {
            id: 'call-projects',
            operation: 'sam_projects_list',
            state: 'completed',
            target: { limit: 5 },
            count: 0,
            more: false,
          },
        }),
      { timeout: 10_000, interval: 20 }
    );
    expect(live.events).toContainEqual({
      type: 'tool',
      activity: {
        id: 'call-projects',
        operation: 'sam_projects_list',
        state: 'running',
        target: { limit: 5 },
      },
    });
    toolRunning.release();
    await live.done;
    expect(live.text()).toBe('You have no projects yet.');
    expect(live.events.at(-1)).toEqual({ type: 'done', state: 'completed' });
  });

  it('charges an estimated cost when a streamed step reports no usage', async () => {
    const { userId, start, turn } = await setup();
    reply = () => gated([content('An answer without a usage chunk.'), finish('stop')]);
    const id = await start('Answer briefly');
    await vi.waitFor(async () => expect((await turn(id)).turn?.state).toBe('completed'), {
      timeout: 10_000,
      interval: 20,
    });
    const date = new Date().toISOString().slice(0, 10);
    const budget = await env.KV.get<{ inputTokens: number; outputTokens: number }>(
      `ai-budget:${userId}:${date}`,
      'json'
    );
    // Never a free step: the request body alone is thousands of bytes.
    expect(budget?.inputTokens).toBeGreaterThan(100);
    expect(budget?.outputTokens).toBeGreaterThan(0);
  });

  it('follows only the owner’s running turn', async () => {
    const { request, start, turn } = await setup();
    const hold = deferred();
    reply = () => gated([hold.promise, content('Done.'), finish('stop', usage)]);
    const id = await start('Wait for me');
    expect((await request(`/turns/${id}/stream`, 'GET', undefined, 'someone-else')).status).toBe(
      403
    );
    expect((await request('/turns/not-a-running-turn/stream')).status).toBe(204);
    const owner = await request(`/turns/${id}/stream`);
    expect(owner.status).toBe(200);
    const live = follow(owner);
    hold.release();
    await live.done;
    expect((await turn(id)).turn?.state).toBe('completed');
    expect((await request(`/turns/${id}/stream`)).status).toBe(204);
  });
});
