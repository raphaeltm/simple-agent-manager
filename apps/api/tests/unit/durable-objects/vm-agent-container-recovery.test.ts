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
import {
  RUNTIME_RECOVERY_DEGRADED_MESSAGE,
  type RuntimeRecoveryState,
} from '../../../src/durable-objects/vm-agent-container-recovery';

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
    withLifecycleLock: privateContainer.withLifecycleLock,
    prepareForRequest: privateContainer.prepareForRequest,
    getRuntimeSettings: () => ({
      portReadyTimeoutMs: 30_000,
      activeWorkMaxMs: 2 * 60 * 60 * 1000,
      keepaliveRenewIntervalMs: 5 * 60 * 1000,
      recoveryMaxAttempts: input?.maxAttempts ?? 2,
    }),
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

async function callResumeRuntime(fake: unknown) {
  return (
    VmAgentContainer.prototype as unknown as {
      resumeRuntime: (
        this: unknown,
        agentSessionId?: string
      ) => Promise<{ ok: boolean; status: string; code?: string }>;
    }
  ).resumeRuntime.call(fake, 'agent-session-1');
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
  it('reconciles stale D1 state only after proving the target SessionHost is live', async () => {
    const { fake } = makeRecoveryFake({ lifecycle: 'running' });
    fake.containerFetch.mockResolvedValueOnce(
      Response.json({
        sessions: [{ id: 'agent-session-1', status: 'running', hostStatus: 'ready' }],
      })
    );

    const result = await callResumeRuntime(fake);

    expect(result).toEqual({ ok: true, status: 'running' });
    expect(recoveryMocks.loadContext).toHaveBeenCalledWith(fake.env, {
      workspaceId: 'workspace-1',
      preferredAgentSessionId: 'agent-session-1',
    });
    expect(recoveryMocks.signNodeManagementToken).toHaveBeenCalledWith(
      'user-1',
      'node-1',
      'workspace-1',
      fake.env
    );
    const probeRequest = fake.containerFetch.mock.calls[0]?.[0] as Request;
    expect(probeRequest.headers.get('Authorization')).toBe('Bearer management-token');
    expect(probeRequest.headers.get('X-SAM-Workspace-Id')).toBe('workspace-1');
    expect(fake.startRuntime).not.toHaveBeenCalled();
    expect(recoveryMocks.persistRecovered).toHaveBeenCalledWith(
      fake.env,
      expect.objectContaining({ agentSessionId: 'agent-session-1' }),
      'none'
    );
  });

  it('restores instead of falsely resuming when D1 says recovery but SessionHost is missing', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'running' });
    fake.containerFetch
      .mockResolvedValueOnce(
        Response.json({ sessions: [{ id: 'agent-session-1', status: 'running' }] })
      )
      .mockResolvedValueOnce(
        Response.json({ status: 'restored', degradation: 'none', skipped: [] })
      );

    const result = await callResumeRuntime(fake);

    expect(result).toEqual({ ok: true, status: 'running' });
    expect(fake.startRuntime).toHaveBeenCalledTimes(1);
    expect(recoveryMocks.persistRecovering).toHaveBeenCalledTimes(1);
    expect(values.has('runtimeRecovery')).toBe(false);
  });

  it('does not reconcile running when an explicit stop crosses the SessionHost probe', async () => {
    let finishProbe!: (response: Response) => void;
    const { fake, values } = makeRecoveryFake({ lifecycle: 'running' });
    fake.containerFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishProbe = resolve;
        })
    );
    const stopForUser = (
      VmAgentContainer.prototype as unknown as {
        stopForUser: (this: unknown) => Promise<void>;
      }
    ).stopForUser;

    const resume = callResumeRuntime(fake);
    await vi.waitFor(() => expect(fake.containerFetch).toHaveBeenCalledTimes(1));
    await stopForUser.call(fake);
    finishProbe(
      Response.json({
        sessions: [{ id: 'agent-session-1', status: 'running', hostStatus: 'ready' }],
      })
    );

    await expect(resume).resolves.toMatchObject({
      ok: false,
      status: 'stopped',
      code: 'RUNTIME_STOPPED',
    });
    expect(recoveryMocks.persistRecovered).not.toHaveBeenCalled();
    expect(values.get('lifecycleStatus')).toBe('stopping');
  });

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
    // CF2: startRuntime() already launched a fresh container before the restore.
    // The completed-block re-check must tear it down (2nd stop), not just return
    // terminal — otherwise the just-stopped session leaks compute until sleepAfter.
    // Pre-fix this was 1 (only stopForUser's stop).
    expect(fake.stop).toHaveBeenCalledTimes(2);
  });
});

