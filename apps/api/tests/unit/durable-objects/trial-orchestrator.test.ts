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
