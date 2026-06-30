import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import * as svc from '../../../src/services/project-data';

const doResetError = new Error('Durable Object reset because its code was updated.');

function makeEnv(stub: Record<string, unknown>, overrides: Partial<Env> = {}): Env {
  return {
    DO_RETRY_MAX_ATTEMPTS: '3',
    DO_RETRY_BASE_DELAY_MS: '1',
    PROJECT_DATA: {
      idFromName: vi.fn(() => ({ name: 'proj-1' })),
      get: vi.fn(() => stub),
    },
    ...overrides,
  } as unknown as Env;
}

describe('project-data Durable Object retry', () => {
  it('retries getSession when ensureProjectId sees the code-update reset', async () => {
    const stub = {
      ensureProjectId: vi
        .fn()
        .mockRejectedValueOnce(doResetError)
        .mockResolvedValue(undefined),
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
      getMessages: vi
        .fn()
        .mockRejectedValueOnce(doResetError)
        .mockResolvedValue(messages),
    };

    const result = await svc.getMessages(makeEnv(stub), 'proj-1', 'chat-1', 100, null, undefined, true);

    expect(result).toEqual(messages);
    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
    expect(stub.getMessages).toHaveBeenCalledTimes(2);
    expect(stub.getMessages).toHaveBeenLastCalledWith('chat-1', 100, null, undefined, true, 'desc');
  });

  it('surfaces the reset error after max attempts are exhausted', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(doResetError),
    };

    await expect(svc.getSession(
      makeEnv(stub, { DO_RETRY_MAX_ATTEMPTS: '2', DO_RETRY_BASE_DELAY_MS: '1' }),
      'proj-1',
      'chat-1',
    )).rejects.toThrow('Durable Object reset because its code was updated.');

    expect(stub.ensureProjectId).toHaveBeenCalledTimes(2);
    expect(stub.getSession).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient Durable Object errors', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(new Error('database failed')),
    };

    await expect(svc.getSession(makeEnv(stub), 'proj-1', 'chat-1')).rejects.toThrow('database failed');

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
      createAcpSession: vi
        .fn()
        .mockRejectedValueOnce(doResetError)
        .mockResolvedValue(acpSession),
      transitionAcpSession: vi
        .fn()
        .mockRejectedValueOnce(doResetError)
        .mockResolvedValue(acpSession),
    };
    const env = makeEnv(stub);

    await svc.linkSessionToWorkspace(env, 'proj-1', 'chat-1', 'ws-1');
    await expect(svc.createAcpSession(env, 'proj-1', 'chat-1', null, 'codex')).resolves.toBe(acpSession);
    await expect(svc.transitionAcpSession(env, 'proj-1', 'acp-1', 'running', {
      actorType: 'system',
    })).resolves.toBe(acpSession);

    expect(stub.linkSessionToWorkspace).toHaveBeenCalledTimes(2);
    expect(stub.createAcpSession).toHaveBeenCalledTimes(2);
    expect(stub.transitionAcpSession).toHaveBeenCalledTimes(2);
  });
});
