import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  forwardWebSocket,
  getSessionState,
  listSessions,
} from '../../../src/services/project-data';

function transientReset(): Error {
  return new Error(
    'Durable Object storage operation exceeded timeout which caused object to be reset.'
  );
}

function envForStub(stub: Record<string, unknown>): Env {
  return {
    PROJECT_DATA: {
      idFromName: vi.fn((projectId: string) => ({
        toString: () => `do-${projectId}`,
      })),
      get: vi.fn(() => stub),
    },
    DO_RETRY_MAX_ATTEMPTS: '2',
    DO_RETRY_BASE_DELAY_MS: '1',
    DO_RETRY_MAX_DELAY_MS: '1',
  } as unknown as Env;
}

describe('ProjectData transient retry wrappers', () => {
  it('retries listSessions after a transient ProjectData DO reset', async () => {
    const listSessionsMock = vi
      .fn()
      .mockRejectedValueOnce(transientReset())
      .mockResolvedValueOnce({ sessions: [], total: 0, hasMore: false });
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      listSessions: listSessionsMock,
    };

    await expect(listSessions(envForStub(stub), 'project-1')).resolves.toEqual({
      sessions: [],
      total: 0,
      hasMore: false,
    });
    expect(listSessionsMock).toHaveBeenCalledTimes(2);
    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
  });

  it('retries getSessionState after a transient ProjectData DO reset', async () => {
    const state = { activity: 'idle' };
    const getSessionStateMock = vi
      .fn()
      .mockRejectedValueOnce(transientReset())
      .mockResolvedValueOnce(state);
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSessionState: getSessionStateMock,
    };

    await expect(getSessionState(envForStub(stub), 'project-1', 'session-1')).resolves.toEqual(
      state
    );
    expect(getSessionStateMock).toHaveBeenCalledTimes(2);
  });

  it('retries WebSocket forwarding after a transient ProjectData DO reset', async () => {
    const accepted = new Response(null, { status: 204 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(transientReset())
      .mockResolvedValueOnce(accepted);
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      fetch: fetchMock,
    };
    const request = new Request('https://api.example.test/api/projects/project-1/sessions/ws', {
      headers: { Upgrade: 'websocket' },
    });

    await expect(forwardWebSocket(envForStub(stub), 'project-1', request)).resolves.toBe(accepted);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(new URL((fetchMock.mock.calls[0]?.[0] as Request).url).pathname).toBe('/ws');
  });
});
