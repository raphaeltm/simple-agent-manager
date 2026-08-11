/**
 * Workers integration tests for ProjectAgent Durable Object.
 *
 * Tests run inside the workerd runtime via @cloudflare/vitest-pool-workers
 * with a real SQLite-backed DO instance.
 *
 * Covers row-level fault isolation (.claude/rules/50): a single malformed
 * `conversations`/`messages`/`rate_limits` row must never 500 the whole
 * read, and a single-row lookup must degrade to null/self-heal instead of
 * crashing. Mirrors tests/workers/sam-session-do.test.ts — ProjectAgent's
 * `messages` and `rate_limits` tables/queries are byte-identical to
 * SamSession's (see src/durable-objects/row-validation.ts).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const PROJECT_ID = 'proj-agent-do-test-001';

function getProjectAgent(projectId: string) {
  const id = env.PROJECT_AGENT.idFromName(projectId);
  return env.PROJECT_AGENT.get(id);
}

async function sendChat(
  stub: ReturnType<typeof getProjectAgent>,
  body: { conversationId?: string; message: string; userId?: string; projectId?: string }
) {
  return stub.fetch('https://project-agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'test-user', projectId: PROJECT_ID, ...body }),
  });
}

describe('ProjectAgent DO — Message Persistence', () => {
  it('creates a conversation and persists messages with correct sequence', async () => {
    const stub = getProjectAgent(PROJECT_ID);

    const chatResp = await sendChat(stub, { message: 'Hello ProjectAgent' });
    expect(chatResp.status).toBe(200);
    expect(chatResp.headers.get('content-type')).toBe('text/event-stream');

    const text = await chatResp.text();
    const conversationId = text.match(/"conversationId":"([^"]+)"/)?.[1];
    expect(conversationId).toBeTruthy();

    const listResp = await stub.fetch('https://project-agent/conversations');
    expect(listResp.status).toBe(200);
    const listData = (await listResp.json()) as { conversations: Array<{ id: string; title: string }> };
    const conv = listData.conversations.find((c) => c.id === conversationId);
    expect(conv).toBeTruthy();
    expect(conv!.title).toBe('Hello ProjectAgent');

    const msgResp = await stub.fetch(`https://project-agent/conversations/${conversationId}/messages`);
    expect(msgResp.status).toBe(200);
    const msgData = (await msgResp.json()) as { messages: Array<{ role: string; content: string; sequence: number }> };
    const userMsg = msgData.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toBe('Hello ProjectAgent');
    expect(userMsg!.sequence).toBe(1);
  });
});

describe('ProjectAgent DO — Row Fault Isolation', () => {
  // REGRESSION (rule 50): `conversations` list rows were narrowed with a
  // blind `as unknown as ConversationRow[]` cast — and cast to a type that
  // claimed a `type` column ProjectAgent's own `conversations` table does not
  // have. The list read must return every well-formed conversation regardless.
  it('lists conversations without throwing (ProjectAgent conversations table has no `type` column)', async () => {
    const projectId = 'proj-agent-do-conv-list-001';
    const stub = getProjectAgent(projectId);

    const chatResp = await sendChat(stub, { message: 'Conversation list check', projectId });
    await chatResp.text();

    const listResp = await stub.fetch('https://project-agent/conversations');
    expect(listResp.status).toBe(200);
    const listData = (await listResp.json()) as { conversations: Array<{ id: string; title: string }> };
    expect(listData.conversations.length).toBeGreaterThanOrEqual(1);
  });

  // REGRESSION (rule 50): `messages` rows were narrowed with a blind
  // `as unknown as MessageRow[]` cast. `sequence` has INTEGER affinity but no
  // STRICT typing, so real SQLite accepts and stores a non-numeric TEXT value
  // as-is — the application itself never writes this; it's injected directly
  // to simulate a legacy/corrupted row. A single malformed message must not
  // 500 the whole conversation.
  it('skips a malformed message row (non-numeric sequence) and still returns the good messages', async () => {
    const projectId = 'proj-agent-do-msg-fault-001';
    const stub = getProjectAgent(projectId);

    const first = await sendChat(stub, { message: 'Good message one', projectId });
    const text1 = await first.text();
    const convId = text1.match(/"conversationId":"([^"]+)"/)?.[1];
    expect(convId).toBeTruthy();

    const second = await sendChat(stub, { conversationId: convId, message: 'Good message two', projectId });
    await second.text();

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO messages (id, conversation_id, role, content, sequence, created_at)
         VALUES (?, ?, 'user', 'corrupted sequence', 'not-a-number', datetime('now'))`,
        'msg-agent-malformed-row-fault-001',
        convId
      );
    });

    const msgResp = await stub.fetch(`https://project-agent/conversations/${convId}/messages`);
    expect(msgResp.status).toBe(200);
    const msgData = (await msgResp.json()) as { messages: Array<{ id: string; content: string }> };

    const contents = msgData.messages.map((m) => m.content);
    expect(contents).toContain('Good message one');
    expect(contents).toContain('Good message two');
    expect(msgData.messages.find((m) => m.id === 'msg-agent-malformed-row-fault-001')).toBeUndefined();
  });

  // REGRESSION (rule 50 — single-row degrade): `rate_limits` was narrowed
  // with a blind `as {...} | undefined` cast. A corrupted `window_start`
  // (INTEGER affinity, no STRICT typing) must degrade the rate limiter to
  // "row missing" (self-heals via `INSERT OR REPLACE`) rather than
  // permanently computing NaN comparisons.
  it('self-heals a corrupted rate_limits row instead of leaving it permanently NaN', async () => {
    const projectId = 'proj-agent-do-ratelimit-fault-001';
    const stub = getProjectAgent(projectId);

    const seed = await sendChat(stub, { message: 'seed rate limit row', projectId });
    await seed.text();

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE rate_limits SET window_start = 'not-a-timestamp' WHERE id = 1`);
    });

    const resp = await sendChat(stub, { message: 'after corruption', projectId });
    expect(resp.status).toBe(200);
    await resp.text();

    const windowStart = await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT window_start FROM rate_limits WHERE id = 1')
        .toArray()[0] as { window_start: unknown } | undefined;
      return row?.window_start;
    });
    expect(typeof windowStart).toBe('number');
  });
});
