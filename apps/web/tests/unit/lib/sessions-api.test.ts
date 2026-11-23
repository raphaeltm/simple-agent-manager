import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listChatSessions } from '../../../src/lib/api/sessions';

describe('listChatSessions', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ sessions: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function requestedUrl(): URL {
    return new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
  }

  // The API route bypasses the D1 session index only for exactly this parameter
  // (apps/api/src/routes/chat-session-list.ts).
  it('asks for the authoritative list only when requested', async () => {
    await listChatSessions('proj-1', { limit: 100, includeLive: true, authoritative: true });

    const url = requestedUrl();
    expect(url.pathname).toBe('/api/projects/proj-1/sessions');
    expect(url.searchParams.get('consistency')).toBe('authoritative');
    expect(url.searchParams.get('include')).toBe('live');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('leaves ordinary reads on the index', async () => {
    await listChatSessions('proj-1', { limit: 100, includeLive: true });

    expect(requestedUrl().searchParams.has('consistency')).toBe(false);
  });
});
