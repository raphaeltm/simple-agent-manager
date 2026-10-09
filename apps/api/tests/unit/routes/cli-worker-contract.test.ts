import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { agentProfileRoutes } from '../../../src/routes/agent-profiles';
import { registerChatPromptRoute } from '../../../src/routes/chat-prompt-route';
import { jsonValidator, SubmitTaskSchema } from '../../../src/schemas';
import { cliOperationReceipt } from '../../../src/services/cli-operation-receipts';

const project = '01K00000000000000000000000';
const sol = {
  id: 'profile-sol',
  projectId: project,
  name: 'Sol',
  agentType: 'openai-codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  runtime: 'vm',
  permissionMode: null,
};
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'fixture-user',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/services/agent-profiles', () => ({ listProfiles: async () => [sol] }));
vi.mock('../../../src/routes/chat-session-ownership', () => ({ requireSessionCreator: vi.fn() }));
vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: async (content: string) => ({ enrichedMessage: content }),
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  cancelScheduledSessionSleep: vi.fn(),
}));
vi.mock('../../../src/routes/chat-prompt-forward', () => ({
  forwardPromptToLiveAgent: async () => ({ accepted: true, messageId: 'followup-one' }),
}));
const execute = promisify(execFile);
const binary = process.env.SAM_CLI_CONTRACT_BINARY;
describe.skipIf(!binary)('Go CLI against Worker route/schema fixture', () => {
  let server: ReturnType<typeof serve>;
  let apiUrl: string;
  let folder: string;
  let launches = 0;
  let state = 'running';
  const receipts = new Map<string, Record<string, unknown>>();
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'sam-cli-contract-'));
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            const key = String(values[0]);
            if (sql.startsWith('INSERT')) {
              if (receipts.has(key)) return { meta: { changes: 0 } };
              receipts.set(key, { intent_hash: values[3], state: 'pending' });
            }
            if (sql.startsWith('UPDATE')) {
              const row = receipts.get(String(values[2]));
              if (row)
                Object.assign(row, {
                  state: 'completed',
                  response_json: values[0],
                  response_status: values[1],
                });
            }
            return { meta: { changes: 1 } };
          },
          first: async () => receipts.get(String(values[0])) ?? null,
        }),
      }),
    };
    const env = { DATABASE: database, DURABLE_PROMPT_DELIVERY_ENABLED: 'false' } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as 400)
        : c.json({ error: 'fixture_error', message: err.message }, 500)
    );
    app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
    const chat = new Hono<{ Bindings: Env }>();
    registerChatPromptRoute(chat);
    app.route('/api/projects/:projectId/sessions', chat);
    // Queue execution is a disposable compute boundary. Its real schema and
    // receipt middleware run, and no Task Runner/VM is provisioned.
    app.post(
      '/api/projects/:projectId/tasks/submit',
      jsonValidator(SubmitTaskSchema),
      cliOperationReceipt,
      (c) => {
        const body = c.req.valid('json');
        expect(body.agentProfileId).toBe(sol.id);
        expect(body.message).toContain('draft PR; do not merge');
        launches++;
        return c.json(
          { taskId: 'task-one', sessionId: 'session-one', branchName: 'fixture', status: 'queued' },
          202
        );
      }
    );
    app.get('/api/projects/:projectId/tasks/:taskId', (c) =>
      c.json({
        id: 'task-one',
        status: state,
        chatSessionId: 'session-one',
        outputPrUrl: state === 'completed' ? 'https://example.com/draft' : null,
      })
    );
    app.get('/api/projects/:projectId/sessions/:sessionId/messages', (c) =>
      c.json({
        messages: [
          { id: 'first', createdAt: 1, sequence: 1, role: 'user', content: 'synthetic only' },
        ],
        hasMore: false,
      })
    );
    server = serve({ fetch: (req) => app.fetch(req, env), port: 0 });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    await rm(folder, { recursive: true, force: true });
  });
  async function cli(args: string[]) {
    const { stdout, stderr } = await execute(binary!, [...args, '--project', project, '--json'], {
      env: {
        ...process.env,
        SAM_API_URL: apiUrl,
        SAM_SESSION_COOKIE: 'fixture=synthetic',
        SAM_CONFIG_DIR: folder,
      },
    });
    expect(stderr).toBe('');
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  it('resolves Sol, submits once, exports, follows up once, and observes final output', async () => {
    const prompt = 'Implement fixture; draft PR; do not merge';
    const first = await cli([
      'tasks',
      'submit',
      prompt,
      '--agent-profile',
      'Sol',
      '--idempotency-key',
      'task-key',
    ]);
    expect(
      await cli([
        'tasks',
        'submit',
        prompt,
        '--agent-profile',
        'Sol',
        '--idempotency-key',
        'task-key',
      ])
    ).toEqual(first);
    expect(launches).toBe(1);
    expect(await cli(['tasks', 'get', 'task-one'])).toMatchObject({ chatSessionId: 'session-one' });
    const output = join(folder, 'transcript.json');
    expect(await cli(['chat', 'export', 'session-one', '--output', output])).toMatchObject({
      complete: true,
      messageCount: 1,
    });
    expect(JSON.parse(await readFile(output, 'utf8')).messages).toHaveLength(1);
    const followup = await cli([
      'chat',
      'send',
      'session-one',
      'Continue the synthetic fixture',
      '--idempotency-key',
      'prompt-key',
    ]);
    expect(
      await cli([
        'chat',
        'send',
        'session-one',
        'Continue the synthetic fixture',
        '--idempotency-key',
        'prompt-key',
      ])
    ).toEqual(followup);
    state = 'completed';
    expect(await cli(['tasks', 'wait', 'task-one', '--timeout', '2s'])).toMatchObject({
      status: 'completed',
      outputPrUrl: 'https://example.com/draft',
    });
  });
});
