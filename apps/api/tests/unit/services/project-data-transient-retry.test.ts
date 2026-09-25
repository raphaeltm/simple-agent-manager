import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  forwardWebSocket,
  getMessages,
  getSession,
  getSessionState,
  linkSessionToTask,
  listSessions,
} from '../../../src/services/project-data';
import {
  PROJECT_DATA_UNAVAILABLE,
  ProjectDataUnavailableError,
} from '../../../src/services/project-data-rpc-retry';

function transientReset(): Error {
  return new Error(
    'Durable Object storage operation exceeded timeout which caused object to be reset.'
  );
}

/** Cloudflare's exact text, as it crosses the DO RPC boundary (a plain Error). */
function cpuLimitReset(): Error {
  return new Error('Durable Object exceeded its CPU time limit and was reset.');
}

function connectionLost(): Error {
  return new Error('Network connection lost.');
}

function loggedEvents(spy: ReturnType<typeof vi.spyOn>, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function envForStub(stub: Record<string, unknown>, overrides: Record<string, string> = {}): Env {
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
    ...overrides,
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

  it('retries an idempotent read after a CPU-limit reset caused by another request', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { activity: 'prompting' };
    const getSessionStateMock = vi
      .fn()
      .mockRejectedValueOnce(cpuLimitReset())
      .mockResolvedValueOnce(state);
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSessionState: getSessionStateMock,
    };

    await expect(getSessionState(envForStub(stub), 'project-1', 'session-1')).resolves.toEqual(
      state
    );
    expect(getSessionStateMock).toHaveBeenCalledTimes(2);
    expect(loggedEvents(infoSpy, 'project_data.do_rpc_retry_succeeded')).toEqual([
      expect.objectContaining({
        operation: 'getSessionState',
        policy: 'idempotent_read',
        attempts: 2,
        firstErrorClass: 'cpu_limit_reset',
      }),
    ]);
  });

  it('retries a WebSocket upgrade whose connection to the object was lost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const accepted = new Response(null, { status: 204 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionLost())
      .mockResolvedValueOnce(accepted);
    const stub = { ensureProjectId: vi.fn().mockResolvedValue(undefined), fetch: fetchMock };
    const request = new Request('https://api.example.test/api/projects/project-1/sessions/ws', {
      headers: { Upgrade: 'websocket' },
    });

    await expect(forwardWebSocket(envForStub(stub), 'project-1', request)).resolves.toBe(accepted);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds retries of a persistent CPU-limit reset and reports exhaustion', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getSessionMock = vi.fn().mockRejectedValue(cpuLimitReset());
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: getSessionMock,
    };

    const error = await getSession(envForStub(stub), 'project-1', 'session-1').catch(
      (err: unknown) => err
    );
    // A stable, retryable 503 rather than the platform's text.
    expect(error).toBeInstanceOf(ProjectDataUnavailableError);
    expect(error).toMatchObject({
      statusCode: 503,
      error: PROJECT_DATA_UNAVAILABLE,
      details: { projectId: 'project-1', operation: 'getSession', errorClass: 'cpu_limit_reset' },
    });
    expect((error as Error).message).not.toContain('CPU time limit');
    // DO_RETRY_MAX_ATTEMPTS = 2 in envForStub.
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(loggedEvents(warnSpy, 'project_data.do_rpc_retry_exhausted')).toEqual([
      expect.objectContaining({
        operation: 'getSession',
        attempts: 2,
        errorClass: 'cpu_limit_reset',
      }),
    ]);
  });

  it('retries a CPU-limit reset on the per-owner message read as well', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const page = { messages: [{ id: 'm1' }], hasMore: false };
    const readMock = vi.fn().mockRejectedValueOnce(cpuLimitReset()).mockResolvedValueOnce(page);
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      archiveSourceGetMessages: readMock,
    };

    await expect(getMessages(envForStub(stub), 'project-1', 'session-1')).resolves.toEqual(page);
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a lost connection sooner than on other retryable failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getSessionMock = vi.fn().mockRejectedValue(connectionLost());
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: getSessionMock,
    };

    const error = await getSession(
      envForStub(stub, { DO_RETRY_MAX_ATTEMPTS: '8' }),
      'project-1',
      'session-1'
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({
      statusCode: 503,
      details: { errorClass: 'connection_lost' },
    });
    // DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS = 3, well inside the general budget of 8.
    expect(getSessionMock).toHaveBeenCalledTimes(3);
    expect(loggedEvents(warnSpy, 'project_data.do_rpc_retry_exhausted')).toEqual([
      expect.objectContaining({ attempts: 3, errorClass: 'connection_lost' }),
    ]);
  });

  it('keeps the full budget and the raw error for other retryable failures (control)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getSessionMock = vi.fn().mockRejectedValue(transientReset());
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: getSessionMock,
    };

    const error = await getSession(
      envForStub(stub, { DO_RETRY_MAX_ATTEMPTS: '8' }),
      'project-1',
      'session-1'
    ).catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(ProjectDataUnavailableError);
    expect((error as Error).message).toContain('exceeded timeout');
    expect(getSessionMock).toHaveBeenCalledTimes(8);
  });

  it('never repeats a mutation whose outcome a CPU reset or lost connection made ambiguous', async () => {
    for (const failure of [cpuLimitReset(), connectionLost()]) {
      const linkMock = vi.fn().mockRejectedValue(failure);
      const stub = {
        ensureProjectId: vi.fn().mockResolvedValue(undefined),
        linkSessionToTask: linkMock,
      };

      await expect(
        linkSessionToTask(envForStub(stub), 'project-1', 'session-1', 'task-1')
      ).rejects.toThrow(failure.message);
      expect(linkMock).toHaveBeenCalledTimes(1);
    }
  });

  it('still retries a mutation the object rejected before doing anything (control)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const linkMock = vi.fn().mockRejectedValueOnce(transientReset()).mockResolvedValueOnce(true);
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      linkSessionToTask: linkMock,
    };

    await expect(
      linkSessionToTask(envForStub(stub), 'project-1', 'session-1', 'task-1')
    ).resolves.toBe(true);
    expect(linkMock).toHaveBeenCalledTimes(2);
  });
});
