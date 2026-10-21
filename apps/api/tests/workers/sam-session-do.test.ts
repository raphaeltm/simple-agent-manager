/** Real SamSession SQLite and Mastra Agent; only model HTTP is stubbed. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelReply } from './support/sam-model-reply';
import { type SamRuntimeStub, startSamRuntime } from './support/sam-native-runtime';

type Turn = {
  id: string;
  state: string;
  message: string;
  response: string | null;
  generation: number;
};
type History = {
  conversationId: string;
  backingTaskId: string;
  turns: Turn[];
  nextCursor: string | null;
};

const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const modelRequests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
const http = vi.fn<typeof fetch>();
let modelDelay: Promise<void> | null = null;
let modelText: string | undefined;
let requestedTool: { name: string; arguments: Record<string, unknown> } | null = null;
let env: Awaited<ReturnType<typeof startSamRuntime>>;
beforeAll(async () => {
  env = await startSamRuntime((request) => http(request));
});
afterAll(async () => {
  await env?.close();
});

async function setup(enabled = true) {
  await env.DATABASE.prepare(
    "DELETE FROM platform_settings WHERE key='operations.samOperatorDisabled'"
  ).run();
  const userId = `sam-worker-${crypto.randomUUID()}`;
  await env.DATABASE.prepare("INSERT INTO users(id,email,name,status) VALUES(?,?,?,'active')")
    .bind(userId, `${userId}@example.test`, 'SAM Worker Test')
    .run();
  const stub = env.SAM_SESSION.get(env.SAM_SESSION.idFromName(userId)) as SamRuntimeStub;
  await stub.testEnvironment({
    SAM_RATE_LIMIT_RPM: '30',
    SAM_MODEL: MODEL,
  });
  const request = (path: string, method = 'GET', body?: unknown, asUser = userId) =>
    stub.fetch(`https://sam-session${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-sam-user-id': asUser },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  if (enabled) expect((await request('/settings', 'PATCH', { enabled: true })).status).toBe(200);
  return { userId, stub, request };
}

async function completed(request: Awaited<ReturnType<typeof setup>>['request'], turnId: string) {
  let turn: Turn | undefined;
  await vi.waitFor(
    async () => {
      const page = (await (await request('/turns')).json()) as History;
      turn = page.turns.find((item) => item.id === turnId);
      expect(turn?.state).toBe('completed');
    },
    { timeout: 5000, interval: 20 }
  );
  return turn!;
}

describe('SamSession durable operator in workerd', () => {
  beforeEach(() => {
    modelRequests.length = 0;
    modelDelay = null;
    modelText = undefined;
    requestedTool = null;
    http.mockReset();
    http.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (
        !url.startsWith('https://gateway.ai.cloudflare.com/v1/sam-test-account/sam-test-gateway/')
      ) {
        throw new Error(`Unexpected external HTTP boundary: ${url}`);
      }
      const body = JSON.parse(
        init?.body
          ? String(init.body)
          : typeof input === 'object' && 'text' in input
            ? await input.text()
            : '{}'
      ) as Record<string, unknown>;
      modelRequests.push({
        url,
        body,
        headers: new Headers(
          init?.headers ??
            (typeof input === 'object' && 'headers' in input ? input.headers : undefined)
        ),
      });
      await modelDelay;
      if (url.includes('/anthropic/')) return anthropicReply(body.stream === true);
      if (requestedTool && modelRequests.length === 1) return modelToolReply(body.stream === true);
      return modelReply(modelText, body.stream === true);
    });
  });

  it('is OFF by default and fences inference, history, and legacy paths without model calls', async () => {
    const { request, stub } = await setup(false);
    expect(await (await request('/settings')).json()).toEqual({ enabled: false, available: true });
    for (const path of ['/turns', '/conversations', '/search?query=private']) {
      expect((await request(path)).status).toBe(403);
    }
    expect(
      (await request('/turns', 'POST', { requestKey: 'off', message: 'Do work' })).status
    ).toBe(403);
    expect((await request('/chat', 'POST', { message: 'Legacy bypass' })).status).toBe(403);
    expect((await stub.testSql('SELECT COUNT(*) AS count FROM operator_turns'))[0]?.count).toBe(0);
    expect(http).not.toHaveBeenCalled();
  });

  it('persists opt-in and one private conversation across new stub handles', async () => {
    const { userId, request } = await setup();
    const first = (await (await request('/turns')).json()) as History;
    const newStub = env.SAM_SESSION.get(env.SAM_SESSION.idFromName(userId));
    expect(await (await newStub.fetch('https://sam-session/settings')).json()).toMatchObject({
      enabled: true,
    });
    const second = (await (await newStub.fetch('https://sam-session/turns')).json()) as History;
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.backingTaskId).toBe(first.backingTaskId);
    expect((await request('/chat', 'POST', { message: 'Legacy bypass' })).status).toBe(409);
    expect(http).not.toHaveBeenCalled();
  });

  it('runs actual Mastra generation through the gateway and durably reconnects to the result', async () => {
    const { request, userId } = await setup();
    const response = await request('/turns', 'POST', {
      requestKey: 'greeting',
      message: 'Say hello',
    });
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { accepted: boolean; turn: Turn };
    expect(accepted.accepted).toBe(true);
    const turn = await completed(request, accepted.turn.id);
    expect(turn.response).toBe('Hello from the actual Mastra runtime');
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.url).toContain('/workers-ai/v1/chat/completions');
    expect(modelRequests[0]?.body.model).toBe(MODEL);
    expect(modelRequests[0]?.headers.get('cf-aig-metadata')).toContain(accepted.turn.id);
    const date = new Date().toISOString().slice(0, 10);
    expect(await env.KV.get(`ai-budget:${userId}:${date}`, 'json')).toEqual({
      inputTokens: 10,
      outputTokens: 7,
    });
    const providerUsage = await env.KV.get<Record<string, unknown>>(
      `ai-provider-usage:${userId}:${date}`,
      'json'
    );
    expect(Object.values(providerUsage ?? {})).toContainEqual(
      expect.objectContaining({
        providerId: 'workers-ai',
        requests: 1,
        inputTokens: 10,
        outputTokens: 7,
      })
    );
    const replay = await request('/turns', 'POST', {
      requestKey: 'greeting',
      message: 'Say hello',
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true,
      turn: { id: turn.id, state: 'completed' },
    });
    expect(modelRequests).toHaveLength(1);
    expect(
      (await request('/turns', 'POST', { requestKey: 'greeting', message: 'Different intent' }))
        .status
    ).toBe(409);
  });

  it('runs the actual Anthropic gateway adapter with unified billing and records its usage', async () => {
    const { request, stub, userId } = await setup();
    await stub.testEnvironment({ SAM_MODEL: 'claude-sonnet-5', AI_PROXY_BILLING_MODE: 'unified' });
    const response = await request('/turns', 'POST', {
      requestKey: 'anthropic',
      message: 'Reply through the configured Anthropic gateway',
    });
    expect(response.status).toBe(202);
    const { turn } = (await response.json()) as { turn: Turn };
    expect(await completed(request, turn.id)).toMatchObject({
      response: 'Anthropic native adapter replied',
    });
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.url).toContain('/anthropic/v1/messages');
    expect(modelRequests[0]?.body.model).toBe('claude-sonnet-5');
    expect(modelRequests[0]?.headers.get('cf-aig-authorization')).toBe(
      'Bearer test-only-fake-token'
    );
    expect(modelRequests[0]?.headers.get('cf-aig-metadata')).toContain(turn.id);
    const date = new Date().toISOString().slice(0, 10);
    expect(await env.KV.get(`ai-budget:${userId}:${date}`, 'json')).toEqual({
      inputTokens: 10,
      outputTokens: 7,
    });
    const usage = await env.KV.get<Record<string, unknown>>(
      `ai-provider-usage:${userId}:${date}`,
      'json'
    );
    expect(Object.values(usage ?? {})).toContainEqual(
      expect.objectContaining({
        providerId: 'anthropic',
        requests: 1,
        inputTokens: 10,
        outputTokens: 7,
      })
    );
  });

  it('executes an actual Mastra tool call against private SQLite and feeds the result into the next model step', async () => {
    const { request, stub } = await setup();
    const history = (await (await request('/turns')).json()) as History;
    await seedMessage(
      stub,
      history.conversationId,
      'PRIVATE_LOOKUP_TOKEN refers to the archived constraint',
      1
    );
    requestedTool = {
      name: 'sam_private_history_search',
      arguments: { query: 'PRIVATE_LOOKUP_TOKEN' },
    };
    const { turn } = (await (
      await request('/turns', 'POST', {
        requestKey: 'tool-roundtrip',
        message: 'Find my prior constraint',
      })
    ).json()) as { turn: Turn };
    expect(await completed(request, turn.id)).toMatchObject({
      response: 'Hello from the actual Mastra runtime',
    });
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]?.body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({
            name: 'sam_private_history_search',
            parameters: expect.objectContaining({ required: ['query'] }),
          }),
        }),
      ])
    );
    const messages = modelRequests[1]?.body.messages as Array<{
      role: string;
      content: unknown;
      tool_call_id?: string;
    }>;
    const result = messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'private-history-call'
    );
    expect(JSON.stringify(result?.content)).toContain('PRIVATE_LOOKUP_TOKEN');
    expect(JSON.stringify(result?.content)).toContain('archived constraint');
  });

  it.each([
    { label: 'empty', text: '', withReceipt: false },
    { label: 'whitespace', text: '   ', withReceipt: false },
    { label: 'empty after a recorded action', text: '', withReceipt: true },
  ])(
    'interrupts $label output without replaying inference or receipts',
    async ({ text, withReceipt }) => {
      const { request, stub, userId } = await setup();
      modelText = text;
      if (withReceipt) requestedTool = { name: 'sam_projects_list', arguments: { limit: 1 } };
      const input = { requestKey: 'empty-answer', message: 'Answer the request' };
      const { turn } = (await (await request('/turns', 'POST', input)).json()) as { turn: Turn };
      await vi.waitFor(
        async () => {
          const page = (await (await request('/turns')).json()) as History;
          expect(page.turns.find((item) => item.id === turn.id)).toMatchObject({
            state: 'interrupted',
            response: null,
            error: expect.stringContaining('Review recorded actions'),
          });
        },
        { timeout: 5000, interval: 20 }
      );
      const expectedCalls = withReceipt ? 2 : 1;
      expect(modelRequests).toHaveLength(expectedCalls);
      expect(await (await request('/turns', 'POST', input)).json()).toMatchObject({
        replayed: true,
        turn: { id: turn.id, state: 'interrupted' },
      });
      expect(modelRequests).toHaveLength(expectedCalls);
      const actions = await stub.testSql('SELECT state FROM operator_actions WHERE turn_id=?', [
        turn.id,
      ]);
      expect(actions).toEqual(withReceipt ? [expect.objectContaining({ state: 'completed' })] : []);
      const date = new Date().toISOString().slice(0, 10);
      expect(await env.KV.get(`ai-budget:${userId}:${date}`, 'json')).toEqual({
        inputTokens: withReceipt ? 13 : 10,
        outputTokens: withReceipt ? 9 : 7,
      });
    }
  );

  it('executes shared project reads through the same native schema bridge with current user scope', async () => {
    const { request, stub, userId } = await setup();
    const other = await setup();
    const projectId = crypto.randomUUID();
    for (const [id, owner, name] of [
      [projectId, userId, 'Visible project'],
      [crypto.randomUUID(), other.userId, 'Private other project'],
    ]) {
      await env.DATABASE.prepare(
        "INSERT INTO projects(id,user_id,name,normalized_name,installation_id,repository,created_by) VALUES(?,?,?,?,'system_anonymous_trials_installation',?,?)"
      )
        .bind(id, owner, name, name!.toLowerCase(), `test/${id}`, owner)
        .run();
      await env.DATABASE.prepare(
        "INSERT INTO project_members(project_id,user_id,role,status) VALUES(?,?,'owner','active')"
      )
        .bind(id, owner)
        .run();
    }
    requestedTool = { name: 'sam_projects_list', arguments: { limit: 10 } };
    const { turn } = (await (
      await request('/turns', 'POST', { requestKey: 'project-list', message: 'List my projects' })
    ).json()) as { turn: Turn };
    await completed(request, turn.id);
    expect(modelRequests).toHaveLength(2);
    const messages = modelRequests[1]?.body.messages as Array<{ role: string; content: unknown }>;
    const result = messages.find((message) => message.role === 'tool');
    expect(JSON.stringify(result?.content)).toContain('Visible project');
    expect(JSON.stringify(result?.content)).not.toContain('Private other project');
    const actions = await stub.testSql(
      'SELECT operation,state,result_json FROM operator_actions WHERE turn_id=?',
      [turn.id]
    );
    expect(actions).toEqual([
      expect.objectContaining({ operation: 'sam_projects_list', state: 'completed' }),
    ]);
    expect(String(actions[0]?.result_json)).toContain(projectId);
    const tools = modelRequests[0]?.body.tools as Array<{
      function: { name: string; parameters: { properties: Record<string, unknown> } };
    }>;
    expect(
      tools.find((tool) => tool.function.name === 'sam_agent_answer')?.function.parameters
        .properties
    ).not.toHaveProperty('formContent');
  });

  it('keeps server validation active when a native model supplies invalid tool arguments', async () => {
    const { request, stub } = await setup();
    requestedTool = { name: 'sam_projects_list', arguments: { limit: 0 } };
    const { turn } = (await (
      await request('/turns', 'POST', { requestKey: 'invalid-tool', message: 'List my projects' })
    ).json()) as { turn: Turn };
    await completed(request, turn.id);
    expect(modelRequests).toHaveLength(2);
    const messages = modelRequests[1]?.body.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages.find((message) => message.role === 'tool')?.content)).toContain(
      'validation failed'
    );
    expect(
      await stub.testSql('SELECT id FROM operator_actions WHERE turn_id=?', [turn.id])
    ).toEqual([]);
  });

  it('does not replay interrupted runtime work when an alarm recovers its durable receipt', async () => {
    const { stub, request } = await setup();
    const id = crypto.randomUUID();
    const settings = (
      await stub.testSql('SELECT generation,conversation_id FROM operator_settings')
    )[0]!;
    await stub.testSql(
      "INSERT INTO operator_turns(id,request_key,conversation_id,message,generation,state,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,?)",
      [
        id,
        'crashed',
        settings.conversation_id!,
        'Accepted before isolate exit',
        settings.generation!,
        Date.now(),
        Date.now(),
      ]
    );
    await stub.testSql(
      "INSERT INTO operator_actions(id,turn_id,operation,input_json,state,created_at) VALUES(?,?,?,'{}','uncertain',?)",
      ['uncertain-action', id, 'sam_chat_start', Date.now()]
    );
    await stub.testAlarm();
    const page = (await (await request('/turns')).json()) as History & {
      turns: Array<Turn & { actions: Array<{ state: string }> }>;
    };
    expect(page.turns[0]?.state).toBe('interrupted');
    expect(page.turns[0]?.actions[0]?.state).toBe('uncertain');
    expect(http).not.toHaveBeenCalled();
  });

  it('isolates private conversations and transcript search by user', async () => {
    const first = await setup();
    const second = await setup();
    const a = (await (await first.request('/turns')).json()) as History;
    const b = (await (await second.request('/turns')).json()) as History;
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.backingTaskId).not.toBe(b.backingTaskId);
    await seedMessage(first.stub, a.conversationId, 'only-first-user', 1);
    expect(await (await second.request('/search?query=only-first-user')).json()).toMatchObject({
      results: [],
    });
    expect(
      await (await second.request(`/conversations/${a.conversationId}/messages`)).json()
    ).toMatchObject({ messages: [] });
    expect(http).not.toHaveBeenCalled();
  });

  it('cancels an accepted turn while model HTTP is pending, without a late assistant result', async () => {
    const { request, stub } = await setup();
    let release!: () => void;
    modelDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepted = (await (
      await request('/turns', 'POST', { requestKey: 'cancel', message: 'Wait for cancellation' })
    ).json()) as { turn: Turn };
    await vi.waitFor(() => expect(modelRequests).toHaveLength(1));
    try {
      expect(
        await (await request(`/turns/${accepted.turn.id}/cancel`, 'POST')).json()
      ).toMatchObject({ turn: { state: 'cancelled' } });
    } finally {
      release();
    }
    await vi.waitFor(async () => {
      const row = (
        await stub.testSql('SELECT state,response FROM operator_turns WHERE id=?', [
          accepted.turn.id,
        ])
      )[0];
      expect(row).toMatchObject({ state: 'cancelled', response: null });
    });
  });

  it('disabling fences an in-flight response and re-enabling cannot replay its old generation', async () => {
    const { request, stub } = await setup();
    let release!: () => void;
    modelDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepted = (await (
      await request('/turns', 'POST', { requestKey: 'disabled', message: 'Private pending turn' })
    ).json()) as { turn: Turn };
    await vi.waitFor(() => expect(modelRequests).toHaveLength(1));
    try {
      expect((await request('/settings', 'PATCH', { enabled: false })).status).toBe(200);
      expect((await request('/turns')).status).toBe(403);
      expect(
        (await request('/turns', 'POST', { requestKey: 'new', message: 'Bypass' })).status
      ).toBe(403);
    } finally {
      release();
    }
    await request('/settings', 'PATCH', { enabled: true });
    await stub.testAlarm();
    const page = (await (await request('/turns')).json()) as History;
    expect(page.turns.find((turn) => turn.id === accepted.turn.id)).toMatchObject({
      state: 'cancelled',
      response: null,
    });
    expect(modelRequests).toHaveLength(1);
  });

  it('rejects concurrent distinct requests and coalesces concurrent retries to one accepted turn', async () => {
    const { request, stub } = await setup();
    let release!: () => void;
    modelDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const responses = await Promise.all([
        request('/turns', 'POST', { requestKey: 'same', message: 'One intent' }),
        request('/turns', 'POST', { requestKey: 'same', message: 'One intent' }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 202]);
      expect(
        (await request('/turns', 'POST', { requestKey: 'other', message: 'Other intent' })).status
      ).toBe(409);
      expect((await stub.testSql('SELECT COUNT(*) AS count FROM operator_turns'))[0]?.count).toBe(
        1
      );
      await vi.waitFor(() => expect(modelRequests).toHaveLength(1));
    } finally {
      release();
    }
    const turns = ((await (await request('/turns')).json()) as History).turns;
    await completed(request, turns[0]!.id);
  });

  it('enforces a durable rate limit and repairs a malformed legacy rate window', async () => {
    const { request, stub } = await setup();
    await stub.testEnvironment({ SAM_RATE_LIMIT_RPM: '1' });
    await stub.testSql(
      "INSERT OR REPLACE INTO operator_rate_limit VALUES(1,'not-a-timestamp',999)"
    );
    const accepted = (await (
      await request('/turns', 'POST', { requestKey: 'rate-first', message: 'First turn' })
    ).json()) as { turn: Turn };
    await completed(request, accepted.turn.id);
    const row = (await stub.testSql('SELECT window_start,used FROM operator_rate_limit'))[0]!;
    expect(typeof row.window_start).toBe('number');
    expect(row.used).toBe(1);
    const limited = await request('/turns', 'POST', {
      requestKey: 'rate-second',
      message: 'Second turn',
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(modelRequests).toHaveLength(1);
  });

  it('preserves legacy history, typed conversation listing, bounded pagination, and malformed-row isolation after opt-in', async () => {
    const { request, stub } = await setup();
    const page = (await (await request('/turns')).json()) as History;
    for (let i = 1; i <= 4; i++)
      await seedMessage(stub, page.conversationId, `Good legacy message ${i}`, i);
    await stub.testSql(
      "INSERT INTO conversations(id,title,type) VALUES('agent-history','Agent report','agent')"
    );
    await stub.testSql(
      "INSERT INTO messages(id,conversation_id,role,content,sequence) VALUES('malformed',?,'user','bad sequence','not-a-number')",
      [page.conversationId]
    );
    const human = (await (await request('/conversations?type=human')).json()) as {
      conversations: Array<{ id: string; type: string }>;
    };
    expect(human.conversations).toContainEqual(
      expect.objectContaining({ id: page.conversationId, type: 'human' })
    );
    const agent = (await (await request('/conversations?type=agent')).json()) as {
      conversations: Array<{ id: string; type: string }>;
    };
    expect(agent.conversations).toEqual([
      expect.objectContaining({ id: 'agent-history', type: 'agent' }),
    ]);
    const latest = (await (
      await request(`/conversations/${page.conversationId}/messages?limit=2`)
    ).json()) as { messages: Array<{ content: string; sequence: number }>; nextCursor: number };
    expect(latest.messages.map((message) => message.sequence)).toEqual([3, 4]);
    const older = (await (
      await request(
        `/conversations/${page.conversationId}/messages?limit=2&before=${latest.nextCursor}`
      )
    ).json()) as { messages: Array<{ content: string; sequence: number }> };
    expect(older.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(await (await request('/turns')).json()).toMatchObject({ legacyHistoryAvailable: true });
    await request('/settings', 'PATCH', { enabled: false });
    expect((await request(`/conversations/${page.conversationId}/messages`)).status).toBe(403);
    expect(http).not.toHaveBeenCalled();
  });

  it('preserves FTS search, search result limits, and SQLite LIKE escape bounds', async () => {
    const { request, stub } = await setup();
    const { conversationId } = (await (await request('/turns')).json()) as History;
    for (let i = 1; i <= 5; i++)
      await seedMessage(stub, conversationId, `XYZZY_UNIQUE_SEARCH_TOKEN iteration ${i}`, i);
    const search = (await (
      await request('/search?query=XYZZY_UNIQUE_SEARCH_TOKEN&limit=2')
    ).json()) as { results: Array<{ snippet: string }> };
    expect(search.results).toHaveLength(2);
    expect(search.results[0]?.snippet).toContain('XYZZY_UNIQUE_SEARCH_TOKEN');
    const literalPrefix = '%'.repeat(24);
    await seedMessage(stub, conversationId, `${literalPrefix} literal percent signs`, 6);
    expect(
      await (await request(`/search?query=${encodeURIComponent('%'.repeat(100))}`)).json()
    ).toMatchObject({
      query: literalPrefix,
      queryTruncated: true,
      results: [expect.objectContaining({ snippet: expect.stringContaining(literalPrefix) })],
    });
    expect((await request('/search?query=')).status).toBe(400);
    expect(http).not.toHaveBeenCalled();
  });

  it('resumes an accepted turn after an isolate interruption without changing its identity', async () => {
    const { request, stub } = await setup();
    const settings = (
      await stub.testSql('SELECT generation,conversation_id FROM operator_settings')
    )[0]!;
    const id = crypto.randomUUID();
    await stub.testSql(
      "INSERT INTO operator_turns(id,request_key,conversation_id,message,generation,state,created_at,updated_at) VALUES(?,?,?,?,?,'accepted',?,?)",
      [
        id,
        'resume-accepted',
        settings.conversation_id!,
        'Persisted before acknowledgement',
        settings.generation!,
        Date.now(),
        Date.now(),
      ]
    );
    await seedMessage(
      stub,
      String(settings.conversation_id),
      'Persisted before acknowledgement',
      1
    );
    await stub.testAlarm();
    expect(await completed(request, id)).toMatchObject({
      id,
      response: 'Hello from the actual Mastra runtime',
    });
    expect(
      await (
        await request('/turns', 'POST', {
          requestKey: 'resume-accepted',
          message: 'Persisted before acknowledgement',
        })
      ).json()
    ).toMatchObject({ replayed: true, turn: { id } });
    expect(modelRequests).toHaveLength(1);
  });

  it('branches retained private messages into a distinct backing task with idempotent branch identity', async () => {
    const { request, stub } = await setup();
    const first = (await (await request('/turns')).json()) as History;
    await seedMessage(stub, first.conversationId, 'Private context to retain', 1);
    const branch = (await (
      await request('/fork', 'POST', { requestKey: 'branch-once' })
    ).json()) as History;
    expect(branch.conversationId).not.toBe(first.conversationId);
    expect(branch.backingTaskId).not.toBe(first.backingTaskId);
    expect(
      await (await request('/fork', 'POST', { requestKey: 'branch-once' })).json()
    ).toMatchObject({
      conversationId: branch.conversationId,
      backingTaskId: branch.backingTaskId,
      replayed: true,
    });
    expect(
      await (await request(`/conversations/${branch.conversationId}/messages`)).json()
    ).toMatchObject({
      messages: [expect.objectContaining({ content: 'Private context to retain' })],
    });
    expect(
      (
        await stub.testSql('SELECT parent_task_id FROM operator_conversation_tasks WHERE id=?', [
          branch.backingTaskId,
        ])
      )[0]?.parent_task_id
    ).toBe(first.backingTaskId);
    expect(http).not.toHaveBeenCalled();
  });

  it('enforces the installation kill switch even for an opted-in user', async () => {
    const { request, stub } = await setup();
    await env.DATABASE.prepare(
      "INSERT INTO platform_settings(key,value,updated_at,updated_by) VALUES('operations.samOperatorDisabled','true',?,NULL)"
    )
      .bind(new Date().toISOString())
      .run();
    expect(await (await request('/settings')).json()).toMatchObject({
      enabled: true,
      available: false,
    });
    expect(
      (await request('/turns', 'POST', { requestKey: 'kill-switch', message: 'Should not run' }))
        .status
    ).toBe(403);
    await stub.testAlarm();
    expect(http).not.toHaveBeenCalled();
  });

  it('validates empty messages, malformed cursors, settings types and unknown routes', async () => {
    const { request } = await setup();
    expect((await request('/turns', 'POST', { requestKey: 'invalid', message: '  ' })).status).toBe(
      400
    );
    expect((await request('/turns?before=invalid')).status).toBe(400);
    expect((await request('/settings', 'PATCH', { enabled: 'yes' })).status).toBe(400);
    expect((await request('/unknown')).status).toBe(404);
    expect(http).not.toHaveBeenCalled();
  });
});

async function seedMessage(
  stub: SamRuntimeStub,
  conversationId: string,
  content: string,
  sequence: number
) {
  const id = crypto.randomUUID();
  await stub.testSql(
    "INSERT INTO messages(id,conversation_id,role,content,sequence) VALUES(?,?,'user',?,?)",
    [id, conversationId, content, sequence]
  );
  await stub.testSql(
    'INSERT INTO messages_fts(rowid,content) SELECT rowid,content FROM messages WHERE id=?',
    [id]
  );
}

function anthropicReply(stream: boolean): Response {
  const message = {
    id: 'anthropic-message',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'Anthropic native adapter replied' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 7 },
  };
  if (!stream) return Response.json(message);
  const events = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Anthropic native adapter replied' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

function modelToolReply(stream: boolean): Response {
  const call = {
    id: 'private-history-call',
    type: 'function',
    function: { name: requestedTool!.name, arguments: JSON.stringify(requestedTool!.arguments) },
  };
  const base = { id: 'tool-completion', model: MODEL, created: 1 };
  const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  if (!stream)
    return Response.json({
      ...base,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [call] },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
  const events = [
    {
      ...base,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage,
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  );
}