describe('VmAgentContainer wake concurrency and persistence', () => {
  const stopForUser = (
    VmAgentContainer.prototype as unknown as {
      stopForUser: (this: unknown) => Promise<void>;
    }
  ).stopForUser;

  it('CF1: does not re-arm recovery when an explicit stop lands right after beginUnexpectedRecovery', async () => {
    const { fake, values } = makeRecoveryFake({ lifecycle: 'sleeping' });
    const realBegin = privateContainer.beginUnexpectedRecovery;
    // Land the stop in the EARLIER race window: after beginUnexpectedRecovery
    // returns (recovery created, lifecycle 'recovering') but BEFORE ensureAwake's
    // unlocked continuation reads the terminal guard and bumps the phase to
    // 'waking'. beginUnexpectedRecovery and stopForUser share the lifecycleChain,
    // so the stop serializes after begin releases the lock.
    fake.beginUnexpectedRecovery = async function (this: unknown, input: unknown) {
      const result = await realBegin.call(this, input);
      await stopForUser.call(this);
      return result;
    };

    const result = await callEnsureAwake(fake);

    expect(result).toMatchObject({ ok: false, status: 'stopped', code: 'RUNTIME_STOPPED' });
    // Pre-fix (guard only checked 'stopped') the continuation flipped to 'waking'
    // and woke the just-stopped container. These assertions go red pre-fix.
    expect(fake.startRuntime).not.toHaveBeenCalled();
    expect(recoveryMocks.persistRecovered).not.toHaveBeenCalled();
    expect(values.get('lifecycleStatus')).toBe('stopping');
    expect(values.has('runtimeRecovery')).toBe(false);
  });

  it('T10: carries recovery.attempts 1->2 across persisted storage before exhausting', async () => {
    const { fake, values } = makeRecoveryFake({
      maxAttempts: 2,
      restoreResponse: Response.json({ error: 'SNAPSHOT_NOT_FOUND' }, { status: 404 }),
    });

    // First follow-up during the outage: one bounded wake attempt, degraded but
    // NOT yet exhausted.
    const first = await callEnsureAwake(fake);
    expect(first).toMatchObject({ ok: false, status: 'degraded' });
    expect(values.get('runtimeRecovery')).toMatchObject({ phase: 'degraded', attempts: 1 });
    expect(recoveryMocks.persistFailed).not.toHaveBeenCalled();

    // Second follow-up reuses the persisted record: attempts 1 -> 2, and only now
    // exhausts.
    const second = await callEnsureAwake(fake);
    expect(second).toMatchObject({ ok: false, status: 'degraded' });
    expect(values.get('runtimeRecovery')).toMatchObject({ phase: 'exhausted', attempts: 2 });
    expect(values.get('lifecycleStatus')).toBe('error');
    expect(recoveryMocks.persistFailed).toHaveBeenCalledTimes(1);
  });

  it('T11: honors a pre-populated recovery record left by onStop without resetting it', async () => {
    const { fake, values } = makeRecoveryFake({
      lifecycle: 'recovering',
      restoreResponse: Response.json({ error: 'SNAPSHOT_NOT_FOUND' }, { status: 404 }),
      maxAttempts: 2,
    });
    // Shape onStop leaves behind: phase 'pending', trigger 'stop', a manual_retry
    // disposition, attempts 0. ensureAwake must reuse it, not start fresh.
    values.set('runtimeRecovery', {
      version: 1,
      phase: 'pending',
      trigger: 'stop',
      cause: { kind: 'container_stop', reason: 'runtime_signal', exitCode: 137 },
      attempts: 0,
      promptDisposition: 'manual_retry',
      agentSessionId: 'agent-session-1',
      startedAt: 1000,
      updatedAt: 1000,
    });

    await callEnsureAwake(fake);

    // beginUnexpectedRecovery (which would call persistRecovering) must NOT run —
    // the existing trigger/cause/disposition/startedAt survive; only the wake
    // bump advances attempts 0 -> 1.
    expect(recoveryMocks.persistRecovering).not.toHaveBeenCalled();
    expect(values.get('runtimeRecovery')).toMatchObject({
      trigger: 'stop',
      cause: { kind: 'container_stop', reason: 'runtime_signal', exitCode: 137 },
      promptDisposition: 'manual_retry',
      agentSessionId: 'agent-session-1',
      startedAt: 1000,
      attempts: 1,
    });
  });

  it('S6: re-invoking an exhausted recovery returns degraded without re-running the D1 batch', async () => {
    const { fake, values } = makeRecoveryFake({
      maxAttempts: 1,
      restoreResponse: Response.json({ error: 'SNAPSHOT_NOT_FOUND' }, { status: 404 }),
    });

    const first = await callEnsureAwake(fake);
    expect(first).toMatchObject({ ok: false, status: 'degraded' });
    expect(values.get('runtimeRecovery')).toMatchObject({ phase: 'exhausted' });
    expect(recoveryMocks.persistFailed).toHaveBeenCalledTimes(1);

    // Every later request hits an exhausted record. Pre-fix this re-ran
    // exhaustRecovery() (a full D1 batch + persistRuntimeRecoveryFailed) each time.
    const second = await callEnsureAwake(fake);
    expect(second).toMatchObject({ ok: false, status: 'degraded', code: 'RUNTIME_RECOVERY_DEGRADED' });
    expect(recoveryMocks.persistFailed).toHaveBeenCalledTimes(1);
  });

  it('T12: degrades (not 500s) when the recovery context loader throws mid-wake', async () => {
    const { fake, values } = makeRecoveryFake({
      restoreResponse: Response.json({ error: 'SNAPSHOT_NOT_FOUND' }, { status: 404 }),
    });
    // beginUnexpectedRecovery resolves the context; the wakeFromSnapshot reload
    // then throws a D1 error. Pre-fix that escaped as an uncaught rejection (500).
    recoveryMocks.loadContext
      .mockReset()
      .mockResolvedValueOnce(runtimeContext)
      .mockRejectedValueOnce(new Error('D1 unavailable'));

    const result = await callEnsureAwake(fake);

    expect(result).toMatchObject({
      ok: false,
      status: 'degraded',
      code: 'RUNTIME_RECOVERY_DEGRADED',
      message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    });
    expect(values.get('runtimeRecovery')).toMatchObject({
      phase: 'degraded',
      lastFailure: { kind: 'unexpected' },
    });
  });
});

