import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InteractionStore } from '../../src/durable-objects/interaction-store';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import { acpInteractionCallbackRoute } from '../../src/routes/projects/acp-interaction-callback';
import { signCallbackToken } from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const fetchMock = vi.fn<typeof fetch>();

const testEnv = env as unknown as Env;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function callbackApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects', acpInteractionCallbackRoute);
  return app;
}

function browserApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('/api/projects/*', requireAuth(), requireApproved());
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

describe('ACP interaction cross-boundary vertical slice', () => {
  beforeEach(() => {
    (testEnv as unknown as Record<string, string>).ACP_INTERACTIONS_ENABLED = 'true';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete (testEnv as unknown as Record<string, string>).ACP_INTERACTIONS_ENABLED;
    delete (testEnv as unknown as Record<string, string>).ACP_INTERACTION_FORMS_ENABLED;
    vi.unstubAllGlobals();
  });

  it('commits callback creation before a browser answer reaches the VM boundary', async () => {
    const suffix = crypto.randomUUID();
    const userId = `vertical-user-${suffix}`;
    const installationId = `vertical-installation-${suffix}`;
    const projectId = `vertical-project-${suffix}`;
    const nodeId = `vertical-node-${suffix}`;
    const workspaceId = `vertical-workspace-${suffix}`;
    const agentSessionId = `vertical-agent-${suffix}`;
    const interactionId = crypto.randomUUID();
    const generation = crypto.randomUUID();

    await seedUser(userId);
    await seedInstallation(installationId, userId);
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId);
    const chatSessionId = await projectDataService.createSession(
      testEnv,
      projectId,
      workspaceId,
      'ACP interaction vertical slice',
      null,
      userId
    );
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      chatSessionId,
      status: 'running',
    });
    await seedAgentSession(agentSessionId, workspaceId, userId, { status: 'running' });

    const callbackToken = await signCallbackToken(workspaceId, testEnv);
    const created = await callbackApp().request(
      `/api/projects/${projectId}/workspaces/${workspaceId}/acp-interactions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${callbackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          interactionId,
          generation,
          runtimeIdentity: 'runtime-vertical-1',
          agentSessionId,
          kind: 'permission',
          payloadHash: 'a'.repeat(64),
          detail: { permissionName: 'VERTICAL_SECRET', options: [{ id: 'allow', kind: 'allow_once', name: 'Allow once' }] },
          safeSummary: { toolCallId: 'tool-vertical', optionCount: 1 },
          deadlineAt: Date.now() + 60_000,
        }),
      },
      testEnv
    );
    expect(created.status).toBe(201);

    const store = testEnv.INTERACTION_STORE.get(
      testEnv.INTERACTION_STORE.idFromName(`${projectId}/${chatSessionId}`)
    ) as DurableObjectStub<InteractionStore>;
    await expect(store.snapshot(null)).resolves.toMatchObject({
      pending: [expect.objectContaining({ interactionId, state: 'pending' })],
    });

    const rejectedCallbackBearer = await browserApp().request(
      `/api/projects/${projectId}/sessions/${chatSessionId}/interactions/${interactionId}/answer`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${callbackToken}`,
          'Content-Type': 'application/json',
          Origin: 'https://app.test.example.com',
        },
        body: JSON.stringify({
          answerKey: 'callback-must-not-answer',
          decision: { kind: 'selected_option', optionId: 'allow', answerHash: 'c'.repeat(64) },
        }),
      },
      testEnv
    );
    expect(rejectedCallbackBearer.status).toBe(401);
    await expect(store.snapshot(null)).resolves.toMatchObject({
      pending: [expect.objectContaining({ interactionId, state: 'pending' })],
    });

    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      const payload = url.endsWith('/agent-capabilities')
        ? {
            protocolVersion: 1,
            runtimeIdentity: 'runtime-vertical-1',
            promptReceipts: {
              supported: true,
              lookup: true,
              states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'],
            },
            interactions: {
              supported: true,
              version: 1,
              answerEndpoint: true,
              permissionBridge: true,
            },
            checkpointRollover: {
              supported: true,
              automatic: false,
              states: [],
              defaultGraceMs: 30_000,
              maxGraceMs: 120_000,
              operationTimeoutMs: 120_000,
            },
          }
        : {
            status: 'consumed',
            interactionId,
            generation,
            runtimeIdentity: 'runtime-vertical-1',
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const sessionCookie = await seedSignedInUser(userId);
    const answer = await browserApp().request(
      `/api/projects/${projectId}/sessions/${chatSessionId}/interactions/${interactionId}/answer`,
      {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
          Origin: 'https://app.test.example.com',
        },
        body: JSON.stringify({
          answerKey: 'vertical-answer-key',
          decision: { kind: 'selected_option', optionId: 'allow', answerHash: 'b'.repeat(64) },
        }),
      },
      testEnv
    );
    expect(answer.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [answerUrl, answerInit] = fetchMock.mock.calls[1];
    expect(typeof answerUrl === 'string' ? answerUrl : answerUrl.url).toContain(
      `/workspaces/${workspaceId}/agent-sessions/${agentSessionId}/interactions/${interactionId}/answer`
    );
    expect(answerInit).toMatchObject({
      method: 'POST',
      body: expect.stringContaining(`"interactionId":"${interactionId}"`),
    });
    await expect(store.snapshot(null)).resolves.toMatchObject({
      pending: [],
      settled: [expect.objectContaining({ interactionId, state: 'delivery_confirmed' })],
    });

    await runInDurableObject(store, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM outbox`);
      await state.storage.deleteAlarm();
    });
  });

  it('creates a form only for the workspace-linked conversation task', async () => {
    const suffix = crypto.randomUUID();
    const userId = `form-user-${suffix}`;
    const installationId = `form-installation-${suffix}`;
    const projectId = `form-project-${suffix}`;
    const nodeId = `form-node-${suffix}`;
    const workspaceId = `form-workspace-${suffix}`;
    const agentSessionId = `form-agent-${suffix}`;
    const formGeneration = crypto.randomUUID();
    await seedUser(userId);
    await seedInstallation(installationId, userId);
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId);
    const chatSessionId = await projectDataService.createSession(testEnv, projectId, workspaceId, 'Form mode', null, userId);
    await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId, status: 'running' });
    await seedAgentSession(agentSessionId, workspaceId, userId, { status: 'running' });
    await seedTask(`form-task-${suffix}`, projectId, userId, { workspaceId, chatSessionId, taskMode: 'task' });
    (testEnv as unknown as Record<string, string>).ACP_INTERACTION_FORMS_ENABLED = 'true';
    const callbackToken = await signCallbackToken(workspaceId, testEnv);
    const request = () => callbackApp().request(`/api/projects/${projectId}/workspaces/${workspaceId}/acp-interactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${callbackToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, interactionId: crypto.randomUUID(), generation: formGeneration,
        runtimeIdentity: 'runtime-form-1', agentSessionId, kind: 'form', payloadHash: 'a'.repeat(64),
        detail: { message: 'Which path?', schema: { type: 'object', properties: {
          question: { type: 'string', enum: ['Fast', 'Slow'] },
        }, required: ['question'] } }, safeSummary: { optionCount: 0 }, deadlineAt: Date.now() + 60_000 }),
    }, testEnv);
    expect((await request()).status).toBe(409);
    await testEnv.DATABASE.prepare(`UPDATE tasks SET task_mode = 'conversation' WHERE workspace_id = ?`).bind(workspaceId).run();
    const created = await request();
    expect(created.status).toBe(201);
    const result = await created.json() as { summary: { interactionId: string } };
    const interactionId = result.summary.interactionId;
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      return new Response(JSON.stringify(url.endsWith('/agent-capabilities') ? {
        protocolVersion: 1, runtimeIdentity: 'runtime-form-1',
        promptReceipts: { supported: true, lookup: true,
          states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'] },
        checkpointRollover: { supported: true, automatic: false, states: [],
          defaultGraceMs: 30_000, maxGraceMs: 120_000, operationTimeoutMs: 120_000 },
        interactions: {
          supported: true, version: 1, answerEndpoint: true, permissionBridge: true, formBridge: true,
        },
      } : { status: 'consumed', interactionId, generation: formGeneration, runtimeIdentity: 'runtime-form-1' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const cookie = await seedSignedInUser(userId);
    const answer = await browserApp().request(
      `/api/projects/${projectId}/sessions/${chatSessionId}/interactions/${interactionId}/answer`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://app.test.example.com' },
        body: JSON.stringify({ answerKey: 'form-vertical-answer', decision: { kind: 'accepted',
          content: { question: 'Fast' }, answerHash: await sha256Hex('{"question":"Fast"}') } }),
      }, testEnv
    );
    expect(answer.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, delivery] = fetchMock.mock.calls[1];
    expect(delivery).toMatchObject({ method: 'POST', body: expect.stringContaining('"content":{"question":"Fast"}') });
    const store = testEnv.INTERACTION_STORE.get(
      testEnv.INTERACTION_STORE.idFromName(`${projectId}/${chatSessionId}`)
    ) as DurableObjectStub<InteractionStore>;
    expect((await store.snapshot(null)).settled).toEqual([expect.objectContaining({ interactionId, state: 'delivery_confirmed' })]);
    await runInDurableObject(store, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM outbox`);
      await state.storage.deleteAlarm();
    });
  });
});
