import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryMocks = vi.hoisted(() => ({
  loadContext: vi.fn(),
  persistRecovering: vi.fn(),
  persistRecovered: vi.fn(),
  persistFailed: vi.fn(),
  signNodeCallbackToken: vi.fn(),
  signCallbackToken: vi.fn(),
  signNodeManagementToken: vi.fn(),
}));

vi.mock('../../../src/durable-objects/vm-agent-container-recovery', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/durable-objects/vm-agent-container-recovery')
    >();
  return {
    ...actual,
    loadRuntimeRecoveryContext: recoveryMocks.loadContext,
    persistRuntimeRecovering: recoveryMocks.persistRecovering,
    persistRuntimeRecovered: recoveryMocks.persistRecovered,
    persistRuntimeRecoveryFailed: recoveryMocks.persistFailed,
  };
});

vi.mock('../../../src/services/jwt', () => ({
  signNodeCallbackToken: recoveryMocks.signNodeCallbackToken,
  signCallbackToken: recoveryMocks.signCallbackToken,
  signNodeManagementToken: recoveryMocks.signNodeManagementToken,
}));

import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';
import type { RuntimeRecoveryState } from '../../../src/durable-objects/vm-agent-container-recovery';

const launchConfig = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  chatSessionId: 'chat-1',
  repository: 'owner/repo',
  branch: 'main',
  workspaceDir: '/workspaces/repo',
  controlPlaneUrl: 'https://api.example.test',
  vmAgentPort: 8080,
};

const runtimeContext = {
  userId: 'user-1',
  chatSessionId: 'chat-1',
  agentSessionId: 'agent-session-1',
  agentType: 'codex',
};

type PrivateContainer = {
  ensureAwake: (this: unknown) => Promise<unknown>;
  beginUnexpectedRecovery: (this: unknown, input: unknown) => Promise<unknown>;
  wakeFromSnapshot: (this: unknown, recovery: RuntimeRecoveryState) => Promise<unknown>;
  degradeRecovery: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  exhaustRecovery: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  toRecoveryTarget: (this: unknown, ...args: unknown[]) => unknown;
  withLifecycleLock: (this: unknown, operation: () => Promise<unknown>) => Promise<unknown>;
  prepareForRequest: (this: unknown) => Promise<unknown>;
};

const privateContainer = VmAgentContainer.prototype as unknown as PrivateContainer;

