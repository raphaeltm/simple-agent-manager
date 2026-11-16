/**
 * Agent inbox tools (inbox slice D) through the real entry points (`.claude/rules/10`,
 * `.claude/rules/62`): the agent calls `inbox_write` / `inbox_read` on the real `/mcp` route (as
 * the listed domain groups, the way harnesses call them); the person reads and answers through
 * the real inbox routes behind the real auth middleware; answers reach the agent through the real
 * ProjectData Durable Object. Only the VM agent HTTP edge is stubbed.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { inboxRoutes, projectInboxRoutes } from '../../src/routes/inbox';
import { storeMcpToken } from '../../src/services/mcp-token';
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

const testEnv = env as unknown as Env;
const ORIGIN = `https://app.${testEnv.BASE_DOMAIN}`;
const fetchMock = vi.fn<typeof fetch>();

function browserApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('/api/*', requireAuth(), requireApproved());
  app.route('/api/inbox', inboxRoutes);
  app.route('/api/projects/:projectId/inbox', projectInboxRoutes);
  return app;
}

interface Seeded {
  projectId: string;
  ownerId: string;
  colleagueId: string;
  ownerCookie: string;
  colleagueCookie: string;
  chatSessionId: string;
  colleagueSessionId: string;
  workspaceId: string;
  agentSessionId: string;
  taskId: string;
  token: string;
  project: DurableObjectStub<ProjectData>;
}

async function seed(): Promise<Seeded> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerId = `inbox-owner-${suffix}`;
  const colleagueId = `inbox-colleague-${suffix}`;
  const installationId = `inbox-install-${suffix}`;
  const projectId = `inbox-project-${suffix}`;
  const nodeId = `inbox-node-${suffix}`;
  const workspaceId = `inbox-ws-${suffix}`;
  const agentSessionId = `inbox-agent-${suffix}`;
  const taskId = `inbox-task-${suffix}`;
  await seedUser(ownerId, { githubId: `gh-${ownerId}` });
  await seedUser(colleagueId, { githubId: `gh-${colleagueId}` });
  await seedInstallation(installationId, ownerId, { installationIdValue: `inst-${suffix}` });
  await seedProject(projectId, ownerId, installationId);
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'maintainer', 'active')`
  )
    .bind(projectId, colleagueId)
    .run();
  await seedNode(nodeId, ownerId);
  const project = testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  await project.ensureProjectId(projectId);
  const chatSessionId = await project.createSession(workspaceId, 'Inbox chat', taskId, ownerId);
  const colleagueSessionId = await project.createSession(
    null,
    'Colleague private chat',
    null,
    colleagueId
  );
  await seedWorkspace(workspaceId, nodeId, ownerId, {
    projectId,
    chatSessionId,
    status: 'running',
  });
  await seedTask(taskId, projectId, ownerId, {
    title: 'Inbox task',
    status: 'in_progress',
    taskMode: 'task',
    chatSessionId,
  });
  await seedAgentSession(agentSessionId, workspaceId, ownerId, { status: 'running' });
  const token = `inbox-token-${suffix}`;
  await storeMcpToken(testEnv.KV, token, {
    taskId,
    taskMode: 'task',
    projectId,
    userId: ownerId,
    workspaceId,
    chatSessionId,
    agentSessionId,
    createdAt: new Date().toISOString(),
  });
  return {
    projectId,
    ownerId,
    colleagueId,
    ownerCookie: await seedSignedInUser(ownerId),
    colleagueCookie: await seedSignedInUser(colleagueId),
    chatSessionId,
    colleagueSessionId,
    workspaceId,
    agentSessionId,
    taskId,
    token,
    project,
  };
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-1`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<{
    error?: unknown;
    result?: { content?: { text: string }[] };
  }>();
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

async function get<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
  const response = await browserApp().request(path, { headers: { Cookie: cookie } }, testEnv);
  return { status: response.status, body: (await response.json()) as T };
}

async function post(path: string, cookie: string, body: unknown = {}) {
  const response = await browserApp().request(
    path,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    },
    testEnv
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function callToolRaw(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-raw`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return response.json<{ error?: { message: string }; result?: unknown }>();
}

type ListBody = { items: { ref: string; kind: string; blocking: boolean; title: string }[] };

async function deliveriesFor(s: Seeded, askId: string) {
  const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
  return snapshot.deliveries.filter(
    (delivery: { id: string }) => delivery.id === `inbox-ask:${askId}`
  );
}

async function agentMessages(s: Seeded, needle: string) {
  const { messages } = await s.project.getMessages(s.chatSessionId, 100);
  return messages.filter((message: { content: string }) => message.content.includes(needle));
}

describe('agent inbox tools through the real entry points', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ask: filed, seen in the inbox and by inbox_read, answered from the inbox, the sleeping chat gets the answer once', async () => {
    const s = await seed();
    const filed = await callTool(s.token, 'inbox_write', {
      method: 'ask',
      title: 'Deploy the billing fix to staging first?',
      why: 'The migration touches invoices.',
      answer: 'confirm',
      groupKey: 'billing',
      idempotencyKey: 'billing-deploy',
    });
    const item = filed.inboxItem as {
      ref: string;
      id: string;
      sessionId: string;
      blocking: boolean;
    };
    expect(item).toMatchObject({ sessionId: s.chatSessionId, blocking: true });
    // A retried call files nothing new.
    const retried = await callTool(s.token, 'inbox_write', {
      method: 'ask',
      title: 'Deploy the billing fix to staging first?',
      answer: 'confirm',
      idempotencyKey: 'billing-deploy',
    });
    expect(retried).toMatchObject({ created: false, inboxItem: { ref: item.ref } });

    const inbox = await get<ListBody>(`/api/projects/${s.projectId}/inbox`, s.ownerCookie);
    expect(inbox.body.items).toEqual([
      expect.objectContaining({
        ref: item.ref,
        kind: 'question',
        blocking: true,
        title: 'Deploy the billing fix to staging first?',
      }),
    ]);
    const listed = await callTool(s.token, 'inbox_read', { method: 'list' });
    expect((listed.items as { ref: string }[]).map((entry) => entry.ref)).toEqual([item.ref]);
    // A blocking ask pauses the chat like request_human_input did.
    const sessions = await s.project.listSessions(null, 20, 0, null, null);
    expect(sessions.sessions.find((session) => session.id === s.chatSessionId)).toMatchObject({
      attention: { markerId: item.id, kind: 'needs_input' },
    });

    expect(await s.project.sleepSession(s.chatSessionId)).toBe(true);
    const answered = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}/answer`,
      s.ownerCookie,
      { answer: 'Yes' }
    );
    expect(answered.status).toBe(200);
    expect(await deliveriesFor(s, item.id)).toEqual([
      expect.objectContaining({ sourceKind: 'inbox_ask', sourceTaskId: s.taskId }),
    ]);
    const notices = await agentMessages(s, 'The person answered your question');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain('Yes');
    const read = await callTool(s.token, 'inbox_read', { method: 'get', ref: item.ref });
    expect(read.item).toMatchObject({ status: 'answered', answer: 'Yes', fromThisChat: true });
    // The same answer again is settled, not delivered twice.
    await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}/answer`,
      s.ownerCookie,
      { answer: 'Yes' }
    );
    expect(await deliveriesFor(s, item.id)).toHaveLength(1);
  });

  it('review: non-blocking, does not pause the chat, "Looks good" reaches the agent once', async () => {
    const s = await seed();
    const filed = await callTool(s.token, 'inbox_write', {
      method: 'review',
      title: 'Please review the pricing page',
      links: [{ kind: 'chat', id: s.chatSessionId, label: 'This chat' }],
    });
    const item = filed.inboxItem as { ref: string; id: string; blocking: boolean };
    expect(item.blocking).toBe(false);
    const reviews = await get<ListBody>(
      `/api/projects/${s.projectId}/inbox?filter=reviews`,
      s.ownerCookie
    );
    expect(reviews.body.items.map((entry) => entry.ref)).toEqual([item.ref]);
    const sessions = await s.project.listSessions(null, 20, 0, null, null);
    expect(
      sessions.sessions.find((session) => session.id === s.chatSessionId)?.attention ?? null
    ).toBeNull();

    const answered = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}/answer`,
      s.ownerCookie,
      {}
    );
    expect(answered.body).toMatchObject({ outcome: 'answered', agentNotified: true });
    expect(await agentMessages(s, 'it looks good')).toHaveLength(1);
    expect(await deliveriesFor(s, item.id)).toHaveLength(1);
  });

  it('archive: the agent is told the person will not act, once', async () => {
    const s = await seed();
    const filed = await callTool(s.token, 'inbox_write', {
      method: 'ask',
      title: 'Which colour for the logo?',
      options: ['Green', 'Blue'],
      blocking: false,
    });
    const item = filed.inboxItem as { ref: string; id: string };
    const archived = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}/archive`,
      s.ownerCookie
    );
    expect(archived.body).toMatchObject({ outcome: 'archived', agentNotified: true });
    expect(await agentMessages(s, 'will not act on it')).toHaveLength(1);
    const read = await callTool(s.token, 'inbox_read', { method: 'get', ref: item.ref });
    expect(read.item).toMatchObject({ status: 'archived' });
  });

  it('cancel: the agent closes its own item; it leaves the inbox and no notice is sent', async () => {
    const s = await seed();
    const filed = await callTool(s.token, 'inbox_write', {
      method: 'ask',
      title: 'Should I use the old API?',
    });
    const item = filed.inboxItem as { ref: string; id: string };
    const cancelled = await callTool(s.token, 'inbox_write', {
      method: 'cancel',
      ref: item.ref,
      reason: 'The docs answer it',
    });
    expect(cancelled).toEqual({ ref: item.ref, status: 'cancelled' });
    const inbox = await get<ListBody>(`/api/projects/${s.projectId}/inbox`, s.ownerCookie);
    expect(inbox.body.items.map((entry) => entry.ref)).not.toContain(item.ref);
    expect(await deliveriesFor(s, item.id)).toEqual([]);
    // The chat no longer reads as paused on it.
    const sessions = await s.project.listSessions(null, 20, 0, null, null);
    expect(
      sessions.sessions.find((session) => session.id === s.chatSessionId)?.attention ?? null
    ).toBeNull();
    const again = await callToolRaw(s.token, 'inbox_write', {
      method: 'cancel',
      ref: item.ref,
      reason: 'again',
    });
    expect(again.error?.message).toContain('already cancelled');
    // A late answer from the person loses.
    const late = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}/answer`,
      s.ownerCookie,
      { answer: 'Yes' }
    );
    expect(late.status).toBe(409);
  });

  it('get_instructions tells every task-backed session to use the inbox, in task and conversation mode', async () => {
    const s = await seed();
    const conversationToken = `${s.token}-conversation`;
    await testEnv.DATABASE.prepare(`UPDATE tasks SET task_mode = 'conversation' WHERE id = ?`)
      .bind(s.taskId)
      .run();
    await storeMcpToken(testEnv.KV, conversationToken, {
      taskId: s.taskId,
      taskMode: 'conversation',
      projectId: s.projectId,
      userId: s.ownerId,
      workspaceId: s.workspaceId,
      chatSessionId: s.chatSessionId,
      agentSessionId: s.agentSessionId,
      createdAt: new Date().toISOString(),
    });
    for (const token of [s.token, conversationToken]) {
      const res = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'gi',
          method: 'tools/call',
          params: { name: 'get_instructions', arguments: {} },
        }),
      });
      const payload = await res.json<{ result: { content: { text: string }[] } }>();
      const lines = JSON.parse(payload.result.content[0]!.text).instructions as string[];
      expect(
        lines.filter((line) =>
          line.startsWith('People do not watch chats; they read their inbox.')
        ),
        token
      ).toHaveLength(1);
    }
    const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'gi',
        method: 'tools/call',
        params: { name: 'get_instructions', arguments: {} },
      }),
    });
    const body = await response.json<{ result: { content: { text: string }[] } }>();
    const instructions = JSON.parse(body.result.content[0]!.text).instructions as string[];
    expect(
      instructions.some((line) =>
        line.startsWith('People do not watch chats; they read their inbox.')
      )
    ).toBe(true);
  });
});
