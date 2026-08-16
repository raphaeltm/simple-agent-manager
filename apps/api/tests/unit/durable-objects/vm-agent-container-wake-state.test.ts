import { describe, expect, it, vi } from 'vitest';

import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';
import type { RuntimeRecoveryState } from '../../../src/durable-objects/vm-agent-container-recovery';

type PrivateContainer = {
  proxyHttpAuthorized: (
    this: unknown,
    request: Request,
    port?: number,
    guard?: { taskId: string; projectId: string; chatSessionId: string }
  ) => Promise<Response>;
  assertSourceTaskGuard: (this: unknown, guard?: unknown) => Promise<void>;
  prepareForRequest: (this: unknown) => Promise<unknown>;
  ensureAwake: (this: unknown) => Promise<unknown>;
  resultResponse: (this: unknown, result: unknown) => Response;
  interruptedRequestResponse: (this: unknown, request: Request) => Response;
};

const privateContainer = VmAgentContainer.prototype as unknown as PrivateContainer;

function callProxyHttp(fake: unknown, request: Request): Promise<Response> {
  return (
    VmAgentContainer.prototype as unknown as {
      proxyHttp: (this: unknown, request: Request, port?: number) => Promise<Response>;
    }
  ).proxyHttp.call(fake, request);
}

function callProxyHttpGuarded(
  fake: unknown,
  request: Request,
  guard: { taskId: string; projectId: string; chatSessionId: string }
): Promise<Response> {
  return (
    VmAgentContainer.prototype as unknown as {
      proxyHttpGuarded: (
        this: unknown,
        request: Request,
        port: number | undefined,
        sourceTaskGuard: typeof guard
      ) => Promise<Response>;
    }
  ).proxyHttpGuarded.call(fake, request, undefined, guard);
}

function makeProxyFake(input: {
  ready: { ok: boolean; status: string; code?: string; message?: string };
  state: string;
  response?: Response;
}) {
  const containerFetch = vi.fn().mockResolvedValue(input.response ?? new Response('proxied'));
  const beginUnexpectedRecovery = vi.fn().mockResolvedValue(null);
  return {
    fake: {
      defaultPort: 8080,
      proxyHttpAuthorized: privateContainer.proxyHttpAuthorized,
      clearSourceTaskWakeGuard: vi.fn().mockResolvedValue(undefined),
      assertSourceTaskGuard: vi.fn(async () => undefined),
      prepareForRequest: vi.fn().mockResolvedValue(input.ready),
      resultResponse: privateContainer.resultResponse,
      interruptedRequestResponse: privateContainer.interruptedRequestResponse,
      getState: vi.fn().mockResolvedValue({ status: input.state }),
      containerFetch,
      beginUnexpectedRecovery,
    },
    containerFetch,
    beginUnexpectedRecovery,
  };
}