function makeStorage(initialLifecycle: string) {
  const values = new Map<string, unknown>([
    ['lifecycleStatus', initialLifecycle],
    ['launchConfig', launchConfig],
  ]);
  return {
    values,
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
}

function makeRecoveryFake(input?: {
  lifecycle?: string;
  restoreResponse?: Response;
  maxAttempts?: number;
}) {
  const { values, storage } = makeStorage(input?.lifecycle ?? 'sleeping');
  const fake = {
    env: { CF_CONTAINER_RECOVERY_MAX_ATTEMPTS: String(input?.maxAttempts ?? 2) },
    ctx: { storage },
    wakeChain: Promise.resolve(),
    lifecycleChain: Promise.resolve(),
    defaultPort: 8080,
    ensureAwake: privateContainer.ensureAwake,
    beginUnexpectedRecovery: privateContainer.beginUnexpectedRecovery,
    wakeFromSnapshot: privateContainer.wakeFromSnapshot,
    degradeRecovery: privateContainer.degradeRecovery,
    exhaustRecovery: privateContainer.exhaustRecovery,
    toRecoveryTarget: privateContainer.toRecoveryTarget,
    withLifecycleLock: privateContainer.withLifecycleLock,
    prepareForRequest: privateContainer.prepareForRequest,
    getRecoveryMaxAttempts: () => input?.maxAttempts ?? 2,
    clearKeepaliveSchedule: vi.fn().mockResolvedValue(undefined),
    markActiveWorkEnded: vi.fn().mockResolvedValue(undefined),
    startRuntime: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    containerFetch: vi
      .fn()
      .mockResolvedValue(
        input?.restoreResponse ??
          Response.json({ status: 'restored', degradation: 'none', skipped: [] })
      ),
    getState: vi.fn().mockResolvedValue({ status: 'running' }),
  };
  return { fake, values, storage };
}

async function callEnsureAwake(fake: unknown) {
  return privateContainer.ensureAwake.call(fake) as Promise<{
    ok: boolean;
    status: string;
    code?: string;
  }>;
}

function callProxyHttp(fake: unknown, request: Request): Promise<Response> {
  return (
    VmAgentContainer.prototype as unknown as {
      proxyHttp: (this: unknown, request: Request) => Promise<Response>;
    }
  ).proxyHttp.call(fake, request);
}

beforeEach(() => {
  vi.clearAllMocks();
  recoveryMocks.loadContext.mockResolvedValue(runtimeContext);
  recoveryMocks.persistRecovering.mockResolvedValue(undefined);
  recoveryMocks.persistRecovered.mockResolvedValue(undefined);
  recoveryMocks.persistFailed.mockResolvedValue(undefined);
  recoveryMocks.signNodeCallbackToken.mockResolvedValue('fresh-node-token');
  recoveryMocks.signCallbackToken.mockResolvedValue('fresh-workspace-token');
  recoveryMocks.signNodeManagementToken.mockResolvedValue({ token: 'management-token' });
});

describe('VmAgentContainer snapshot recovery state machine', () => {
  it('cold-wakes, reinjects fresh callback tokens, restores, then reconciles running', async () => {
    const { fake, values } = makeRecoveryFake();

    const result = await callEnsureAwake(fake);

    expect(result).toEqual({ ok: true, status: 'running' });
    expect(fake.startRuntime).toHaveBeenCalledWith(launchConfig, {
      nodeCallbackToken: 'fresh-node-token',
    });
    const restoreRequest = fake.containerFetch.mock.calls[0]?.[0] as Request;
    await expect(restoreRequest.json()).resolves.toMatchObject({
      chatSessionId: 'chat-1',
      runtime: 'cf-container',
      agentType: 'codex',
      workspaceCallbackToken: 'fresh-workspace-token',
    });
    expect(recoveryMocks.persistRecovering).toHaveBeenCalledWith(
      fake.env,
      expect.objectContaining({
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        agentSessionId: 'agent-session-1',
      })
    );
    expect(recoveryMocks.persistRecovered).toHaveBeenCalledWith(
      fake.env,
      expect.objectContaining({ chatSessionId: 'chat-1' }),
      'none'
    );
    expect(values.get('lifecycleStatus')).toBe('running');
    expect(values.has('runtimeRecovery')).toBe(false);
  });

  it('keeps missing snapshots degraded until the bounded attempt is exhausted', async () => {
    const { fake, values } = makeRecoveryFake({
      maxAttempts: 1,
      restoreResponse: Response.json({ error: 'SNAPSHOT_NOT_FOUND' }, { status: 404 }),
    });

    const result = await callEnsureAwake(fake);

    expect(result).toMatchObject({
      ok: false,
      status: 'degraded',
      code: 'RUNTIME_RECOVERY_DEGRADED',
    });
    expect(recoveryMocks.persistRecovered).not.toHaveBeenCalled();
    expect(recoveryMocks.persistFailed).toHaveBeenCalledTimes(1);
    expect(values.get('lifecycleStatus')).toBe('error');
    expect(values.get('runtimeRecovery')).toMatchObject({
      phase: 'exhausted',
      lastFailure: { kind: 'restore_http', httpStatus: 404 },
    });
  });

  it('treats a corrupt successful restore body as degraded, never as true resume', async () => {
    const { fake, values } = makeRecoveryFake({
      restoreResponse: new Response('{not-json', { status: 200 }),
    });

    const result = await callEnsureAwake(fake);

    expect(result).toMatchObject({ ok: false, status: 'degraded' });
    expect(recoveryMocks.persistRecovered).not.toHaveBeenCalled();
    expect(recoveryMocks.persistFailed).not.toHaveBeenCalled();
    expect(values.get('runtimeRecovery')).toMatchObject({
      phase: 'degraded',
      lastFailure: { kind: 'restore_status' },
    });
  });

  it('keeps an explicit stop terminal when it crosses an active restore', async () => {
    let finishRestore!: (response: Response) => void;
    const { fake, values } = makeRecoveryFake();
    fake.containerFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRestore = resolve;
        })
    );
    const stopForUser = (
      VmAgentContainer.prototype as unknown as {
        stopForUser: (this: unknown) => Promise<void>;
      }
    ).stopForUser;

    const wake = callEnsureAwake(fake);
    await vi.waitFor(() => expect(fake.containerFetch).toHaveBeenCalledTimes(1));

    await stopForUser.call(fake);
    finishRestore(
      Response.json({
        status: 'restored',
        degradation: 'none',
        skipped: [],
      })
    );

    await expect(wake).resolves.toMatchObject({
      ok: false,
      status: 'stopped',
      code: 'RUNTIME_STOPPED',
    });
    expect(recoveryMocks.persistRecovered).not.toHaveBeenCalled();
    expect(values.get('lifecycleStatus')).toBe('stopping');
    expect(values.has('runtimeRecovery')).toBe(false);
  });
});

