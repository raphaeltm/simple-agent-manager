import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { TaskRunner } from '../../src/durable-objects/task-runner';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { getSelectedAgentCredentialReference } from '../../src/routes/credentials';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { startSamAwareAgentSession } from '../../src/services/agent-session-bootstrap';
import { assertProviderLimitCredentialPin } from '../../src/services/provider-limit-credential-pin';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { resumeProviderLimitTask } from '../../src/services/provider-limit-recovery';
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
vi.mock('../../src/services/project-data', () => ({
  persistMessage: vi.fn(async () => 'notice'),
  syncProviderLimitAttention: vi.fn(),
  listActiveAttentionMarkers: vi.fn(async () => []),
  createAttentionMarker: vi.fn(),
  resolveSessionAttentionMarkers: vi.fn(),
  sleepSession: vi.fn(),
}));

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
      get: vi.fn(() => ({
        getStatus: () => instance.getStatus(),
        nudge: (reason?: string) => instance.nudge(reason),
      })),
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
  it('owner resumes a fresh admission block without inventing a snapshot or sleeping state', async () => {
    fixture.state.config.chatSessionId = 'chat-1';
    fixture.sqlite.exec("UPDATE tasks SET chat_session_id='chat-1' WHERE id='task-1'");
    rejected(null);
    const run = runner();
    for (let attempt = 0; attempt < 4; attempt++) {
      await run.runner.alarm();
      if (attempt < 3) {
        vi.setSystemTime(run.alarm()!);
        fixture.sqlite
          .prepare('UPDATE credential_limit_windows SET observed_at=?,updated_at=?')
          .run(Date.now(), Date.now());
      }
    }
    const db = drizzle(fixture.rc.env.DATABASE, { schema });
    const blocked = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task-1')).get();
    if (!blocked) throw new Error('Missing blocked task');
    expect(blocked).toMatchObject({ status: 'queued', admissionState: 'provider_limit_blocked' });
    expect(fixture.sqlite.prepare('SELECT count(*) AS count FROM session_snapshots').get()).toEqual(
      { count: 0 }
    );
    expect(await resumeProviderLimitTask(fixture.rc.env, blocked, 'user-1')).toEqual({
      status: 'waking',
      taskId: 'task-1',
    });
    expect(run.alarm()).not.toBeNull();
    fixture.sqlite.exec('DELETE FROM credential_limit_windows');
    vi.setSystemTime(run.alarm()!);
    await run.runner.alarm();
    expect(run.state().currentStep).not.toBe('node_selection');
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: null });
  });

  it('owner-approved released wait repins the selected credential before initial credential injection', async () => {
    const run = runner('agent_session');
    const wait = {
      ...newProviderLimitWait({
        taskId: 'task-1',
        origin: 'callback',
        incidentId: 'old-rejection',
        credentialKey: 'cc_credentials:old-account',
        previous: null,
        now: Date.now(),
        resetsAt: null,
      }),
      phase: 'released',
      scheduleKey: 'provider-limit:task-1:resume:owner-approved',
    };
    fixture.sqlite
      .prepare("UPDATE tasks SET provider_limit_wait_json=? WHERE id='task-1'")
      .run(JSON.stringify(wait));
    await run.runner.alarm();
    expect(startSamAwareAgentSession).toHaveBeenCalledOnce();
    const row = fixture.sqlite
      .prepare("SELECT provider_limit_wait_json AS value FROM tasks WHERE id='task-1'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({
      ...wait,
      credentialKey: 'cc_credentials:quota-key',
      scheduleKey: expect.any(String),
    });
    expect(JSON.parse(row.value).scheduleKey).not.toBe(wait.scheduleKey);
    expect(JSON.parse(row.value).scheduleKey).not.toContain(':resume:');
    await expect(
      assertProviderLimitCredentialPin(fixture.rc.env, 'old-workspace', 'cc_credentials:quota-key')
    ).resolves.toBeUndefined();
    await expect(
      assertProviderLimitCredentialPin(fixture.rc.env, 'old-workspace', 'cc_credentials:unapproved')
    ).rejects.toThrow('Provider limit recovery requires review');
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: 'provider_limit_blocked' });
  });

  it('owner-approved platform selection clears the old BYO pin before initial credential injection', async () => {
    const run = runner('agent_session');
    const approved = {
      ...newProviderLimitWait({
        taskId: 'task-1',
        origin: 'callback',
        incidentId: 'old-rejection',
        credentialKey: 'cc_credentials:old-account',
        previous: null,
        now: Date.now(),
        resetsAt: null,
      }),
      phase: 'released',
      scheduleKey: 'provider-limit:task-1:resume:owner-approved',
    };
    fixture.sqlite
      .prepare("UPDATE tasks SET provider_limit_wait_json=? WHERE id='task-1'")
      .run(JSON.stringify(approved));
    // Platform selection intentionally has no BYO credential reference.
    vi.mocked(getSelectedAgentCredentialReference).mockResolvedValueOnce(null);
    await run.runner.alarm();
    expect(startSamAwareAgentSession).toHaveBeenCalledOnce();
    expect(
      fixture.sqlite
        .prepare(
          "SELECT provider_limit_wait_json AS value,admission_state FROM tasks WHERE id='task-1'"
        )
        .get()
    ).toEqual({ value: null, admission_state: null });
    await expect(
      assertProviderLimitCredentialPin(
        fixture.rc.env,
        'old-workspace',
        'platform_credentials:platform-account'
      )
    ).resolves.toBeUndefined();
  });

  it('owner approval is consumed before provisioning so a later credential change blocks the initial start', async () => {
    // The owner approved the currently selected account, so consumption must
    // happen even when no key change is needed on the first admission.
    const approved = {
      ...newProviderLimitWait({
        taskId: 'task-1',
        origin: 'callback',
        incidentId: 'old-rejection',
        credentialKey: 'cc_credentials:quota-key',
        previous: null,
        now: Date.now(),
        resetsAt: null,
      }),
      phase: 'released',
      scheduleKey: 'provider-limit:task-1:resume:owner-approved',
    };
    fixture.sqlite
      .prepare("UPDATE tasks SET provider_limit_wait_json=? WHERE id='task-1'")
      .run(JSON.stringify(approved));
    const run = runner();
    await run.runner.alarm();
    expect(run.state().currentStep).not.toBe('node_selection');
    // Complete the provisioning boundary with the fixture's allocated workspace.
    run.state().currentStep = 'agent_session';
    run.state().stepResults.nodeId = 'existing-node';
    run.state().stepResults.workspaceId = 'old-workspace';
    fixture.sqlite.exec(
      "UPDATE tasks SET status='delegated',workspace_id='old-workspace' WHERE id='task-1'"
    );
    vi.mocked(getSelectedAgentCredentialReference).mockResolvedValueOnce(
      'cc_credentials:unapproved'
    );
    await run.runner.alarm();
    expect(startSamAwareAgentSession).not.toHaveBeenCalled();
    expect(run.alarm()).toBeNull();
    expect(
      fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
    ).toEqual({ admission_state: 'provider_limit_blocked' });
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
