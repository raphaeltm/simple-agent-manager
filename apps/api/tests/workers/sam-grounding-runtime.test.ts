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
    const [settings] = await fixture.stub.testSql('SELECT conversation_id FROM operator_settings');
    await fixture.stub.testSql(
      "INSERT INTO messages(id,conversation_id,role,content,sequence) VALUES('historical-false-claim',?,'assistant',?,1)",
      [settings!.conversation_id!, fake]
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
    expect(correction.split(fake).length - 1).toBe(1);
    expect(
      await fixture.stub.testSql("SELECT content FROM messages WHERE id='historical-false-claim'")
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