describe('VmAgentContainer replacement classification', () => {
  it('classifies duplicate runtime_signal callbacks once without calling them rollout', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'running' });
    const onStop = (
      VmAgentContainer.prototype as unknown as {
        onStop: (
          this: unknown,
          input: { exitCode: number; reason: 'runtime_signal' }
        ) => Promise<void>;
      }
    ).onStop;

    await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });
    await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });

    expect(recoveryMocks.persistRecovering).toHaveBeenCalledTimes(1);
    expect(values.get('runtimeRecovery')).toMatchObject({
      trigger: 'stop',
      cause: { kind: 'container_stop', reason: 'runtime_signal', exitCode: 0 },
    });
  });

  it('classifies a true container error generically and preserves recovery eligibility', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'running' });
    const onError = (
      VmAgentContainer.prototype as unknown as {
        onError: (this: unknown, error: unknown) => Promise<void>;
      }
    ).onError;

    await onError.call(
      fake,
      Object.assign(new Error('sensitive detail'), { name: 'RuntimeError' })
    );

    expect(values.get('runtimeRecovery')).toMatchObject({
      trigger: 'error',
      cause: { kind: 'container_error', errorName: 'RuntimeError' },
    });
  });

  it('keeps an explicit stop terminal and does not create recovery state', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'stopping' });
    const markRuntimeEnded = vi.fn().mockResolvedValue(undefined);
    Object.assign(fake, { markRuntimeEnded });
    const onStop = (
      VmAgentContainer.prototype as unknown as {
        onStop: (this: unknown, input: { exitCode: number; reason: 'exit' }) => Promise<void>;
      }
    ).onStop;

    await onStop.call(fake, { exitCode: 0, reason: 'exit' });

    expect(markRuntimeEnded).toHaveBeenCalledWith('stopped', 'Container stopped by user request');
    expect(recoveryMocks.persistRecovering).not.toHaveBeenCalled();
    expect(values.get('lifecycleStatus')).toBe('stopped');
  });

  it('does not replay a prompt whose request crosses replacement', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'running' });
    fake.containerFetch.mockRejectedValueOnce(
      Object.assign(new Error('socket reset'), { name: 'TypeError' })
    );
    const request = new Request(
      'http://container/workspaces/workspace-1/agent-sessions/agent-session-1/prompt',
      {
        method: 'POST',
        body: JSON.stringify({ prompt: 'continue' }),
      }
    );

    const response = await callProxyHttp(fake, request);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'RUNTIME_REQUEST_INTERRUPTED',
    });
    expect(fake.containerFetch).toHaveBeenCalledTimes(1);
    expect(values.get('runtimeRecovery')).toMatchObject({
      trigger: 'request',
      promptDisposition: 'manual_retry',
      cause: { kind: 'transport_interrupted', errorName: 'TypeError' },
    });
  });

  it('classifies a missing SessionHost before another prompt can be sent', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'running' });
    fake.containerFetch.mockResolvedValueOnce(
      Response.json({ error: 'no active agent session found' }, { status: 404 })
    );

    const response = await callProxyHttp(
      fake,
      new Request('http://container/workspaces/workspace-1/agent-sessions/agent-session-1/prompt', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(409);
    expect(values.get('runtimeRecovery')).toMatchObject({
      promptDisposition: 'manual_retry',
      cause: { kind: 'missing_session_host', httpStatus: 404 },
    });
  });
});
