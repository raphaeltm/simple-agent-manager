/**
 * Workers integration tests for SamSession Durable Object.
 *
 * Tests run inside the workerd runtime via @cloudflare/vitest-pool-workers
 * with a real SQLite-backed DO instance.
 *
 * Covers:
 * - Message persistence and sequence ordering
 * - Conversation creation and listing
 * - Rate limiting enforcement
 * - Chat route relay (POST /chat, GET /conversations, GET /conversations/:id/messages)
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

function getSamSession(userId: string) {
  const id = env.SAM_SESSION.idFromName(userId);
  return env.SAM_SESSION.get(id);
}

describe('SamSession DO — Message Persistence', () => {
  it('creates a conversation and persists messages with correct sequence', async () => {
    const stub = getSamSession('test-user-persistence');

    // Create a conversation via POST /chat (will fail at agent loop due to no API key,
    // but conversation + user message should be persisted)
    const chatResp = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Hello SAM',
        userId: 'test-user-persistence',
      }),
    });

    // Should return SSE stream (200) even though agent loop will error
    expect(chatResp.status).toBe(200);
    expect(chatResp.headers.get('content-type')).toBe('text/event-stream');

    // Read the stream to get conversationId and let it complete
    const reader = chatResp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let conversationId = '';

    // Read until done or we have conversationId
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      // Parse SSE events
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6)) as { type: string; conversationId?: string };
          if (event.type === 'conversation_started' && event.conversationId) {
            conversationId = event.conversationId;
          }
          if (event.type === 'done' || event.type === 'error') {
            done = true;
          }
        } catch { /* ignore parse errors */ }
      }
      buffer = lines[lines.length - 1] || '';
    }
    reader.releaseLock();

    expect(conversationId).toBeTruthy();

    // Verify conversation appears in list
    const listResp = await stub.fetch('https://sam-session/conversations');
    expect(listResp.status).toBe(200);
    const listData = await listResp.json() as { conversations: Array<{ id: string; title: string }> };
    expect(listData.conversations.length).toBeGreaterThanOrEqual(1);
    const conv = listData.conversations.find((c) => c.id === conversationId);
    expect(conv).toBeTruthy();
    expect(conv!.title).toBe('Hello SAM');

    // Verify messages are persisted with correct sequence
    const msgResp = await stub.fetch(`https://sam-session/conversations/${conversationId}/messages`);
    expect(msgResp.status).toBe(200);
    const msgData = await msgResp.json() as { messages: Array<{ role: string; content: string; sequence: number }> };
    expect(msgData.messages.length).toBeGreaterThanOrEqual(1);

    // First message should be user message with sequence 1
    const userMsg = msgData.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toBe('Hello SAM');
    expect(userMsg!.sequence).toBe(1);
  });

  it('persists multiple messages with incrementing sequence', async () => {
    const stub = getSamSession('test-user-sequence');

    // First message
    const resp1 = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Message one', userId: 'test-user-sequence' }),
    });
    expect(resp1.status).toBe(200);

    // Drain the stream
    let convId = '';
    const text1 = await resp1.text();
    const match = text1.match(/"conversationId":"([^"]+)"/);
    if (match) convId = match[1]!;

    expect(convId).toBeTruthy();

    // Second message to same conversation
    const resp2 = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: convId,
        message: 'Message two',
        userId: 'test-user-sequence',
      }),
    });
    expect(resp2.status).toBe(200);
    await resp2.text(); // drain

    // Check messages have incrementing sequences
    const msgResp = await stub.fetch(`https://sam-session/conversations/${convId}/messages`);
    const msgData = await msgResp.json() as { messages: Array<{ role: string; content: string; sequence: number }> };

    const userMessages = msgData.messages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBe(2);
    expect(userMessages[0]!.sequence).toBeLessThan(userMessages[1]!.sequence);
    expect(userMessages[0]!.content).toBe('Message one');
    expect(userMessages[1]!.content).toBe('Message two');
  });
});