describe('VmAgentContainer proxy recovery boundaries', () => {
  it('rejects a revoked source guard before proxy preparation can wake compute', async () => {
    const proxyHttp = vi.fn();
    const first = vi.fn().mockResolvedValue(null);
    const fake = {
      env: {
        DATABASE: {
          prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
        },
      },
      proxyHttp,
      proxyHttpAuthorized: privateContainer.proxyHttpAuthorized,
      assertSourceTaskGuard: privateContainer.assertSourceTaskGuard,
      abortRevokedSourceTaskWake: vi.fn().mockResolvedValue(undefined),
    };

    const response = await callProxyHttpGuarded(
      fake,
      new Request('http://container/prompt', { method: 'POST' }),
      { taskId: 'parent-1', projectId: 'project-1', chatSessionId: 'chat-1' }
    );

    expect(response.status).toBe(409);
    expect(proxyHttp).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(fake.abortRevokedSourceTaskWake).toHaveBeenCalledOnce();
  });

  it('rechecks after preparation and withholds the prompt when authority is revoked mid-wake', async () => {
    const first = vi.fn().mockResolvedValueOnce({ id: 'parent-1' }).mockResolvedValueOnce(null);
    const startRuntime = vi.fn();
    const containerFetch = vi.fn().mockResolvedValue(new Response('proxied'));
    const fake: Record<string, unknown> = {
      defaultPort: 8080,
      env: {
        DATABASE: {
          prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
        },
      },
      proxyHttpAuthorized: privateContainer.proxyHttpAuthorized,
      assertSourceTaskGuard: privateContainer.assertSourceTaskGuard,
      prepareForRequest: privateContainer.prepareForRequest,
      ctx: {
        storage: {
          get: vi.fn(async (key: string) => (key === 'lifecycleStatus' ? 'sleeping' : undefined)),
        },
      },
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      containerFetch,
      beginUnexpectedRecovery: vi.fn(),
      abortRevokedSourceTaskWake: vi.fn().mockResolvedValue(undefined),
      clearSourceTaskWakeGuard: vi.fn().mockResolvedValue(undefined),
    };
    const ensureAwake = vi.fn(async (guard: unknown) => {
      await privateContainer.assertSourceTaskGuard.call(fake, guard);
      startRuntime();
      return { ok: true, status: 'running' };
    });
    fake.ensureAwake = ensureAwake;

    const response = await callProxyHttpGuarded(
      fake,
      new Request('http://container/prompt', { method: 'POST' }),
      { taskId: 'parent-1', projectId: 'project-1', chatSessionId: 'chat-1' }
    );

    expect(response.status).toBe(409);
    expect(first).toHaveBeenCalledTimes(2);
    expect(ensureAwake).toHaveBeenCalledOnce();
    expect(startRuntime).not.toHaveBeenCalled();
    expect(containerFetch).not.toHaveBeenCalled();
    expect(fake.abortRevokedSourceTaskWake).toHaveBeenCalledOnce();
  });

  it('allows a live source through both the preparation and prompt boundaries', async () => {
    const first = vi.fn().mockResolvedValue({ id: 'parent-1' });
    const prepareForRequest = vi.fn().mockResolvedValue({ ok: true, status: 'running' });
    const containerFetch = vi.fn().mockResolvedValue(new Response('proxied'));
    const fake = {
      defaultPort: 8080,
      env: {
        DATABASE: {
          prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
        },
      },
      proxyHttpAuthorized: privateContainer.proxyHttpAuthorized,
      clearSourceTaskWakeGuard: vi.fn().mockResolvedValue(undefined),
      assertSourceTaskGuard: privateContainer.assertSourceTaskGuard,
      prepareForRequest,
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      containerFetch,
      beginUnexpectedRecovery: vi.fn(),
    };

    const response = await callProxyHttpGuarded(
      fake,
      new Request('http://container/prompt', { method: 'POST' }),
      { taskId: 'parent-1', projectId: 'project-1', chatSessionId: 'chat-1' }
    );

    expect(response.status).toBe(200);
    expect(first).toHaveBeenCalledTimes(2);
    expect(prepareForRequest).toHaveBeenCalledOnce();
    expect(containerFetch).toHaveBeenCalledOnce();
  });

  it('forwards a prompt only after wake/restore reports running', async () => {
    const { fake, containerFetch } = makeProxyFake({
      ready: { ok: true, status: 'running' },
      state: 'running',
    });

    const response = await callProxyHttp(
      fake,
      new Request('http://container/prompt', { method: 'POST' })
    );

    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('returns a sanitized degraded response without forwarding', async () => {
    const { fake, containerFetch } = makeProxyFake({
      ready: {
        ok: false,
        status: 'degraded',
        code: 'RUNTIME_RECOVERY_DEGRADED',
        message: 'The Instant session could not restore its last safe checkpoint.',
      },
      state: 'stopped',
    });

    const response = await callProxyHttp(
      fake,
      new Request('http://container/prompt', { method: 'POST' })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'RUNTIME_RECOVERY_DEGRADED',
    });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('keeps an explicit stop terminal', async () => {
    const { fake, containerFetch } = makeProxyFake({
      ready: {
        ok: false,
        status: 'stopped',
        code: 'RUNTIME_STOPPED',
        message: 'This Instant session was stopped and cannot be resumed.',
      },
      state: 'stopped',
    });

    const response = await callProxyHttp(
      fake,
      new Request('http://container/prompt', { method: 'POST' })
    );

    expect(response.status).toBe(410);
    expect(containerFetch).not.toHaveBeenCalled();
  });
});

describe('VmAgentContainer cold-wake serialization', () => {
  it('launches and restores exactly once for two concurrent follow-ups', async () => {
    const shared = {
      lifecycle: 'sleeping',
      recovery: {
        version: 1,
        phase: 'pending',
        trigger: 'idle',
        cause: { kind: 'idle_sleep' },
        attempts: 0,
        promptDisposition: 'none',
        agentSessionId: 'session-1',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      } satisfies RuntimeRecoveryState,
    };
    const storage = {
      get: vi.fn(async (key: string) => {
        if (key === 'lifecycleStatus') return shared.lifecycle;
        if (key === 'runtimeRecovery') return shared.recovery;
        return undefined;
      }),
      put: vi.fn(async (key: string, value: unknown) => {
        if (key === 'lifecycleStatus') shared.lifecycle = String(value);
        if (key === 'runtimeRecovery') shared.recovery = value as RuntimeRecoveryState;
      }),
    };
    const wakeFromSnapshot = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      shared.lifecycle = 'running';
      return { ok: true, status: 'running' };
    });
    const containerFetch = vi.fn().mockResolvedValue(new Response('proxied'));
    const fake = {
      defaultPort: 8080,
      proxyHttpAuthorized: privateContainer.proxyHttpAuthorized,
      clearSourceTaskWakeGuard: vi.fn().mockResolvedValue(undefined),
      assertSourceTaskGuard: vi.fn(async () => undefined),
      wakeChain: Promise.resolve(),
      ctx: { storage },
      prepareForRequest: privateContainer.prepareForRequest,
      ensureAwake: privateContainer.ensureAwake,
      resultResponse: privateContainer.resultResponse,
      interruptedRequestResponse: privateContainer.interruptedRequestResponse,
      getRuntimeSettings: () => ({ recoveryMaxAttempts: 2 }),
      wakeFromSnapshot,
      beginUnexpectedRecovery: vi.fn(),
      getState: vi.fn(async () => ({
        status: shared.lifecycle === 'running' ? 'running' : 'stopped',
      })),
      containerFetch,
    };

    const [first, second] = await Promise.all([
      callProxyHttp(fake, new Request('http://container/prompt', { method: 'POST' })),
      callProxyHttp(fake, new Request('http://container/prompt', { method: 'POST' })),
    ]);

    expect(wakeFromSnapshot).toHaveBeenCalledTimes(1);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
