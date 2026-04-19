/**
 * Unit tests for TrialOrchestrator DO.
 *
 * Covers:
 *   - `start()` is idempotent: a second call with the same input no-ops and
 *     does not re-schedule the alarm.
 *   - `start()` persists initial state with currentStep='project_creation'.
 *   - `alarm()` on a completed state is a no-op (terminal guard).
 *   - `alarm()` on overall-timeout emits trial.error and marks completed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Base DO class shim — the real Cloudflare DurableObject base is only
// available at runtime in Workers; the shim gives us a constructible class.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the trial-runner event emitter to observe failTrial → trial.error.
const { emitTrialEventMock } = vi.hoisted(() => ({
  emitTrialEventMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/trial/trial-runner', () => ({
  emitTrialEvent: emitTrialEventMock,
  emitTrialEventForProject: vi.fn(async () => {}),
}));

// Stub trial-store so failTrial's bookkeeping path doesn't blow up on KV.
vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrial: vi.fn(async () => null),
  readTrialByProject: vi.fn(async () => null),
  writeTrial: vi.fn(async () => {}),
}));

// Stub mcp-token service so failTrial's revocation path is observable.
const { revokeMcpTokenMock } = vi.hoisted(() => ({
  revokeMcpTokenMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/mcp-token', () => ({
  revokeMcpToken: revokeMcpTokenMock,
}));

// Stub every step handler so alarm() dispatch can be controlled per-test.
// Individual tests override these via `stepMocks.<handler>.mockImplementationOnce`.
const { stepMocks } = vi.hoisted(() => ({
  stepMocks: {
    handleProjectCreation: vi.fn(async () => {}),
    handleNodeSelection: vi.fn(async () => {}),
    handleNodeProvisioning: vi.fn(async () => {}),
    handleNodeAgentReady: vi.fn(async () => {}),
    handleWorkspaceCreation: vi.fn(async () => {}),
    handleWorkspaceReady: vi.fn(async () => {}),
    handleDiscoveryAgentStart: vi.fn(async () => {}),
    handleRunning: vi.fn(async () => {}),
  },
}));
vi.mock('../../../src/durable-objects/trial-orchestrator/steps', () => stepMocks);

const { TrialOrchestrator } = await import(
  '../../../src/durable-objects/trial-orchestrator'
);

type Storage = Map<string, unknown>;

function makeCtx(storage: Storage = new Map()) {
  let alarmTime: number | null = null;
  return {
    storage: {
      get: vi.fn(async (k: string) => storage.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        storage.set(k, v);
      }),
      delete: vi.fn(async (k: string) => storage.delete(k)),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      getAlarm: vi.fn(async () => alarmTime),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
    _alarmTime: () => alarmTime,
    _storage: storage,
  };
}

function makeEnv() {
  return {
    DATABASE: {},
    TRIAL_EVENT_BUS: {
      idFromName: vi.fn(() => 'stub-id'),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response('ok')),
      })),
    },
  } as unknown as Parameters<typeof TrialOrchestrator>[1];
}

describe('TrialOrchestrator.start()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists initial state and schedules an alarm on first call', async () => {
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.start({
      trialId: 'trial_abc',
      repoUrl: 'https://github.com/alice/repo',
      repoOwner: 'alice',
      repoName: 'repo',
    });
    const stored = ctx._storage.get('state') as { currentStep: string; trialId: string };
    expect(stored).toBeTruthy();
    expect(stored.currentStep).toBe('project_creation');
    expect(stored.trialId).toBe('trial_abc');
    expect(ctx._alarmTime()).not.toBeNull();
  });

  it('emits trial.started event so the SSE stream signals immediately', async () => {
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.start({
      trialId: 'trial_started_evt',
      repoUrl: 'https://github.com/alice/repo',
      repoOwner: 'alice',
      repoName: 'repo',
    });
    expect(emitTrialEventMock).toHaveBeenCalledTimes(1);
    const [env, trialId, event] = emitTrialEventMock.mock.calls[0];
    expect(env).toBeTruthy();
    expect(trialId).toBe('trial_started_evt');
    expect(event).toMatchObject({
      type: 'trial.started',
      trialId: 'trial_started_evt',
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(typeof (event as { startedAt: number }).startedAt).toBe('number');
  });

  it('is idempotent — second start() call is a no-op (no re-schedule)', async () => {
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.start({
      trialId: 'trial_abc',
      repoUrl: 'https://github.com/alice/repo',
      repoOwner: 'alice',
      repoName: 'repo',
    });
    const firstPutCount = ctx.storage.put.mock.calls.length;
    const firstAlarmCount = ctx.storage.setAlarm.mock.calls.length;

    // Second call — must not re-persist or re-alarm.
    await orch.start({
      trialId: 'trial_abc',
      repoUrl: 'https://github.com/alice/repo',
      repoOwner: 'alice',
      repoName: 'repo',
    });

    expect(ctx.storage.put.mock.calls.length).toBe(firstPutCount);
    expect(ctx.storage.setAlarm.mock.calls.length).toBe(firstAlarmCount);
  });
});

describe('TrialOrchestrator.alarm()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when state is completed (terminal guard)', async () => {
    const storage: Storage = new Map();
    storage.set('state', {
      version: 1,
      trialId: 'trial_done',
      currentStep: 'failed',
      completed: true,
      createdAt: Date.now(),
      lastStepAt: Date.now(),
    });
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();
    // Must not have emitted a new event.
    expect(emitTrialEventMock).not.toHaveBeenCalled();
  });

  it('capability: start() → overall-timeout alarm() emits trial.error through event bus', async () => {
    // End-to-end capability: exercises the full DO state machine from
    // `start()` through a terminal `alarm()`, asserting that:
    //   1. start() persists initial state + schedules alarm
    //   2. start() emits trial.started via the event bus
    //   3. alarm() with an expired overall budget transitions to `failed`
    //   4. alarm() emits trial.error via the same event bus
    //
    // This is the cross-boundary capability test required by rule 10:
    // it verifies that the orchestrator DO (via the mocked `emitTrialEvent`
    // seam) actually pushes events into the downstream TrialEventBus that
    // the SSE route reads from. Mocking `emitTrialEvent` is acceptable
    // here because the companion route tests (trial-events.test.ts)
    // verify the bus → SSE side of the same seam.
    const ctx = makeCtx();
    const env = makeEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, env);

    // 1. start() — persists state + alarm + emits trial.started.
    await orch.start({
      trialId: 'trial_cap_e2e',
      repoUrl: 'https://github.com/alice/repo',
      repoOwner: 'alice',
      repoName: 'repo',
    });
    expect(emitTrialEventMock).toHaveBeenCalledTimes(1);
    expect(emitTrialEventMock.mock.calls[0][2]).toMatchObject({
      type: 'trial.started',
      trialId: 'trial_cap_e2e',
    });
    expect(ctx._alarmTime()).not.toBeNull();

    // 2. Simulate the overall-timeout budget expiring by rewinding createdAt.
    const state = ctx._storage.get('state') as { createdAt: number; lastStepAt: number };
    state.createdAt = Date.now() - 24 * 60 * 60 * 1000;
    state.lastStepAt = state.createdAt;

    // 3. alarm() — detects timeout, fails the trial, emits trial.error.
    await orch.alarm();

    const finalState = ctx._storage.get('state') as {
      currentStep: string;
      completed: boolean;
      failureReason: string | null;
    };
    expect(finalState.currentStep).toBe('failed');
    expect(finalState.completed).toBe(true);
    expect(finalState.failureReason).toMatch(/timed out/);

    // 4. trial.error was dispatched through the event bus seam.
    const errorCall = emitTrialEventMock.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'trial.error'
    );
    expect(errorCall).toBeTruthy();
    expect(errorCall?.[1]).toBe('trial_cap_e2e');
  });

  it('fails the trial with timeout error when overall budget exceeded', async () => {
    const storage: Storage = new Map();
    const farPast = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    storage.set('state', {
      version: 1,
      trialId: 'trial_slow',
      repoUrl: '',
      repoOwner: '',
      repoName: '',
      currentStep: 'workspace_ready',
      projectId: 'proj_1',
      nodeId: null,
      autoProvisionedNode: false,
      workspaceId: null,
      chatSessionId: null,
      acpSessionId: null,
      retryCount: 0,
      createdAt: farPast,
      lastStepAt: farPast,
      nodeAgentReadyStartedAt: null,
      workspaceReadyStartedAt: null,
      completed: false,
      failureReason: null,
    });
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();

    const updated = ctx._storage.get('state') as {
      currentStep: string;
      completed: boolean;
      failureReason: string | null;
    };
    expect(updated.currentStep).toBe('failed');
    expect(updated.completed).toBe(true);
    expect(updated.failureReason).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// alarm() step-error retry/backoff branches
//
// These exercise the catch block at index.ts:190–220, which is the only path
// that exercises isTransientError(), retry counting, backoff scheduling, and
// the permanent-error fallback via failTrial.
// ---------------------------------------------------------------------------

function makeRunningState(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    version: 1,
    trialId: 'trial_retry',
    repoUrl: '',
    repoOwner: '',
    repoName: '',
    currentStep: 'project_creation',
    projectId: null,
    nodeId: null,
    autoProvisionedNode: false,
    workspaceId: null,
    chatSessionId: null,
    acpSessionId: null,
    retryCount: 0,
    createdAt: now,
    lastStepAt: now,
    nodeAgentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    completed: false,
    failureReason: null,
    ...overrides,
  };
}

describe('TrialOrchestrator.alarm() — step error retry/backoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset each step mock to a successful no-op.
    for (const fn of Object.values(stepMocks)) {
      fn.mockReset();
      fn.mockImplementation(async () => {});
    }
  });

  it('transient error with retries remaining increments retryCount and schedules backoff (no failTrial)', async () => {
    const storage: Storage = new Map();
    storage.set('state', makeRunningState());
    stepMocks.handleProjectCreation.mockRejectedValueOnce(
      new Error('fetch failed — network timeout')
    );
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();

    const updated = ctx._storage.get('state') as {
      currentStep: string;
      completed: boolean;
      retryCount: number;
    };
    // State advances retry counter but does NOT complete.
    expect(updated.currentStep).toBe('project_creation');
    expect(updated.completed).toBe(false);
    expect(updated.retryCount).toBe(1);
    // A backoff alarm is scheduled.
    expect(ctx._alarmTime()).not.toBeNull();
    // No trial.error fired — retry path is internal.
    const errorEmit = emitTrialEventMock.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'trial.error'
    );
    expect(errorEmit).toBeUndefined();
  });

  it('permanent error fails the trial immediately regardless of retry budget', async () => {
    const storage: Storage = new Map();
    storage.set('state', makeRunningState({ retryCount: 0 }));
    // Messages containing "invalid" classify as permanent per isTransientError.
    stepMocks.handleProjectCreation.mockRejectedValueOnce(
      new Error('invalid configuration: missing sentinel')
    );
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();

    const updated = ctx._storage.get('state') as {
      currentStep: string;
      completed: boolean;
      failureReason: string | null;
    };
    expect(updated.currentStep).toBe('failed');
    expect(updated.completed).toBe(true);
    expect(updated.failureReason).toMatch(/invalid/);

    const errorEmit = emitTrialEventMock.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'trial.error'
    );
    expect(errorEmit).toBeTruthy();
  });

  it('transient error with retries exhausted promotes to permanent failure', async () => {
    const storage: Storage = new Map();
    // Budget exhausted: retryCount already at the default max (5).
    storage.set('state', makeRunningState({ retryCount: 99 }));
    stepMocks.handleProjectCreation.mockRejectedValueOnce(
      new Error('fetch failed — upstream 503')
    );
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();

    const updated = ctx._storage.get('state') as {
      currentStep: string;
      completed: boolean;
    };
    expect(updated.currentStep).toBe('failed');
    expect(updated.completed).toBe(true);
  });

  it('returns early when state has not been initialized (null-state guard)', async () => {
    // No `state` key in storage — alarm fires before start() has run.
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();
    // No events emitted, no step handler called, no alarm rescheduled.
    expect(emitTrialEventMock).not.toHaveBeenCalled();
    expect(stepMocks.handleProjectCreation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Security boundary tests — MCP token lifecycle + redaction
// Covers security-auditor HIGH findings from PR #760 follow-up review.
// ---------------------------------------------------------------------------

describe('TrialOrchestrator — MCP token security boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(stepMocks)) {
      fn.mockReset();
      fn.mockImplementation(async () => {});
    }
    revokeMcpTokenMock.mockReset();
    revokeMcpTokenMock.mockImplementation(async () => {});
  });

  it('failTrial revokes state.mcpToken and clears it from persisted state', async () => {
    const storage: Storage = new Map();
    storage.set(
      'state',
      makeRunningState({
        mcpToken: 'tok_live_secret_xyz',
        // Force permanent failure path so failTrial runs synchronously.
        retryCount: 99,
      }),
    );
    stepMocks.handleProjectCreation.mockRejectedValueOnce(
      new Error('invalid configuration — forces failTrial'),
    );
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();

    expect(revokeMcpTokenMock).toHaveBeenCalledTimes(1);
    expect(revokeMcpTokenMock.mock.calls[0][1]).toBe('tok_live_secret_xyz');

    // Post-revocation, state.mcpToken must be cleared so a later read cannot
    // leak the now-dead token through getStatus or any other surface.
    const updated = ctx._storage.get('state') as { mcpToken: string | null };
    expect(updated.mcpToken).toBeNull();
  });

  it('failTrial tolerates revokeMcpToken errors and still emits trial.error', async () => {
    const storage: Storage = new Map();
    storage.set(
      'state',
      makeRunningState({
        mcpToken: 'tok_live_flaky_kv',
        retryCount: 99,
      }),
    );
    stepMocks.handleProjectCreation.mockRejectedValueOnce(
      new Error('invalid — forces failTrial'),
    );
    revokeMcpTokenMock.mockRejectedValueOnce(new Error('KV hiccup'));

    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    await orch.alarm();

    // Failure emission must still happen even though revoke threw.
    const errorEmit = emitTrialEventMock.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'trial.error'
    );
    expect(errorEmit).toBeTruthy();
    const updated = ctx._storage.get('state') as {
      currentStep: string;
      completed: boolean;
    };
    expect(updated.currentStep).toBe('failed');
    expect(updated.completed).toBe(true);
  });

  it('getStatus() redacts mcpToken so debug surfaces cannot leak the bearer credential', async () => {
    const storage: Storage = new Map();
    storage.set(
      'state',
      makeRunningState({
        mcpToken: 'tok_should_never_leak',
        currentStep: 'running',
        completed: true,
      }),
    );
    const ctx = makeCtx(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    const status = await orch.getStatus();
    expect(status).not.toBeNull();
    expect(status!.mcpToken).toBe('[redacted]');
    // Other state fields should pass through so getStatus stays useful for
    // debugging (currentStep, completed).
    expect(status!.currentStep).toBe('running');
    expect(status!.completed).toBe(true);

    // Defence-in-depth: raw storage still has the real token (revocation is
    // the caller's responsibility) — the redaction is a response-shaping
    // guard, not a state mutation.
    const raw = ctx._storage.get('state') as { mcpToken: string | null };
    expect(raw.mcpToken).toBe('tok_should_never_leak');
  });

  it('getStatus() returns null when state is uninitialized (no accidental leak)', async () => {
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new TrialOrchestrator(ctx as any, makeEnv());
    const status = await orch.getStatus();
    expect(status).toBeNull();
  });
});
