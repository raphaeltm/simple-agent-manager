import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import * as svc from '../../../src/services/project-data';
import { resetProjectDataEnsureMemo } from '../../../src/services/project-data-ensure-memo';

const doResetError = new Error('Durable Object reset because its code was updated.');

function makeEnv(stub: Record<string, unknown>, overrides: Partial<Env> = {}): Env {
  return {
    DO_RETRY_MAX_ATTEMPTS: '3',
    DO_RETRY_BASE_DELAY_MS: '1',
    PROJECT_DATA: {
      idFromName: vi.fn((name: string) => ({ toString: () => `doid-${name}` })),
      get: vi.fn(() => stub),
    },
    ...overrides,
  } as unknown as Env;
}

// `getStub` memoizes the ensure per (isolate, DO), which is module-scope state.
// Reset it so each case starts from a cold isolate.
beforeEach(() => {
  resetProjectDataEnsureMemo();
});

describe('project-data Durable Object retry', () => {
  it('retries getSession when ensureProjectId sees the code-update reset', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockRejectedValueOnce(doResetError).mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue({ id: 'chat-1', status: 'active' }),
    };

    const result = await svc.getSession(makeEnv(stub), 'proj-1', 'chat-1');

    expect(result).toEqual({ id: 'chat-1', status: 'active' });
    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
    expect(stub.getSession).toHaveBeenCalledTimes(1);
    expect(stub.getSession).toHaveBeenCalledWith('chat-1');
  });

  it('retries getMessages when the RPC sees the code-update reset', async () => {
    const messages = {
      messages: [{ id: 'msg-1', sessionId: 'chat-1', role: 'assistant', content: 'ok' }],
      hasMore: false,
    };
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockRejectedValueOnce(doResetError).mockResolvedValue(messages),
    };

    const result = await svc.getMessages(
      makeEnv(stub),
      'proj-1',
      'chat-1',
      100,
      null,
      null,
      undefined,
      true
    );

    expect(result).toEqual(messages);
    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
    expect(stub.getMessages).toHaveBeenCalledTimes(2);
    expect(stub.getMessages).toHaveBeenLastCalledWith(
      'chat-1',
      100,
      null,
      null,
      undefined,
      true,
      'desc'
    );
  });

  // Regression for the missing-propagation bug where the service layer re-mapped
  // batch messages before the DO RPC and silently dropped `origin`. This boundary
  // is not covered by vm-agent tests or DO worker tests (which call the stub
  // directly), so a service-layer unit test is the one that would have caught it.
  it('forwards origin to the DO stub in persistMessageBatch', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      persistMessageBatch: vi.fn().mockResolvedValue({ persisted: 2, duplicates: 0 }),
    };

    await svc.persistMessageBatch(makeEnv(stub), 'proj-1', 'chat-1', [
      {
        messageId: 'm-visible',
        role: 'user',
        content: 'do the task',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
      {
        messageId: 'm-injected',
        role: 'user',
        content: 'IMPORTANT: call get_instructions',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
        origin: 'system',
      },
    ]);

    expect(stub.persistMessageBatch).toHaveBeenCalledTimes(1);
    const forwarded = stub.persistMessageBatch.mock.calls[0][1] as Array<{
      messageId: string;
      origin?: string | null;
    }>;
    expect(forwarded.find((m) => m.messageId === 'm-injected')?.origin).toBe('system');
    // A normal message with no origin forwards as null (not undefined/dropped).
    expect(forwarded.find((m) => m.messageId === 'm-visible')?.origin).toBeNull();
  });

  it('surfaces the reset error after max attempts are exhausted', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(doResetError),
    };

    await expect(
      svc.getSession(
        makeEnv(stub, { DO_RETRY_MAX_ATTEMPTS: '2', DO_RETRY_BASE_DELAY_MS: '1' }),
        'proj-1',
        'chat-1'
      )
    ).rejects.toThrow('Durable Object reset because its code was updated.');

    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
    expect(stub.getSession).toHaveBeenCalledTimes(2);
  });

  it('retries WebSocket forwarding when the DO fetch sees the code-update reset', async () => {
    const response = new Response(null, { status: 204 });
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockRejectedValueOnce(doResetError).mockResolvedValue(response),
    };
    const request = new Request('https://api.example.test/api/projects/proj-1/sessions/ws', {
      headers: { Upgrade: 'websocket' },
    });

    const result = await svc.forwardWebSocket(makeEnv(stub), 'proj-1', request);

    expect(result).toBe(response);
    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
    expect(stub.fetch).toHaveBeenCalledTimes(2);
    for (const [forwardedRequest] of stub.fetch.mock.calls) {
      expect(forwardedRequest).toBeInstanceOf(Request);
      expect(new URL((forwardedRequest as Request).url).pathname).toBe('/ws');
    }
  });

  it('does not retry non-transient Durable Object errors', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(new Error('database failed')),
    };

    await expect(svc.getSession(makeEnv(stub), 'proj-1', 'chat-1')).rejects.toThrow(
      'database failed'
    );

    expect(stub.ensureProjectId).toHaveBeenCalledTimes(1);
    expect(stub.getSession).toHaveBeenCalledTimes(1);
  });

  it('applies retry behavior to task-runner ProjectData call sites', async () => {
    const acpSession = { id: 'acp-1', status: 'running' };
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      linkSessionToWorkspace: vi
        .fn()
        .mockRejectedValueOnce(doResetError)
        .mockResolvedValue(undefined),
      createAcpSession: vi.fn().mockRejectedValueOnce(doResetError).mockResolvedValue(acpSession),
      transitionAcpSession: vi
        .fn()
        .mockRejectedValueOnce(doResetError)
        .mockResolvedValue(acpSession),
    };
    const env = makeEnv(stub);

    await svc.linkSessionToWorkspace(env, 'proj-1', 'chat-1', 'ws-1');
    await expect(svc.createAcpSession(env, 'proj-1', 'chat-1', null, 'codex')).resolves.toBe(
      acpSession
    );
    await expect(
      svc.transitionAcpSession(env, 'proj-1', 'acp-1', 'running', {
        actorType: 'system',
      })
    ).resolves.toBe(acpSession);

    expect(stub.linkSessionToWorkspace).toHaveBeenCalledTimes(2);
    expect(stub.createAcpSession).toHaveBeenCalledTimes(2);
    expect(stub.transitionAcpSession).toHaveBeenCalledTimes(2);
  });
});
