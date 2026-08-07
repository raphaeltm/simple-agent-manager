import { beforeEach, describe, expect, it, vi } from 'vitest';

const instantSessionMocks = vi.hoisted(() => ({
  continueInstantSessionLaunch: vi.fn(),
  finalizeInstantLaunch: vi.fn(),
  markInstantLaunchFailed: vi.fn(),
}));

vi.mock('../../../src/services/instant-session', () => ({
  continueInstantSessionLaunch: instantSessionMocks.continueInstantSessionLaunch,
  finalizeInstantLaunch: instantSessionMocks.finalizeInstantLaunch,
  markInstantLaunchFailed: instantSessionMocks.markInstantLaunchFailed,
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({ marker: 'db' })) }));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  INSTANT_LAUNCH_STORAGE_KEY,
  type InstantLaunchJob,
  runInstantLaunchAlarm,
} from '../../../src/durable-objects/task-runner/instant-launch';
import type { Env } from '../../../src/env';

function makeAccepted() {
  return {
    taskId: 'task-1',
    runtime: 'cf-container',
    nodeId: 'node-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    chatSessionId: 'chat-1',
    agentType: 'claude-code',
    containerId: 'node-1',
    workspaceUrl: 'https://ws-ws-1.example.com',
    branch: 'main',
    workspaceName: 'instant chat',
    workspaceDir: '/workspaces/repo',
    nodeCallbackToken: 'token',
    startedAt: 0,
    gitSource: { repoProvider: 'github' },
  } as never;
}

function makeJob(overrides: Partial<InstantLaunchJob> = {}): InstantLaunchJob {
  return {
    version: 1,
    input: { taskId: 'task-1' } as never,
    accepted: makeAccepted(),
    attempted: false,
    milestone: 'pending',
    agentSessionId: null,
    createdAt: 1_000,
    ...overrides,
  };
}

/** In-memory stand-in for DurableObjectStorage (only the used surface). */
function makeStorage(initial?: InstantLaunchJob) {
  const map = new Map<string, unknown>();
  if (initial) map.set(INSTANT_LAUNCH_STORAGE_KEY, initial);
  return {
    map,
    put: vi.fn(async (key: string, value: unknown) => {
      // Deep-clone like real DO storage: later in-memory mutation of the job
      // object must not retroactively change what was persisted.
      map.set(key, structuredClone(value));
    }),
    get: vi.fn(async (key: string) => map.get(key)),
    delete: vi.fn(async (key: string) => map.delete(key)),
  };
}

const env = {} as Env;

const expectedRef = {
  taskId: 'task-1',
  projectId: 'proj-1',
  chatSessionId: 'chat-1',
  workspaceId: 'ws-1',
  nodeId: 'node-1',
  containerId: 'node-1',
};

