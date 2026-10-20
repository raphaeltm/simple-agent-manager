/** Publication guard through real Mastra, workerd, D1, KV and private DO SQLite. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelReply } from './support/sam-model-reply';
import { type SamRuntimeStub, startSamRuntime } from './support/sam-native-runtime';

const project = '01M5CPTV0GKM9TXWHSX6C6E724';
const invented = '01M5CPTV0GKM9TXWHSX6C6E725';
const origin = 'https://app.test.example.com';
let env: Awaited<ReturnType<typeof startSamRuntime>>;
let calls = 0;
let answer = '';
let readProjects = false;
let beforeAnswer: (() => Promise<void>) | undefined;

beforeAll(async () => {
  env = await startSamRuntime(async (request) => {
    expect(request.url).toMatch(/^https:\/\/gateway\.ai\.cloudflare\.com\//);
    const body = (await request.json()) as { stream?: boolean };
    calls++;
    if (readProjects && calls === 1) {
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
                    function: { name: 'sam_projects_list', arguments: '{"limit":1}' },
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
                    function: { name: 'sam_projects_list', arguments: '{"limit":1}' },
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
    return modelReply(answer, body.stream);
  });
});
afterAll(async () => {
  await env?.close();
});
beforeEach(() => {
  calls = 0;
  answer = '';
  readProjects = false;
  beforeAnswer = undefined;
});

async function setup() {
  const userId = `grounding-${crypto.randomUUID()}`;
  await env.DATABASE.prepare("INSERT INTO users(id,email,name,status) VALUES(?,?,?,'active')")
    .bind(userId, `${userId}@example.test`, 'Grounding user')
    .run();
  const stub = env.SAM_SESSION.get(env.SAM_SESSION.idFromName(userId)) as SamRuntimeStub;
  const request = (path: string, method = 'GET', body?: unknown) =>
    stub.fetch(`https://sam-session${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-sam-user-id': userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await request('/settings', 'PATCH', { enabled: true })).status).toBe(200);
  return { userId, stub, request };
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
  it.each([
    `I have started it. Session: ${project}_SESS. Task: ${project}_TASK. [Chat](${origin}/projects/${project}/chat/${project}_SESS)`,
    `Your session is ${invented}. [Chat](${origin}/projects/${project}/chat/${invented})`,
    'I started it.',
  ])(
    'interrupts unsupported outcome without replay or canonical assistant message: %s',
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
      expect(calls).toBe(1);
      const date = new Date().toISOString().slice(0, 10);
      expect(await env.KV.get(`ai-budget:${fixture.userId}:${date}`, 'json')).toEqual({
        inputTokens: 10,
        outputTokens: 7,
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
