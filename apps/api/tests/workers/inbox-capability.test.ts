/**
 * Inbox capability tests through the real entry points (`.claude/rules/10`, `.claude/rules/62`):
 * an agent files through the real `/mcp` route (`request_human_input`, `request_secret`) or the
 * internal `createAsk` operation; the person reads the real inbox routes behind the real auth
 * middleware; archiving goes through the real route into the real ProjectData Durable Object and
 * D1. Only the VM agent HTTP edge (the live-agent prompt) is stubbed, and it is asserted on.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { webOperationContext } from '../../src/operation-ports';
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

/** The summary index is written on a debounce; flush it the way the timer would. */
async function syncSummaries(project: DurableObjectStub<ProjectData>) {
  await runInDurableObject(project, async (instance) => {
    await (instance as unknown as { runSummarySyncLocked(): Promise<void> }).runSummarySyncLocked();
  });
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

type ListBody = { items: { ref: string; kind: string; canAct: boolean; projectId: string }[] };

describe('inbox capability through the real entry points', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a request_human_input question is one asks row that reaches the right inbox; archiving tells the agent', async () => {
    const s = await seed();
    const result = await callTool(s.token, 'request_human_input', {
      context: 'Should I deploy the billing fix to staging first?',
      category: 'decision',
      options: ['Staging first', 'Straight to prod'],
    });
    const askId = (result.humanInputRequest as { id: string }).id;
    // One record: an asks row, no attention marker, no attention_json copy.
    const row = await testEnv.DATABASE.prepare(
      'SELECT kind, status, project_id, source_session_id, blocking FROM asks WHERE id = ?'
    )
      .bind(askId)
      .first();
    expect(row).toEqual({
      kind: 'question',
      status: 'open',
      project_id: s.projectId,
      source_session_id: s.chatSessionId,
      blocking: 1,
    });
    expect(await s.project.listActiveAttentionMarkers(s.chatSessionId)).toEqual([]);
    await syncSummaries(s.project);
    const summary = await testEnv.DATABASE.prepare(
      'SELECT attention_json FROM session_summaries WHERE id = ?'
    )
      .bind(s.chatSessionId)
      .first<{ attention_json: string | null }>();
    expect(summary?.attention_json ?? null).toBeNull();
    // The chat's own reads still show it as the chat's question (ProjectData session read).
    expect(await s.project.getSession(s.chatSessionId)).toMatchObject({
      attention: { markerId: askId, kind: 'needs_input', source: 'request_human_input' },
    });

    const ref = `ask:${askId}`;
    const owner = await get<ListBody>('/api/inbox', s.ownerCookie);
    const mine = owner.body.items.filter((item) => item.projectId === s.projectId);
    expect(mine.map((item) => item.ref)).toEqual([ref]);
    expect(mine[0]).toMatchObject({ kind: 'question', canAct: true });
    const colleague = await get<ListBody>('/api/inbox', s.colleagueCookie);
    expect(colleague.body.items.map((item) => item.ref)).not.toContain(ref);
    const count = await get<{ needsYou: number; blocking: number }>(
      `/api/projects/${s.projectId}/inbox/count`,
      s.ownerCookie
    );
    expect(count.body).toEqual({ needsYou: 1, blocking: 1 });

    // The agent ends its turn and the chat sleeps; archiving queues one wake-capable prompt.
    expect(await s.project.sleepSession(s.chatSessionId)).toBe(true);
    const archived = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/archive`,
      s.ownerCookie
    );
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ outcome: 'archived', agentNotified: true });
    const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
    const notices = snapshot.deliveries.filter(
      (delivery: { id: string }) => delivery.id === `inbox-ask:${askId}`
    );
    expect(notices).toEqual([
      expect.objectContaining({ sourceKind: 'inbox_ask', sourceTaskId: s.taskId }),
    ]);
    const { messages } = await s.project.getMessages(s.chatSessionId, 50);
    expect(
      messages.filter((message: { content: string }) =>
        message.content.includes('archived your question')
      )
    ).toHaveLength(1);
    // The item leaves the inbox; a late answer loses.
    const after = await get<ListBody>('/api/inbox', s.ownerCookie);
    expect(after.body.items.map((entry) => entry.ref)).not.toContain(ref);
    const late = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/answer`,
      s.ownerCookie,
      { answer: 'Staging first' }
    );
    expect(late.status).toBe(409);
  });

  it('answering an asks question of a sleeping chat queues the answer once as a wake', async () => {
    const s = await seed();
    const result = await callTool(s.token, 'request_human_input', {
      context: 'Ship the billing fix now?',
      options: ['Yes', 'No'],
    });
    const askId = (result.humanInputRequest as { id: string }).id;
    expect(await s.project.sleepSession(s.chatSessionId)).toBe(true);
    // The chat card path and the inbox path meet at the same compare-and-set.
    const [inbox, card] = await Promise.all([
      post(
        `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(`ask:${askId}`)}/answer`,
        s.ownerCookie,
        { answer: 'Yes' }
      ),
      SELF.fetch(
        `https://api.${testEnv.BASE_DOMAIN}/api/projects/${s.projectId}/sessions/${s.chatSessionId}/attention/${askId}/resolve`,
        {
          method: 'POST',
          headers: { Cookie: s.ownerCookie, 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ answer: 'No' }),
        }
      ),
    ]);
    const statuses = [inbox.status, card.status].sort();
    expect(statuses).toEqual([200, 409]);
    const row = await testEnv.DATABASE.prepare(
      'SELECT status, answer_json, notified_at FROM asks WHERE id = ?'
    )
      .bind(askId)
      .first<{ status: string; answer_json: string; notified_at: number | null }>();
    expect(row?.status).toBe('answered');
    expect(row?.notified_at).not.toBeNull();
    const winner = (JSON.parse(row!.answer_json) as { text: string }).text;
    const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
    expect(
      snapshot.deliveries.filter((delivery: { id: string }) => delivery.id === `inbox-ask:${askId}`)
    ).toEqual([expect.objectContaining({ sourceKind: 'inbox_ask', sourceTaskId: s.taskId })]);
    const { messages } = await s.project.getMessages(s.chatSessionId, 50);
    const answers = messages.filter((message: { content: string }) =>
      message.content.startsWith('The person answered your question')
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toContain(winner);
    // The chat card reads the settled question.
    const read = await SELF.fetch(
      `https://api.${testEnv.BASE_DOMAIN}/api/projects/${s.projectId}/sessions/${s.chatSessionId}/attention/${askId}`,
      { headers: { Cookie: s.ownerCookie } }
    );
    expect(await read.json()).toMatchObject({
      request: { id: askId, resolvedAnswer: winner, canAnswer: false },
    });
  });

  // Overlap (slice G): a question asked before the deploy is still a ProjectData marker and stays
  // answerable and archivable through its own path until it resolves or expires.
  it('a marker-era question reaches the right inbox and archiving tells the agent', async () => {
    const s = await seed();
    await s.project.createAttentionMarker({
      sessionId: s.chatSessionId,
      taskId: s.taskId,
      workspaceId: s.workspaceId,
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Should I deploy the billing fix to staging first?',
      metadata: JSON.stringify({
        category: 'decision',
        options: ['Staging first', 'Straight to prod'],
      }),
      expiresAt: Date.now() + 3_600_000,
    });
    // The colleague's private chat also has an open question; it must not reach the owner.
    await s.project.createAttentionMarker({
      sessionId: s.colleagueSessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Colleague-only question',
      metadata: null,
      expiresAt: null,
    });
    await syncSummaries(s.project);

    const owner = await get<ListBody>('/api/inbox', s.ownerCookie);
    expect(owner.status).toBe(200);
    const mine = owner.body.items.filter((item) => item.projectId === s.projectId);
    expect(mine).toHaveLength(1);
    const ref = mine[0]!.ref;
    expect(ref).toMatch(new RegExp(`^attention:${s.chatSessionId}:`));
    expect(mine[0]).toMatchObject({ kind: 'question', canAct: true });
    // Owner control on the other side: the colleague sees their own question, not the owner's.
    const colleague = await get<ListBody>('/api/inbox', s.colleagueCookie);
    expect(colleague.body.items.map((item) => item.ref)).toEqual([
      expect.stringMatching(new RegExp(`^attention:${s.colleagueSessionId}:`)),
    ]);
    const count = await get<{ needsYou: number; blocking: number }>(
      `/api/projects/${s.projectId}/inbox/count`,
      s.ownerCookie
    );
    expect(count.body).toEqual({ needsYou: 1, blocking: 1 });

    // The agent keeps working after asking; the context read shows it on the "since" side.
    await s.project.persistMessageBatch(s.chatSessionId, [
      {
        messageId: 'after-ask-1',
        role: 'assistant',
        content: 'While waiting I checked the staging config.',
        toolMetadata: null,
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
    ]);
    const item = await get<{ item: { ref: string }; context: { since: unknown } | null }>(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}?context=true`,
      s.ownerCookie
    );
    expect(item.status).toBe(200);
    expect(item.body.context?.since).toMatchObject({
      messages: [
        expect.objectContaining({
          role: 'assistant',
          content: 'While waiting I checked the staging config.',
        }),
      ],
      truncated: false,
    });

    // Writes only from the app's own pages: another origin is refused and nothing changes.
    const foreign = await browserApp().request(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/archive`,
      {
        method: 'POST',
        headers: {
          Cookie: s.ownerCookie,
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: '{}',
      },
      testEnv
    );
    expect(foreign.status).toBe(403);
    const plain = await browserApp().request(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/archive`,
      {
        method: 'POST',
        headers: { Cookie: s.ownerCookie, 'Content-Type': 'text/plain', Origin: ORIGIN },
        body: '{}',
      },
      testEnv
    );
    expect(plain.status).toBe(415);

    // Archive: the live agent receives the "will not act" prompt, then the marker resolves.
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: 'accepted' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const archived = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/archive`,
      s.ownerCookie
    );
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ outcome: 'archived', agentNotified: true });
    const prompt = fetchMock.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.url).includes(
        `/workspaces/${s.workspaceId}/agent-sessions/${s.agentSessionId}/prompt`
      )
    );
    expect(prompt).toBeTruthy();
    expect(String(prompt?.[1]?.body)).toContain('will not act on it');

    const markerId = ref.split(':')[2]!;
    const { marker } = await s.project.getAttentionRequest(s.chatSessionId, markerId, s.ownerId);
    expect(marker).toMatchObject({ resolvedReason: 'archived', resolvedAnswer: null });
    expect(marker?.resolvedAt).not.toBeNull();
    // The item leaves the inbox once the index catches up.
    await syncSummaries(s.project);
    const after = await get<ListBody>('/api/inbox', s.ownerCookie);
    expect(after.body.items.map((entry) => entry.ref)).not.toContain(ref);
    // An answer after the archive loses.
    const late = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/answer`,
      s.ownerCookie,
      { answer: 'Staging first' }
    );
    expect(late.status).toBe(409);
  });

  it('a secret request archived through the inbox is declined and the agent notified', async () => {
    const s = await seed();
    const created = await callTool(s.token, 'request_secret', {
      name: 'STRIPE_API_KEY',
      reason: 'Create a webhook endpoint',
    });
    const requestId = (created.secretRequest as { id: string }).id;
    const ref = `secret:${requestId}`;
    const list = await get<ListBody>(`/api/projects/${s.projectId}/inbox`, s.ownerCookie);
    expect(list.body.items.map((item) => item.ref)).toContain(ref);
    // A member who did not ask does not get it in their list.
    const colleague = await get<ListBody>(`/api/projects/${s.projectId}/inbox`, s.colleagueCookie);
    expect(colleague.body.items.map((item) => item.ref)).not.toContain(ref);

    const archived = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}/archive`,
      s.ownerCookie
    );
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ outcome: 'declined', agentNotified: true });
    const row = await testEnv.DATABASE.prepare(
      'SELECT status, notified_at FROM runtime_secret_requests WHERE id = ?'
    )
      .bind(requestId)
      .first<{ status: string; notified_at: number | null }>();
    expect(row?.status).toBe('declined');
    expect(row?.notified_at).not.toBeNull();
    const after = await get<ListBody>(`/api/projects/${s.projectId}/inbox`, s.ownerCookie);
    expect(after.body.items.map((item) => item.ref)).not.toContain(ref);
  });

  it('an ask filed through the internal operation lists, archives and queues the agent notice', async () => {
    const s = await seed();
    const { samInboxAskCreate } = await import('@simple-agent-manager/operations');
    const ctx = webOperationContext(
      { env: testEnv, req: { header: () => undefined }, executionCtx: { waitUntil: () => {} } },
      s.ownerId
    );
    const created = await samInboxAskCreate.run(ctx, {
      projectId: s.projectId,
      assigneeUserId: s.ownerId,
      kind: 'review',
      title: 'Review the billing migration plan.',
      body: 'It touches the invoices table.',
      sourceSessionId: s.chatSessionId,
      sourceTaskId: s.taskId,
    });
    const list = await get<ListBody>('/api/inbox?filter=reviews', s.ownerCookie);
    expect(list.body.items.map((item) => item.ref)).toContain(created.ref);
    const archived = await post(
      `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(created.ref)}/archive`,
      s.ownerCookie
    );
    expect(archived.body).toMatchObject({ outcome: 'archived', agentNotified: true });
    const row = await testEnv.DATABASE.prepare('SELECT status, notified_at FROM asks WHERE id = ?')
      .bind(created.id)
      .first<{ status: string; notified_at: number | null }>();
    expect(row).toMatchObject({ status: 'archived' });
    expect(row?.notified_at).not.toBeNull();
    const delivered = await runInDurableObject(s.project, async (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT source_kind, content FROM session_inbox WHERE target_session_id = ? AND source_kind = 'inbox_ask'`,
          s.chatSessionId
        )
        .toArray()
    );
    expect(delivered).toHaveLength(1);
    expect(String(delivered[0]?.content)).toContain('will not act on it');
    const archivedList = await get<ListBody>('/api/inbox?filter=archived', s.ownerCookie);
    expect(archivedList.body.items.map((item) => item.ref)).toContain(created.ref);
  });
});
