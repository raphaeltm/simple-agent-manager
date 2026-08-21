import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sleepWorkspace } from '../../../src/lib/api/workspaces';

describe('workspace API client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts to the manual sleep endpoint', async () => {
    const response = {
      status: 'sleeping',
      workspaceId: 'ws-idle',
      chatSessionId: 'session-idle',
      snapshotExpiresAt: '2026-08-28T00:00:00.000Z',
    } as const;
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(sleepWorkspace('ws-idle')).resolves.toEqual(response);

    expect(fetch).toHaveBeenCalledWith('http://localhost:8787/api/workspaces/ws-idle/sleep', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
