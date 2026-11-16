/**
 * Inbox capability tests through the real entry points (`.claude/rules/10`, `.claude/rules/62`):
 * an agent files through the real `/mcp` route (`request_human_input`, `request_secret`) or the
 * internal `createAsk` operation; the person reads the real inbox routes behind the real auth
 * middleware; archiving goes through the real route into the real ProjectData Durable Object and
 * D1. Only the VM agent HTTP edge (the live-agent prompt) is stubbed, and it is asserted on.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { webOperationContext } from '../../src/operation-ports';
import { runInboxAskSweep } from '../../src/services/inbox/sweep';
import {
  browserApp,
  callTool,
  fetchMock,
  get,
  ORIGIN,
  post,
  seed,
  type Seeded,
  testEnv,
} from './helpers/inbox-harness';

/** The summary index is written on a debounce; flush it the way the timer would. */
async function syncSummaries(project: DurableObjectStub<ProjectData>) {
  await runInDurableObject(project, async (instance) => {
    await (instance as unknown as { runSummarySyncLocked(): Promise<void> }).runSummarySyncLocked();
  });
}

type ListBody = { items: { ref: string; kind: string; canAct: boolean; projectId: string }[] };

describe('inbox capability through the real entry points', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The VM edge is stubbed for every test (task-run stops, live prompts); tests that assert on
    // it set their own responses.
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
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
    // The chat list's ProjectData read still shows it as the chat's question.
    const listed = await s.project.listSessions(null, 20, 0, null, null);
    expect(listed.sessions.find((session) => session.id === s.chatSessionId)).toMatchObject({
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

  // Inbox slice G: what a question marker did inside ProjectData, through the real Durable Object.
  it('a system error item: the route rejects a bad action, and an agent sign-in session can neither fix nor archive it', async () => {
    const s = await seed();
    const askId = `err-${crypto.randomUUID()}`;
    const now = Date.now();
    await testEnv.DATABASE.prepare(
      `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, blocking, title,
          body_md, answer_spec_json, links_json, source_session_id, source_task_id, dedupe_key,
          status, created_at, updated_at)
       VALUES (?, ?, 'user', ?, 'error', 0, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
      .bind(
        askId,
        s.projectId,
        s.ownerId,
        "“Ship” couldn't start",
        'The agent could not complete this request.',
        JSON.stringify({ type: 'actions', actions: [{ id: 'retry', label: 'Retry' }] }),
        JSON.stringify([{ kind: 'task', id: s.taskId, label: null }]),
        s.chatSessionId,
        s.taskId,
        `error:task:${s.taskId}`,
        now,
        now
      )
      .run();
    const base = `/api/projects/${s.projectId}/inbox/items/ask:${askId}`;

    // The person's own session: an unknown action is refused by the route's schema.
    expect((await post(`${base}/answer`, s.ownerCookie, { action: 'reboot' })).status).toBe(400);

    // The same person through an agent sign-in session (workload identity).
    const agentCookie = await seedSignedInUser(s.ownerId);
    const agentToken = agentCookie.split('=')[1]!.split('.')[0]!;
    await testEnv.DATABASE.prepare('UPDATE sessions SET hard_expires_at = ? WHERE token = ?')
      .bind(now + 3_600_000, agentToken)
      .run();
    expect((await post(`${base}/answer`, agentCookie, { action: 'retry' })).status).toBe(403);
    expect((await post(`${base}/archive`, agentCookie)).status).toBe(403);
    const row = await testEnv.DATABASE.prepare('SELECT status FROM asks WHERE id = ?')
      .bind(askId)
      .first<{ status: string }>();
    expect(row?.status).toBe('open');

    // Control: the person's own session archives it.
    const archived = await post(`${base}/archive`, s.ownerCookie);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ outcome: 'archived', agentNotified: false });
  });

  describe('asks-era questions inside ProjectData', () => {
    // The expiry path stops the task run on its VM; stub that edge and keep it off the network.
    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    });

    async function ask(s: Seeded, context = 'Ship the billing fix now?') {
      const result = await callTool(s.token, 'request_human_input', { context });
      return (result.humanInputRequest as { id: string }).id;
    }
    async function askRow(id: string) {
      return testEnv.DATABASE.prepare(
        'SELECT status, answer_json, notified_at, resolved_at FROM asks WHERE id = ?'
      )
        .bind(id)
        .first<{
          status: string;
          answer_json: string | null;
          notified_at: number | null;
          resolved_at: number | null;
        }>();
    }
    async function taskStatus(taskId: string) {
      return testEnv.DATABASE.prepare('SELECT status, error_message FROM tasks WHERE id = ?')
        .bind(taskId)
        .first<{ status: string; error_message: string | null }>();
    }

    it('another member cannot read-to-answer, answer or archive the owner’s question (attack + owner control)', async () => {
      const s = await seed();
      const id = await ask(s);
      const card = (cookie: string, path = '') =>
        SELF.fetch(
          `https://api.${testEnv.BASE_DOMAIN}/api/projects/${s.projectId}/sessions/${s.chatSessionId}/attention/${id}${path}`,
          path
            ? {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
                body: JSON.stringify({ answer: 'Yes' }),
              }
            : { headers: { Cookie: cookie } }
        );
      // A member who is not the chat's owner (and has no grant) reads it without answer controls.
      const read = await card(s.colleagueCookie);
      if (read.status === 200) {
        expect((await read.json<{ request: { canAnswer: boolean } }>()).request.canAnswer).toBe(
          false
        );
      } else {
        expect(read.status).toBe(404);
      }
      expect((await card(s.colleagueCookie, '/resolve')).status).toBe(403);
      const ref = encodeURIComponent(`ask:${id}`);
      expect(
        (
          await post(`/api/projects/${s.projectId}/inbox/items/${ref}/answer`, s.colleagueCookie, {
            answer: 'Yes',
          })
        ).status
      ).toBe(404);
      expect(
        (await post(`/api/projects/${s.projectId}/inbox/items/${ref}/archive`, s.colleagueCookie))
          .status
      ).toBe(404);
      expect((await askRow(id))?.status).toBe('open');
      const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
      expect(
        snapshot.deliveries.filter((delivery: { id: string }) => delivery.id === `inbox-ask:${id}`)
      ).toEqual([]);
      // Owner control.
      expect((await card(s.ownerCookie, '/resolve')).status).toBe(200);
      expect((await askRow(id))?.status).toBe('answered');
    });

    it('a retried answer notice does not reach the agent twice', async () => {
      const s = await seed();
      const id = await ask(s);
      const response = await post(
        `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(`ask:${id}`)}/answer`,
        s.ownerCookie,
        { answer: 'Yes' }
      );
      expect(response.status).toBe(200);
      // As if recording the notice had failed after it was queued: the sweep retries it.
      const resolvedAt = (await askRow(id))?.resolved_at ?? Date.now();
      await testEnv.DATABASE.prepare('UPDATE asks SET notified_at = NULL WHERE id = ?')
        .bind(id)
        .run();
      await runInboxAskSweep(testEnv, resolvedAt + 2 * 60_000);
      expect((await askRow(id))?.notified_at).not.toBeNull();
      const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
      expect(
        snapshot.deliveries.filter((delivery: { id: string }) => delivery.id === `inbox-ask:${id}`)
      ).toHaveLength(1);
      const { messages } = await s.project.getMessages(s.chatSessionId, 50);
      expect(
        messages.filter((message: { content: string }) =>
          message.content.startsWith('The person answered your question')
        )
      ).toHaveLength(1);
    });

    it('the ProjectData reads behind team status show the question', async () => {
      const s = await seed();
      const id = await ask(s);
      const [session] = await s.project.getSessionsByTaskIds([s.taskId]);
      expect(session).toMatchObject({ attention: { markerId: id, kind: 'needs_input' } });
    });

    it('a person’s chat message answers the chat’s open questions, and only those', async () => {
      const s = await seed();
      const first = await ask(s);
      const second = await ask(s, 'And the docs too?');
      // A question in another chat of this project (foreign projects: real-SQL unit test).
      await testEnv.DATABASE.prepare(
        `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, blocking, title,
            source_session_id, status, created_at, updated_at)
         VALUES ('other-chat-q', ?, 'user', ?, 'question', 1, 'y', ?, 'open', 1, 1)`
      )
        .bind(s.projectId, s.ownerId, s.colleagueSessionId)
        .run();
      await s.project.persistMessageBatch(s.chatSessionId, [
        {
          messageId: `typed-${crypto.randomUUID()}`,
          role: 'user',
          content: 'Yes, ship it, and the docs.',
          toolMetadata: null,
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ]);
      for (const id of [first, second]) {
        const row = await askRow(id);
        expect(row?.status).toBe('answered');
        expect(row?.notified_at).not.toBeNull();
      }
      expect((await askRow('other-chat-q'))?.status).toBe('open');
      // Liveness: the chat itself is no longer waiting on a person.
      const listed = await s.project.listSessions(null, 20, 0, null, null);
      expect(
        listed.sessions.find((session) => session.id === s.chatSessionId)?.attention ?? null
      ).toBeNull();
    });

    it('an agent’s own message does not answer its question (control)', async () => {
      const s = await seed();
      const id = await ask(s);
      await s.project.persistMessageBatch(s.chatSessionId, [
        {
          messageId: `agent-${crypto.randomUUID()}`,
          role: 'assistant',
          content: 'Waiting for your answer.',
          toolMetadata: null,
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ]);
      expect((await askRow(id))?.status).toBe('open');
    });

    it('filing a question answers SAM’s open check-in, as a question marker did', async () => {
      const s = await seed();
      await s.project.createAttentionMarker({
        sessionId: s.chatSessionId,
        taskId: s.taskId,
        workspaceId: s.workspaceId,
        kind: 'reconciliation_checkin',
        source: 'reconciliation_loop',
        reason: 'Are you still working?',
        metadata: null,
        expiresAt: Date.now() + 3_600_000,
      });
      expect(
        (await s.project.listActiveAttentionMarkers(s.chatSessionId)).map((marker) => marker.kind)
      ).toEqual(['reconciliation_checkin']);
      await ask(s);
      expect(await s.project.listActiveAttentionMarkers(s.chatSessionId)).toEqual([]);
    });

    it('an expired question stops its task, as a question marker’s expiry did', async () => {
      const s = await seed();
      const id = await ask(s);
      // The task runs in the chat's workspace, as a dispatched task does.
      await testEnv.DATABASE.prepare('UPDATE tasks SET workspace_id = ? WHERE id = ?')
        .bind(s.workspaceId, s.taskId)
        .run();
      const past = Date.now() - 1_000;
      // Past its deadline and its hard limit, so no undelivered grace applies.
      await testEnv.DATABASE.prepare(
        'UPDATE asks SET expires_at = ?, max_expires_at = ? WHERE id = ?'
      )
        .bind(past, past, id)
        .run();
      await runInboxAskSweep(testEnv);
      const row = await askRow(id);
      expect(row?.status).toBe('expired');
      expect(row?.notified_at).not.toBeNull();
      expect(await taskStatus(s.taskId)).toMatchObject({
        status: 'failed',
        error_message: 'Human input request expired after timeout',
      });
    });

    it('a question the person already answered in the chat does not stop the task at expiry', async () => {
      const s = await seed();
      const id = await ask(s);
      await testEnv.DATABASE.prepare('UPDATE tasks SET workspace_id = ? WHERE id = ?')
        .bind(s.workspaceId, s.taskId)
        .run();
      await s.project.persistMessageBatch(s.chatSessionId, [
        {
          messageId: `typed-${crypto.randomUUID()}`,
          role: 'user',
          content: 'Yes.',
          toolMetadata: null,
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ]);
      // As if closing the row had failed: the expiry backstop must see the message.
      const past = Date.now() - 1_000;
      await testEnv.DATABASE.prepare(
        `UPDATE asks SET status = 'open', notified_at = NULL, expires_at = ?, max_expires_at = ?
          WHERE id = ?`
      )
        .bind(past, past, id)
        .run();
      await runInboxAskSweep(testEnv);
      expect((await askRow(id))?.status).toBe('expired');
      expect((await taskStatus(s.taskId))?.status).toBe('in_progress');
    });
  });
});