describe('SamSession DO — Rate Limiting', () => {
  it('returns 429 when rate limit exceeded', async () => {
    // Use a unique user to avoid interference from other tests
    const stub = getSamSession('test-user-ratelimit');

    // Send many messages quickly — default is 30 RPM but we just need to exceed it
    // We'll rely on the DO's rate limit table. Send messages in a loop.
    const responses: number[] = [];
    for (let i = 0; i < 35; i++) {
      const resp = await stub.fetch('https://sam-session/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: `msg ${i}`, userId: 'test-user-ratelimit' }),
      });
      responses.push(resp.status);
      if (resp.status !== 200) {
        // Drain body
        await resp.text();
      } else {
        await resp.text(); // drain SSE
      }
    }

    // Some should be 200, later ones should be 429
    expect(responses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(responses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('returns retry-after header on 429', async () => {
    const stub = getSamSession('test-user-ratelimit-header');

    // Exhaust rate limit
    for (let i = 0; i < 31; i++) {
      const resp = await stub.fetch('https://sam-session/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: `msg ${i}`, userId: 'test-user-ratelimit-header' }),
      });
      const status = resp.status;
      if (status === 200) await resp.text();
      else {
        if (status === 429) {
          const body = await resp.json() as { error: string; retryAfter: number };
          expect(body.error).toBe('Rate limit exceeded');
          expect(body.retryAfter).toBeGreaterThan(0);
          expect(resp.headers.get('retry-after')).toBeTruthy();
          return; // test passed
        }
        await resp.text();
      }
    }
    // Should have hit 429 by now
    expect.fail('Expected 429 response but never received one');
  });
});

describe('SamSession DO — Search', () => {
  it('returns 400 for empty search query', async () => {
    const stub = getSamSession('test-user-search-empty');
    const resp = await stub.fetch('https://sam-session/search?query=');
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe('Query is required');
  });

  it('searches persisted messages and returns results', async () => {
    const stub = getSamSession('test-user-search-basic');

    // Create a conversation with a message containing unique text
    const chatResp = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Tell me about XYZZY_UNIQUE_SEARCH_TOKEN',
        userId: 'test-user-search-basic',
      }),
    });
    expect(chatResp.status).toBe(200);
    await chatResp.text(); // drain SSE

    // Search for the unique token
    const searchResp = await stub.fetch('https://sam-session/search?query=XYZZY_UNIQUE_SEARCH_TOKEN');
    expect(searchResp.status).toBe(200);
    const body = await searchResp.json() as { results: Array<{ snippet: string; role: string }> };
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.snippet).toContain('XYZZY_UNIQUE_SEARCH_TOKEN');
    expect(body.results[0]!.role).toBe('user');
  });

  it('respects search limit parameter', async () => {
    const stub = getSamSession('test-user-search-limit');

    // Create multiple conversations with same keyword
    for (let i = 0; i < 5; i++) {
      const resp = await stub.fetch('https://sam-session/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: `REPEATABLE_KEYWORD iteration ${i}`,
          userId: 'test-user-search-limit',
        }),
      });
      await resp.text();
    }

    const searchResp = await stub.fetch('https://sam-session/search?query=REPEATABLE_KEYWORD&limit=2');
    expect(searchResp.status).toBe(200);
    const body = await searchResp.json() as { results: Array<{ snippet: string }> };
    expect(body.results.length).toBeLessThanOrEqual(2);
  });
});

describe('SamSession DO — Type Filter and Message Limit', () => {
  it('filters conversations by type', async () => {
    const stub = getSamSession('test-user-type-filter');

    // Create a conversation (default type is "human")
    const chatResp = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Hello for type filter test',
        userId: 'test-user-type-filter',
      }),
    });
    await chatResp.text();

    // List with type=human should return it
    const humanResp = await stub.fetch('https://sam-session/conversations?type=human');
    const humanData = await humanResp.json() as { conversations: Array<{ type: string }> };
    expect(humanData.conversations.length).toBeGreaterThanOrEqual(1);
    for (const c of humanData.conversations) {
      expect(c.type).toBe('human');
    }

    // List with type=agent should return none (no agent conversations created)
    const agentResp = await stub.fetch('https://sam-session/conversations?type=agent');
    const agentData = await agentResp.json() as { conversations: Array<{ type: string }> };
    expect(agentData.conversations.length).toBe(0);
  });

  it('returns type column in conversation list', async () => {
    const stub = getSamSession('test-user-type-column');

    const chatResp = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Type column test',
        userId: 'test-user-type-column',
      }),
    });
    await chatResp.text();

    const listResp = await stub.fetch('https://sam-session/conversations');
    const data = await listResp.json() as { conversations: Array<{ id: string; type: string }> };
    expect(data.conversations.length).toBeGreaterThanOrEqual(1);
    expect(data.conversations[0]!.type).toBe('human');
  });

  it('respects limit param on GET /conversations/:id/messages', async () => {
    const stub = getSamSession('test-user-msg-limit');

    // Create a conversation and send multiple messages
    const resp1 = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Msg A', userId: 'test-user-msg-limit' }),
    });
    const text1 = await resp1.text();
    const match = text1.match(/"conversationId":"([^"]+)"/);
    const convId = match?.[1];
    expect(convId).toBeTruthy();

    // Send more messages
    for (const msg of ['Msg B', 'Msg C', 'Msg D']) {
      const r = await stub.fetch('https://sam-session/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, message: msg, userId: 'test-user-msg-limit' }),
      });
      await r.text();
    }

    // Request with limit=2
    const limitResp = await stub.fetch(`https://sam-session/conversations/${convId}/messages?limit=2`);
    const limitData = await limitResp.json() as { messages: Array<{ content: string }> };
    expect(limitData.messages.length).toBe(2);

    // Request without limit should return more
    const allResp = await stub.fetch(`https://sam-session/conversations/${convId}/messages`);
    const allData = await allResp.json() as { messages: Array<{ content: string }> };
    expect(allData.messages.length).toBeGreaterThan(2);
  });
});

describe('SamSession DO — Validation', () => {
  it('returns 400 for empty message', async () => {
    const stub = getSamSession('test-user-validation');

    const resp = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '', userId: 'test-user-validation' }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe('Message is required');
  });

  it('returns 404 for nonexistent conversation', async () => {
    const stub = getSamSession('test-user-404');

    const resp = await stub.fetch('https://sam-session/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'nonexistent-id',
        message: 'hello',
        userId: 'test-user-404',
      }),
    });
    expect(resp.status).toBe(404);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe('Conversation not found');
  });

  it('returns 404 for unknown routes', async () => {
    const stub = getSamSession('test-user-unknown');
    const resp = await stub.fetch('https://sam-session/unknown');
    expect(resp.status).toBe(404);
  });
});
