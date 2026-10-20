/** Publication guard through real Mastra, workerd, D1, KV and private DO SQLite. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelReply } from './support/sam-model-reply';
import { type SamRuntimeStub, startSamRuntime } from './support/sam-native-runtime';

const project = '01M5CPTV0GKM9TXWHSX6C6E724';
const invented = '01M5CPTV0GKM9TXWHSX6C6E725';
const origin = 'https://app.test.example.com';
let env: Awaited<ReturnType<typeof startSamRuntime>>;
let calls = 0;
let answer = '';
let readProjects = false;
let providerFailureStatus = 0;
let recoverProvider = false;
let activeFixture: Fixture | undefined;
let toolAtCall = 1;
let toolName = 'sam_projects_list';
let toolArguments: Record<string, unknown> = { limit: 1 };
let answerForCall: ((count: number) => string) | undefined;
const requests: Array<Record<string, unknown>> = [];
let beforeAnswer: (() => Promise<void>) | undefined;

beforeAll(async () => {
  env = await startSamRuntime(async (request) => {
    expect(request.url).toMatch(/^https:\/\/gateway\.ai\.cloudflare\.com\//);
    const body = (await request.json()) as { stream?: boolean } & Record<string, unknown>;
    calls++;
    requests.push(body);
    if (providerFailureStatus && (!recoverProvider || calls === 1))
      return Response.json(
        { error: 'Test provider unavailable' },
        { status: providerFailureStatus }
      );
    if (readProjects && calls === toolAtCall) {
      if (!body.stream)
        return Response.json({
          id: 'grounding-tool',
          model: '@cf/google/gemma-4-26b-a4b-it',
          created: 1,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'project-read',
                    type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(toolArguments) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      const base = {
        id: 'grounding-tool',
        model: '@cf/google/gemma-4-26b-a4b-it',
        created: 1,
        object: 'chat.completion.chunk',
      };
      const events = [
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
                    id: 'project-read',
                    type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(toolArguments) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
    await beforeAnswer?.();
    return modelReply(answerForCall?.(calls) ?? answer, body.stream);
  });
});
afterAll(async () => {
  await env?.close();
});
afterEach(async () => {
  // Fence this fixture even when an assertion fails while inference is pending.
  if (activeFixture) await activeFixture.request('/settings', 'PATCH', { enabled: false });
  activeFixture = undefined;
});
beforeEach(() => {
  calls = 0;
  answer = '';
  readProjects = false;
  providerFailureStatus = 0;
  recoverProvider = false;
  toolAtCall = 1;
  toolName = 'sam_projects_list';
  toolArguments = { limit: 1 };
  answerForCall = undefined;
  requests.length = 0;
  beforeAnswer = undefined;
});

async function setup() {
  const userId = `grounding-${crypto.randomUUID()}`;
  await env.DATABASE.prepare("INSERT INTO users(id,email,name,status) VALUES(?,?,?,'active')")
    .bind(userId, `${userId}@example.test`, 'Grounding user')
    .run();
  const stub = env.SAM_SESSION.get(env.SAM_SESSION.idFromName(userId)) as SamRuntimeStub;
  await stub.testEnvironment({
    SAM_MAX_TURNS: '20',
    SAM_LLM_TIMEOUT_MS: '120000',
    SAM_MAX_REQUEST_BODY_BYTES: '65536',
    AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: '100000',
  });
  const request = (path: string, method = 'GET', body?: unknown) =>
    stub.fetch(`https://sam-session${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-sam-user-id': userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await request('/settings', 'PATCH', { enabled: true })).status).toBe(200);
  const fixture = { userId, stub, request };
  activeFixture = fixture;
  return fixture;
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function finish(fixture: Fixture, state: string) {
  const input = {
    requestKey: 'grounding',
    message: `Use the requested profile ${project}; preserve constraints.`,
  };
  const { turn } = (await (await fixture.request('/turns', 'POST', input)).json()) as {
    turn: { id: string };
  };
  await vi.waitFor(
    async () => {
      const rows = await fixture.stub.testSql(
        'SELECT state,response FROM operator_turns WHERE id=?',
        [turn.id]
      );
      expect(rows[0]).toMatchObject({ state, response: state === 'completed' ? answer : null });
    },
    { timeout: 5000, interval: 20 }
  );
  return { turn, input };
}
async function seedProject(userId: string) {
  await env.DATABASE.prepare('DELETE FROM project_members WHERE project_id=?').bind(project).run();
  await env.DATABASE.prepare('DELETE FROM projects WHERE id=?').bind(project).run();
  await env.DATABASE.prepare(
    "INSERT INTO projects(id,user_id,name,normalized_name,installation_id,repository,created_by) VALUES(?,?,'Visible project','visible project','system_anonymous_trials_installation','test/project',?)"
  )
    .bind(project, userId, userId)
    .run();
  await env.DATABASE.prepare(
    "INSERT INTO project_members(project_id,user_id,role,status) VALUES(?,?,'owner','active')"
  )
    .bind(project, userId)
    .run();
}

describe('receipt-grounded native publication', () => {
  it('publishes a completed dispatch with its exact chat and canonical parent project links', async () => {
    const fixture = await setup();
    const task = '00000000-0000-4000-8000-000000000001';
    const link = `${origin}/projects/${project}/chat/${invented}`;
    answer = `I started the session in [Test Project](${origin}/projects/${project}). Task: ${task}. Session: ${invented}. [Open chat](${link}). The request is queued.`;
    beforeAnswer = async () => {
      const [turn] = await fixture.stub.testSql(
        "SELECT id FROM operator_turns WHERE state='running'"
      );
      // A completed server receipt isolates publication from external provisioning.
      await fixture.stub.testSql(
        'INSERT INTO operator_actions(id,turn_id,operation,input_json,state,result_json,created_at) VALUES(?,?,?,?,?,?,?)',
        [
          'dispatch-receipt',
          turn!.id!,
          'sam_chat_start',
          '{}',
          'completed',
          JSON.stringify({ taskId: task, sessionId: invented, status: 'queued', link }),
          Date.now(),
        ]
      );
    };
    const { turn, input } = await finish(fixture, 'completed');
    expect(calls).toBe(1);
    expect(
      await fixture.stub.testSql('SELECT operation,state FROM operator_actions WHERE turn_id=?', [
        turn.id,
      ])
    ).toEqual([{ operation: 'sam_chat_start', state: 'completed' }]);
    expect(await (await fixture.request('/turns', 'POST', input)).json()).toMatchObject({
      replayed: true,
      turn: { id: turn.id, state: 'completed' },
    });
    expect(calls).toBe(1);
  });
  it.each([1, 20])(
    'never adds correction after a recovered provider error with step budget %s',
    async (budget) => {
      const fixture = await setup();
      await fixture.stub.testEnvironment({ SAM_MAX_TURNS: String(budget) });
      providerFailureStatus = 503;
      recoverProvider = true;
      answer = 'I started it.';
      await finish(fixture, 'interrupted');
      const expectedCalls = Math.min(budget, 2);
      expect(calls).toBe(expectedCalls);
      expect(requests.map((request) => request.tool_choice)).toEqual(
        Array.from({ length: expectedCalls }, () => 'auto')
      );
      expect(await fixture.stub.testSql('SELECT id FROM operator_actions')).toEqual([]);
    }
  );
  it.each([400, 503])(
    'does not correct a provider %s failure within the original deadline',
    async (status) => {
      const fixture = await setup();
      providerFailureStatus = status;
      await fixture.stub.testEnvironment({ SAM_LLM_TIMEOUT_MS: '250' });
      await finish(fixture, 'interrupted');
      expect(calls).toBe(1);
      expect(requests.map((request) => request.tool_choice)).toEqual(['auto']);
      expect(await fixture.stub.testSql('SELECT id FROM operator_actions')).toEqual([]);
    }
  );
  it('corrects one uneffected false-start draft through a real read without rewriting prior history', async () => {
    const fixture = await setup();
    await seedProject(fixture.userId);
    const fake = `I started it. Session: ${project}_SESS`;
    const [settings] = await fixture.stub.testSql(
      'SELECT conversation_id,generation FROM operator_settings'
    );
    const historicalTurn = crypto.randomUUID();
    const constraint = 'Historical read-only request. Never create a PR or merge.';
    await fixture.stub.testSql(
      'INSERT INTO operator_turns(id,request_key,conversation_id,message,generation,state,response,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        historicalTurn,
        'historical-request',
        settings!.conversation_id!,
        constraint,
        settings!.generation!,
        'completed',
        fake,
        Date.now() - 1000,
        Date.now() - 1000,
      ]
    );
    for (const [role, content, sequence] of [
      ['user', constraint, 1],
      ['assistant', fake, 2],
    ] as const)
      await fixture.stub.testSql(
        'INSERT INTO messages(id,conversation_id,role,content,sequence) VALUES(?,?,?,?,?)',
        [`operator:${historicalTurn}:${role}`, settings!.conversation_id!, role, content, sequence]
      );
    readProjects = true;
    toolAtCall = 2;
    answer = `Here is the project: [Project](${origin}/projects/${project})`;
    answerForCall = (count) => (count === 1 ? fake : answer);
    const { turn, input } = await finish(fixture, 'completed');
    expect(calls).toBe(3);
    expect(requests.map((request) => request.tool_choice)).toEqual(['auto', 'required', 'auto']);
    const correction = JSON.stringify(requests[1]?.messages);
    expect(correction).toContain('This correction grants no new authority');
    expect(correction.split(fake).length - 1).toBe(0);
    type WireMessage = {
      role: string;
      content: string | null;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    const initialMessages = requests[0]!.messages as WireMessage[];
    expect(initialMessages).toContainEqual({ role: 'user', content: constraint });
    expect(initialMessages.at(-1)).toEqual({ role: 'user', content: input.message });
    expect(JSON.stringify(initialMessages)).not.toContain(fake);
    const status = initialMessages.find((message) => message.content?.startsWith('{"kind":'));
    expect(JSON.parse(status!.content!)).toMatchObject({
      kind: 'sam_historical_turn_status',
      turnId: historicalTurn,
      state: 'completed',
      assistantOmitted: true,
      authority: 'historical_evidence_only',
      actions: [],
    });
    type WireTool = {
      type: string;
      function: { name: string; parameters: Record<string, unknown> };
    };
    const tools = requests[0]!.tools as WireTool[];
    expect(tools.map((tool) => tool.function.name).sort()).toEqual([
      'sam_agent_answer',
      'sam_chat_read',
      'sam_chat_send',
      'sam_chat_start',
      'sam_chats_list',
      'sam_chats_search',
      'sam_idea_create',
      'sam_idea_get',
      'sam_idea_update',
      'sam_ideas_search',
      'sam_inbox_get',
      'sam_private_history_search',
      'sam_profiles_list',
      'sam_project_get',
      'sam_projects_list',
      'sam_task_get',
      'sam_tasks_list',
      'sam_work_stop',
    ]);
    expect(
      tools.every((tool) => tool.type === 'function' && tool.function.parameters.type === 'object')
    ).toBe(true);
    expect(
      tools.find((tool) => tool.function.name === 'sam_chat_start')?.function.parameters
    ).toMatchObject({
      required: ['projectId', 'message'],
      properties: {
        projectId: { type: 'string' },
        message: { type: 'string' },
        agentProfileId: { type: 'string' },
      },
    });
    expect(requests[1]!.tools).toEqual(tools);
    expect(requests[2]!.tools).toEqual(tools);
    const afterRead = requests[2]!.messages as WireMessage[];
    const call = afterRead.find((message) => message.tool_calls?.length);
    expect(call?.tool_calls).toEqual([
      {
        id: 'project-read',
        type: 'function',
        function: { name: 'sam_projects_list', arguments: '{"limit":1}' },
      },
    ]);
    const result = afterRead.find((message) => message.role === 'tool');
    expect(result?.tool_call_id).toBe('project-read');
    expect(JSON.parse(result!.content!)).toMatchObject({ projects: [{ id: project }] });

    expect(
      await fixture.stub.testSql('SELECT content FROM messages WHERE id=?', [
        `operator:${historicalTurn}:assistant`,
      ])
    ).toEqual([{ content: fake }]);
    expect(
      await fixture.stub.testSql(
        "SELECT COUNT(*) AS count FROM messages WHERE role='assistant' AND content=?",
        [fake]
      )
    ).toEqual([{ count: 1 }]);
    expect(
      await fixture.stub.testSql('SELECT operation,state FROM operator_actions WHERE turn_id=?', [
        turn.id,
      ])
    ).toEqual([expect.objectContaining({ operation: 'sam_projects_list', state: 'completed' })]);
    const date = new Date().toISOString().slice(0, 10);
    expect(await env.KV.get(`ai-budget:${fixture.userId}:${date}`, 'json')).toEqual({
      inputTokens: 23,
      outputTokens: 16,
    });
    expect(await (await fixture.request('/turns', 'POST', input)).json()).toMatchObject({
      replayed: true,
      turn: { id: turn.id, state: 'completed' },
    });
    expect(calls).toBe(3);
  });

  it.each([
    {
      name: 'sam_private_history_search',
      arguments: { query: 'prior constraint' },
      receipt: false,
    },
    { name: 'sam_projects_list', arguments: { limit: 0 }, receipt: false },
    { name: 'sam_unknown_operation', arguments: {}, receipt: false },
    { name: 'sam_project_get', arguments: { projectId: 'missing-project' }, receipt: false },
    {
      name: 'sam_chat_start',
      arguments: { projectId: 'missing-project', message: 'Do not create anything' },
      receipt: true,
    },
  ])('never corrects after a successful, invalid or failed tool attempt: $name', async (tool) => {
    const fixture = await setup();
    readProjects = true;
    toolName = tool.name;
    toolArguments = tool.arguments;
    answer = 'I started it.';
    const { turn } = await finish(fixture, 'interrupted');
    expect(calls).toBeLessThanOrEqual(2);
    expect(requests.every((request) => request.tool_choice !== 'required')).toBe(true);
    expect(
      await fixture.stub.testSql('SELECT state FROM operator_actions WHERE turn_id=?', [turn.id])
    ).toEqual(tool.receipt ? [expect.objectContaining({ state: 'uncertain' })] : []);
  });

  it.each([1, 2])('keeps both generations within a shared %i-step budget', async (limit) => {
    const fixture = await setup();
    await fixture.stub.testEnvironment({ SAM_MAX_TURNS: String(limit) });
    readProjects = true;
    toolAtCall = 2;
    answer = 'I started it.';
    await finish(fixture, 'interrupted');
    expect(calls).toBe(limit);
  });

  it.each(['disable', 'cancel', 'suspend', 'usage-budget', 'deadline'] as const)(
    'does not begin correction after the %s fence',
    async (fence) => {
      const fixture = await setup();
      answer = 'I started it.';
      if (fence === 'deadline') await fixture.stub.testEnvironment({ SAM_LLM_TIMEOUT_MS: '250' });
      beforeAnswer = async () => {
        if (fence === 'disable') await fixture.request('/settings', 'PATCH', { enabled: false });
        if (fence === 'cancel') {
          const [turn] = await fixture.stub.testSql(
            "SELECT id FROM operator_turns WHERE state='running'"
          );
          await fixture.request(`/turns/${turn!.id}/cancel`, 'POST');
        }
        if (fence === 'suspend')
          await env.DATABASE.prepare("UPDATE users SET status='suspended' WHERE id=?")
            .bind(fixture.userId)
            .run();
        if (fence === 'usage-budget')
          await fixture.stub.testEnvironment({ AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: '1' });
        if (fence === 'deadline') await new Promise((resolve) => setTimeout(resolve, 350));
      };
      await finish(
        fixture,
        fence === 'disable' || fence === 'cancel' ? 'cancelled' : 'interrupted'
      );
      expect(calls).toBe(1);
      expect(await fixture.stub.testSql('SELECT id FROM operator_actions')).toEqual([]);
    }
  );

  it('does not add correction instructions beyond the existing context byte budget', async () => {
    const fixture = await setup();
    await fixture.stub.testEnvironment({ SAM_MAX_REQUEST_BODY_BYTES: '180' });
    answer = 'I started it.';
    await finish(fixture, 'interrupted');
    expect(calls).toBe(1);
  });

  it.each([
    `I have started it. Session: ${project}_SESS. Task: ${project}_TASK. [Chat](${origin}/projects/${project}/chat/${project}_SESS)`,
    `Your session is ${invented}. [Chat](${origin}/projects/${project}/chat/${invented})`,
    'I started it.',
  ])(
    'interrupts a second unsupported outcome without replay or canonical assistant message: %s',
    async (text) => {
      const fixture = await setup();
      answer = text;
      const { turn, input } = await finish(fixture, 'interrupted');
      expect(
        await fixture.stub.testSql('SELECT id FROM operator_actions WHERE turn_id=?', [turn.id])
      ).toEqual([]);
      expect(await fixture.stub.testSql("SELECT id FROM messages WHERE role='assistant'")).toEqual(
        []
      );
      expect(await (await fixture.request('/turns', 'POST', input)).json()).toMatchObject({
        replayed: true,
        turn: { id: turn.id, state: 'interrupted' },
      });
      expect(calls).toBe(2);
      const date = new Date().toISOString().slice(0, 10);
      expect(await env.KV.get(`ai-budget:${fixture.userId}:${date}`, 'json')).toEqual({
        inputTokens: 20,
        outputTokens: 14,
      });
    }
  );
  it.each([false, true])(
    'accepts a real current read link but rejects a fabricated effect (claim=%s)',
    async (claim) => {
      const fixture = await setup();
      await seedProject(fixture.userId);
      readProjects = true;
      answer = `${claim ? 'I started it.' : 'Here is the project.'} [Project](${origin}/projects/${project})`;
      const { turn } = await finish(fixture, claim ? 'interrupted' : 'completed');
      expect(calls).toBe(2);
      expect(
        await fixture.stub.testSql('SELECT operation,state FROM operator_actions WHERE turn_id=?', [
          turn.id,
        ])
      ).toEqual([expect.objectContaining({ operation: 'sam_projects_list', state: 'completed' })]);
      const date = new Date().toISOString().slice(0, 10);
      expect(await env.KV.get(`ai-budget:${fixture.userId}:${date}`, 'json')).toEqual({
        inputTokens: 13,
        outputTokens: 9,
      });
    }
  );
  it.each([
    { state: 'approval_required', claim: true },
    { state: 'uncertain', claim: true },
    { state: 'approval_required', claim: false },
    { state: 'uncertain', claim: false },
  ])(
    'preserves $state receipt and distinguishes an outcome claim ($claim)',
    async ({ state, claim }) => {
      const fixture = await setup();
      answer = claim ? 'I stopped it.' : 'Review the action card; the outcome is not confirmed.';
      // Seed the durable external-effect boundary state, without running any effect.
      beforeAnswer = async () => {
        const [turn] = await fixture.stub.testSql(
          "SELECT id FROM operator_turns WHERE state='running'"
        );
        await fixture.stub.testSql(
          'INSERT INTO operator_actions(id,turn_id,operation,input_json,state,result_json,created_at) VALUES(?,?,?,?,?,?,?)',
          ['stop-receipt', turn!.id!, 'sam_work_stop', '{}', state, null, Date.now()]
        );
      };
      const { turn, input } = await finish(fixture, claim ? 'interrupted' : 'completed');
      expect(
        await fixture.stub.testSql('SELECT state FROM operator_actions WHERE turn_id=?', [turn.id])
      ).toEqual([expect.objectContaining({ state })]);
      expect(await (await fixture.request('/turns', 'POST', input)).json()).toMatchObject({
        replayed: true,
      });
      expect(calls).toBe(1);
    }
  );
  it.each([
    'Hello.',
    'I have not started it.',
    'I cannot confirm it started.',
    'Should I start?',
    'I have updated the plan above.',
    'I created a draft outline.',
    'I started thinking about the launch.',
  ])('preserves ordinary or qualified conversation: %s', async (text) => {
    const fixture = await setup();
    answer = text;
    await finish(fixture, 'completed');
    expect(calls).toBe(1);
  });
});
