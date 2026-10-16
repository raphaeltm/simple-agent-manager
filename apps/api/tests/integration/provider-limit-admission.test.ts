import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskRunner } from '../../src/durable-objects/task-runner';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { getSelectedAgentCredentialReference } from '../../src/routes/credentials';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { startSamAwareAgentSession } from '../../src/services/agent-session-bootstrap';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { createIncompatibleCapacityFixture } from '../helpers/incompatible-agent-capacity-fixture';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: unknown
    ) {}
  },
}));
vi.mock('../../src/routes/credentials', () => ({
  getSelectedAgentCredentialReference: vi.fn(async () => 'cc_credentials:quota-key'),
}));
vi.mock('../../src/services/agent-session-bootstrap', () => ({
  startSamAwareAgentSession: vi.fn(async () => ({
    agentSessionId: 'new-session',
    acpSessionId: null,
    mcpToken: 'test-token',
    agentStarted: true,
    initialPromptSent: true,
  })),
}));
vi.mock('../../src/services/project-data', () => ({ persistMessage: vi.fn(async () => 'notice') }));

describe('provider admission through the TaskRunner alarm', () => {
  let fixture: ReturnType<typeof createIncompatibleCapacityFixture>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
    vi.clearAllMocks();
    fixture = createIncompatibleCapacityFixture();
  });
  afterEach(() => {
    fixture.sqlite.close();
    vi.useRealTimers();
  });
  function runner(step: TaskRunnerState['currentStep'] = 'node_selection') {
    let persisted = structuredClone({ ...fixture.state, currentStep: step });
    if (step === 'agent_session') {
      persisted.stepResults.nodeId = 'existing-node';
      persisted.stepResults.workspaceId = 'old-workspace';
      fixture.sqlite.exec(
        "UPDATE tasks SET status='delegated',workspace_id='old-workspace' WHERE id='task-1'"
      );
    }
    let alarm: number | null = null;
    const storage = {
      get: vi.fn(async () => structuredClone(persisted)),
      put: vi.fn(async (_key: string, value: TaskRunnerState) => {
        persisted = structuredClone(value);
      }),
      setAlarm: vi.fn(async (value: number | Date) => {
        alarm = Number(value);
      }),
      getAlarm: vi.fn(async () => alarm),
      deleteAlarm: vi.fn(async () => {
        alarm = null;
      }),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(storage)),
    };
    fixture.rc.env.KV = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace;
    const ctx = { storage, waitUntil: vi.fn() } as unknown as DurableObjectState;
    fixture.rc.env.TASK_RUN_CLEANUP_DELAY_MS = '0';
    const instance = new TaskRunner(ctx, fixture.rc.env);
    fixture.rc.env.TASK_RUNNER = {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ getStatus: () => instance.getStatus() })),
    } as unknown as Env['TASK_RUNNER'];
    return {
      runner: instance,
      state: () => persisted,
      alarm: () => alarm,
    };
  }
  function rejected(reset: number | null) {
    fixture.sqlite
      .prepare(
        `INSERT INTO credential_limit_windows(project_id,credential_reference,window_type,status,resets_at,observed_at,updated_at) VALUES ('project-1','cc_credentials:quota-key','codex.primary','rejected',?,?,?)`
      )
      .run(reset, Date.now(), Date.now());
  }
  it('holds a new dispatch without provisioning, protects it from the real stuck sweep, and releases at reset', async () => {
    const reset = Date.now() + 4 * 60 * 60_000;
    rejected(reset);
    const run = runner();
    await run.runner.alarm();
    expect(run.state().currentStep).toBe('node_selection');
    expect(run.state().stepResults.nodeId).toBeNull();
    expect(run.alarm()).toBeGreaterThan(reset);
    expect(
      fixture.sqlite.prepare("SELECT status,admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ status: 'queued', admission_state: 'provider_limit_waiting' });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    const sweep = await recoverStuckTasks(fixture.rc.env);
    expect(sweep.errors).toBe(0);
    expect(fixture.sqlite.prepare("SELECT status FROM tasks WHERE id='task-1'").get()).toEqual({
      status: 'queued',
    });
    const alarm = run.alarm();
    if (alarm === null) throw new Error('Expected scheduled retry');
    vi.setSystemTime(alarm);
    await run.runner.alarm();
    expect(run.state().currentStep).not.toBe('node_selection');
    expect(
      fixture.sqlite
        .prepare("SELECT provider_limit_wait_json AS value FROM tasks WHERE id='task-1'")
        .get()
    ).toMatchObject({ value: expect.stringContaining('released') });
    expect(getSelectedAgentCredentialReference).toHaveBeenCalled();
  });
  it('rechecks a rejection observed after provisioning before the sole initial start', async () => {
    const run = runner('agent_session');
    const reset = Date.now() + 60_000;
    rejected(reset);
    await run.runner.alarm();
    expect(startSamAwareAgentSession).not.toHaveBeenCalled();
    expect(run.state().stepResults.agentStarted).toBe(false);
    expect(
      fixture.sqlite.prepare("SELECT admission_reason FROM tasks WHERE id='task-1'").get()
    ).toMatchObject({
      admission_reason: expect.stringContaining('Blocked before provider prompt'),
    });
    vi.setSystemTime(run.alarm()!);
    await run.runner.alarm();
    expect(startSamAwareAgentSession).toHaveBeenCalledTimes(1);
    expect(run.state().currentStep).toBe('running');
    await run.runner.alarm();
    expect(startSamAwareAgentSession).toHaveBeenCalledTimes(1);
  });
  it('malformed retained wait blocks before provisioning', async () => {
    fixture.sqlite.exec("UPDATE tasks SET provider_limit_wait_json='{malformed' WHERE id='task-1'");
    const run = runner();
    await run.runner.alarm();
    expect(run.state().currentStep).toBe('node_selection');
    expect(run.alarm()).toBeNull();
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: 'provider_limit_blocked' });
  });
  it('holds from the durable task intent when the observation producer has not committed', async () => {
    const wait = newProviderLimitWait({
      taskId: 'old-task',
      origin: 'callback',
      incidentId: 'old-workspace:old-agent-session:1',
      credentialKey: 'cc_credentials:quota-key',
      previous: null,
      now: Date.now(),
      resetsAt: Date.now() + 60_000,
    });
    fixture.sqlite
      .prepare(
        "UPDATE tasks SET status='in_progress',admission_state='provider_limit_waiting',provider_limit_wait_json=? WHERE id='old-task'"
      )
      .run(JSON.stringify(wait));
    const run = runner();
    await run.runner.alarm();
    expect(run.state().currentStep).toBe('node_selection');
    expect(run.alarm()).toBeGreaterThan(wait.resetsAt!);
  });
  it('does not hold an ordinary dispatch when no rejected credential window exists', async () => {
    const run = runner();
    await run.runner.alarm();
    expect(getSelectedAgentCredentialReference).not.toHaveBeenCalled();
    expect(run.state().currentStep).not.toBe('node_selection');
  });
  it('releases unknown-reset admission when stale evidence expires', async () => {
    rejected(null);
    const run = runner();
    await run.runner.alarm();
    vi.setSystemTime(run.alarm()!);
    await run.runner.alarm();
    expect(run.state().currentStep).not.toBe('node_selection');
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: null });
  });
  it('blocks renewed unknown rejections after the consecutive wait budget', async () => {
    rejected(null);
    const run = runner();
    for (let attempt = 0; attempt < 4; attempt++) {
      await run.runner.alarm();
      expect(run.state().currentStep).toBe('node_selection');
      if (attempt < 3) {
        vi.setSystemTime(run.alarm()!);
        fixture.sqlite
          .prepare('UPDATE credential_limit_windows SET observed_at=?,updated_at=?')
          .run(Date.now(), Date.now());
      }
    }
    expect(run.alarm()).toBeNull();
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: 'provider_limit_blocked' });
    expect(run.state().stepResults.nodeId).toBeNull();
  });
  it('blocks credential changes while an unknown reset is held', async () => {
    rejected(null);
    const run = runner();
    await run.runner.alarm();
    const first = run.alarm();
    expect(first).toBe(Date.now() + 5 * 60_000);
    vi.mocked(getSelectedAgentCredentialReference).mockResolvedValueOnce('cc_credentials:other');
    await run.runner.alarm();
    expect(run.alarm()).toBeNull();
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: 'provider_limit_blocked' });
  });
});