describe('VmAgentContainer wake-path lifecycle status parity', () => {
  // Parity contract: any lifecycleStatus the wake path can set as an intermediate
  // state must never let a later unexpected onStop/onError START A SECOND recovery.
  // onStop enforces this via its ignore-list; onError relies on
  // beginUnexpectedRecovery's existing-record idempotency. vm-agent-container-
  // lifecycle.ts is read-only, so these are literals mirrored from the wake path:
  //   ensureAwake            -> 'waking'
  //   wakeFromSnapshot       -> 'restoring'
  //   beginUnexpectedRecovery-> 'recovering'
  //   degradeRecovery        -> 'degraded'
  // A NEW wake-path status added without preserving this guard fails these tests.
  const WAKE_PATH_INTERMEDIATE_STATUSES = [
    'recovering',
    'waking',
    'restoring',
    'degraded',
  ] as const;

  const onStop = (
    VmAgentContainer.prototype as unknown as {
      onStop: (
        this: unknown,
        input: { exitCode: number; reason: 'exit' | 'runtime_signal' }
      ) => Promise<void>;
    }
  ).onStop;
  const onError = (
    VmAgentContainer.prototype as unknown as {
      onError: (this: unknown, error: unknown) => Promise<void>;
    }
  ).onError;

  it.each(WAKE_PATH_INTERMEDIATE_STATUSES)(
    'onStop ignores mid-wake status %s and starts no fresh recovery',
    async (status) => {
      const { fake, values } = makeRecoveryFake({ lifecycle: status });
      // No pre-existing recovery: if onStop did NOT ignore this status it would
      // call beginUnexpectedRecovery -> persistRecovering, which this asserts against.
      await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });
      expect(recoveryMocks.persistRecovering).not.toHaveBeenCalled();
      expect(values.get('lifecycleStatus')).toBe(status);
    }
  );

  it.each(WAKE_PATH_INTERMEDIATE_STATUSES)(
    'onError does not duplicate an in-flight recovery at mid-wake status %s',
    async (status) => {
      const { fake, values } = makeRecoveryFake({ lifecycle: status });
      // Mid-wake there is always a recovery record; onError must reuse it, not
      // start a second one (beginUnexpectedRecovery returns the existing record).
      values.set('runtimeRecovery', {
        version: 1,
        phase: 'waking',
        trigger: 'error',
        cause: { kind: 'container_error', errorName: 'RuntimeError' },
        attempts: 1,
        promptDisposition: 'none',
        agentSessionId: 'agent-session-1',
        startedAt: 1,
        updatedAt: 1,
      });
      await onError.call(fake, Object.assign(new Error('boom'), { name: 'RuntimeError' }));
      expect(recoveryMocks.persistRecovering).not.toHaveBeenCalled();
      expect(values.get('runtimeRecovery')).toMatchObject({ trigger: 'error', attempts: 1 });
    }
  );
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