describe('runInstantLaunchAlarm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instantSessionMocks.continueInstantSessionLaunch.mockResolvedValue(undefined);
    instantSessionMocks.finalizeInstantLaunch.mockResolvedValue(undefined);
    instantSessionMocks.markInstantLaunchFailed.mockResolvedValue(undefined);
  });

  it('marks attempted durably BEFORE running the launch, then clears the job on success', async () => {
    const job = makeJob();
    const storage = makeStorage(job);
    let attemptedWhenLaunchRan: boolean | undefined;
    instantSessionMocks.continueInstantSessionLaunch.mockImplementationOnce(async () => {
      const persisted = storage.map.get(INSTANT_LAUNCH_STORAGE_KEY) as InstantLaunchJob;
      attemptedWhenLaunchRan = persisted.attempted;
    });

    await runInstantLaunchAlarm(env, storage as never, job);

    // The interruption classifier only works if `attempted` was durable before
    // the first phase could die mid-flight.
    expect(attemptedWhenLaunchRan).toBe(true);
    expect(instantSessionMocks.continueInstantSessionLaunch).toHaveBeenCalledTimes(1);
    expect(storage.map.has(INSTANT_LAUNCH_STORAGE_KEY)).toBe(false);
    expect(instantSessionMocks.markInstantLaunchFailed).not.toHaveBeenCalled();
  });

  it('persists milestones through the launch hooks', async () => {
    const job = makeJob();
    const storage = makeStorage(job);
    const seenMilestones: string[] = [];
    instantSessionMocks.continueInstantSessionLaunch.mockImplementationOnce(
      async (
        _db: unknown,
        _env: unknown,
        _input: unknown,
        _accepted: unknown,
        hooks: {
          beforeAgentBootstrap: () => Promise<void>;
          afterAgentBootstrap: (id: string) => Promise<void>;
        }
      ) => {
        await hooks.beforeAgentBootstrap();
        seenMilestones.push(
          (storage.map.get(INSTANT_LAUNCH_STORAGE_KEY) as InstantLaunchJob).milestone
        );
        await hooks.afterAgentBootstrap('agent-session-1');
        const persisted = storage.map.get(INSTANT_LAUNCH_STORAGE_KEY) as InstantLaunchJob;
        seenMilestones.push(persisted.milestone);
        expect(persisted.agentSessionId).toBe('agent-session-1');
      }
    );

    await runInstantLaunchAlarm(env, storage as never, job);

    expect(seenMilestones).toEqual(['bootstrap_started', 'bootstrap_complete']);
  });

  it('REGRESSION (cancellation): an interrupted pre-bootstrap attempt fails closed with full teardown, never stuck queued', async () => {
    // Simulates the DO dying mid-launch (the durable equivalent of the
    // production waitUntil cancellation): attempted=true persisted, milestone
    // never advanced, alarm re-fires.
    const job = makeJob({ attempted: true, milestone: 'pending' });
    const storage = makeStorage(job);

    await runInstantLaunchAlarm(env, storage as never, job);

    expect(instantSessionMocks.continueInstantSessionLaunch).not.toHaveBeenCalled();
    expect(instantSessionMocks.markInstantLaunchFailed).toHaveBeenCalledWith(
      expect.anything(),
      env,
      expectedRef,
      expect.stringContaining('interrupted before the agent started')
    );
    expect(storage.map.has(INSTANT_LAUNCH_STORAGE_KEY)).toBe(false);
  });

  it('fails closed on an attempt interrupted mid-bootstrap (ambiguous agent state)', async () => {
    const job = makeJob({ attempted: true, milestone: 'bootstrap_started' });
    const storage = makeStorage(job);

    await runInstantLaunchAlarm(env, storage as never, job);

    expect(instantSessionMocks.continueInstantSessionLaunch).not.toHaveBeenCalled();
    expect(instantSessionMocks.markInstantLaunchFailed).toHaveBeenCalledWith(
      expect.anything(),
      env,
      expectedRef,
      expect.stringContaining('bootstrap_started')
    );
    expect(storage.map.has(INSTANT_LAUNCH_STORAGE_KEY)).toBe(false);
  });

  it('finalizes only (no relaunch, no teardown) when interrupted after agent bootstrap', async () => {
    const job = makeJob({
      attempted: true,
      milestone: 'bootstrap_complete',
      agentSessionId: 'agent-session-1',
    });
    const storage = makeStorage(job);

    await runInstantLaunchAlarm(env, storage as never, job);

    expect(instantSessionMocks.continueInstantSessionLaunch).not.toHaveBeenCalled();
    expect(instantSessionMocks.markInstantLaunchFailed).not.toHaveBeenCalled();
    expect(instantSessionMocks.finalizeInstantLaunch).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'ws-1',
      'node-1'
    );
    expect(storage.map.has(INSTANT_LAUNCH_STORAGE_KEY)).toBe(false);
  });

  it('keeps the job and rethrows when the finalize-only tail fails, so the alarm retry re-runs it', async () => {
    const job = makeJob({ attempted: true, milestone: 'bootstrap_complete' });
    const storage = makeStorage(job);
    instantSessionMocks.finalizeInstantLaunch.mockRejectedValueOnce(new Error('d1 down'));

    await expect(runInstantLaunchAlarm(env, storage as never, job)).rejects.toThrow('d1 down');

    expect(storage.map.has(INSTANT_LAUNCH_STORAGE_KEY)).toBe(true);
  });

  it('clears the job without rethrowing when the launch itself fails (its catch already cleaned up)', async () => {
    const job = makeJob();
    const storage = makeStorage(job);
    instantSessionMocks.continueInstantSessionLaunch.mockRejectedValueOnce(
      new Error('clone timed out')
    );

    await expect(runInstantLaunchAlarm(env, storage as never, job)).resolves.toBeUndefined();

    // The continuation's own catch performs the teardown; the alarm must not
    // retry a non-idempotent launch against a destroyed container.
    expect(instantSessionMocks.markInstantLaunchFailed).not.toHaveBeenCalled();
    expect(storage.map.has(INSTANT_LAUNCH_STORAGE_KEY)).toBe(false);
  });
});
