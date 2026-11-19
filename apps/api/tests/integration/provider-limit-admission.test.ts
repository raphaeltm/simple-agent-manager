import { readFileSync } from 'node:fs';

import {
  newProviderLimitWait,
} from '@simple-agent-manager/scheduler-core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { TaskRunner } from '../../src/durable-objects/task-runner';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { getSelectedAgentCredentialReference } from '../../src/routes/credentials';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../src/services/admin-settings';
import { startSamAwareAgentSession } from '../../src/services/agent-session-bootstrap';
import { cancelTask } from '../../src/services/cancel-task';
import { assertProviderLimitCredentialPin } from '../../src/services/provider-limit-credential-pin';
import {
  canStartProviderLimitTaskAnyway,
  resumeProviderLimitTask,
  startProviderLimitTaskAnyway,
} from '../../src/services/provider-limit-recovery';
import { createIncompatibleCapacityFixture } from '../helpers/incompatible-agent-capacity-fixture';
import { createMemoryKv } from '../helpers/sqlite-d1';

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
  recordActivityEvent: vi.fn(async () => undefined),
  admitProjectEvent: vi.fn(async () => undefined),
}));

describe('provider admission through the TaskRunner alarm', () => {
  let fixture: ReturnType<typeof createIncompatibleCapacityFixture>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
    vi.clearAllMocks();
    fixture = createIncompatibleCapacityFixture();
    fixture.rc.env.KV = createMemoryKv();
    fixture.sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    __resetAdminSettingsCacheForTest();
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

  it.each([
    { tolerance: null, attempts: 1 },
    { tolerance: 1000, attempts: 2 },
  ])(
    'admission uses the admin reset tolerance $tolerance with default and override',
    async ({ tolerance, attempts }) => {
      if (tolerance !== null)
        await updateAdminSettings(fixture.rc.env, {
          actorUserId: 'user-1',
          changes: [{ name: 'operations.providerLimitResetWindowToleranceMs', value: tolerance }],
        });
      const reset = Date.now() + 60_000;
      rejected(reset + 30_000);
      const wait = {
        ...newProviderLimitWait({
          taskId: 'task-1',
          origin: 'callback',
          incidentId: 'original-window',
          credentialKey: 'cc_credentials:quota-key',
          previous: null,
          now: Date.now() - 120_000,
          resetsAt: reset,
        }),
        phase: 'released',
      };
      fixture.sqlite
        .prepare("UPDATE tasks SET provider_limit_wait_json=? WHERE id='task-1'")
        .run(JSON.stringify(wait));
      const run = runner();
      await run.runner.alarm();
      const row = fixture.sqlite
        .prepare("SELECT provider_limit_wait_json AS value FROM tasks WHERE id='task-1'")
        .get() as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({ phase: 'waiting', attempts });
    }
  );

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
  describe('saved callback owner approval scope', () => {
    function approveCallback() {
      fixture.sqlite.exec(`UPDATE users SET status='active' WHERE id='user-1';
        UPDATE project_members SET role='owner',status='active' WHERE project_id='project-1' AND user_id='user-1';
        INSERT INTO agent_profiles(id,user_id,project_id,name,agent_type) VALUES ('approved-profile','user-1','project-1','Approved','opencode');
        INSERT INTO skills(id,user_id,project_id,name,agent_type) VALUES ('approved-skill','user-1','project-1','Approved',NULL);
        UPDATE tasks SET agent_profile_hint='approved-profile',skill_id='approved-skill' WHERE id='task-1'`);
      fixture.state.config.agentProfileHint = 'approved-profile';
      fixture.state.config.agentType = 'opencode';
      const now = Date.now();
      const approved = {
        ...newProviderLimitWait({
          taskId: 'task-1',
          origin: 'callback',
          incidentId: 'saved-rejection',
          credentialKey: 'cc_credentials:quota-key',
          previous: null,
          now,
          resetsAt: now + 8 * 60 * 60_000,
        }),
        phase: 'released',
        scheduleKey: 'provider-limit:task-1:override:approved',
        ownerOverride: {
          credentialKey: 'cc_credentials:quota-key',
          grantedAt: now,
          profileId: 'approved-profile',
          skillId: 'approved-skill',
          agentType: 'opencode',
          expiresAt: now + 60_000,
        },
      };
      fixture.sqlite
        .prepare(
          "UPDATE tasks SET provider_limit_wait_json=?,admission_state=NULL WHERE id='task-1'"
        )
        .run(JSON.stringify(approved));
      rejected(now + 8 * 60 * 60_000);
      return JSON.stringify(approved);
    }
    function savedApproval() {
      return fixture.sqlite
        .prepare("SELECT admission_state,provider_limit_wait_json FROM tasks WHERE id='task-1'")
        .get() as { admission_state: string | null; provider_limit_wait_json: string };
    }

    it.each(['node_selection', 'agent_session'] as const)(
      'honours a scoped callback override at %s without changing live rejection evidence',
      async (step) => {
        const approved = approveCallback();
        const before = fixture.sqlite.prepare('SELECT * FROM credential_limit_windows').all();
        const run = runner(step);
        await run.runner.alarm();
        expect(savedApproval()).toEqual({
          admission_state: null,
          provider_limit_wait_json: approved,
        });
        expect(fixture.sqlite.prepare('SELECT * FROM credential_limit_windows').all()).toEqual(
          before
        );
        expect(run.state().currentStep).not.toBe(step);
        if (step === 'agent_session') expect(startSamAwareAgentSession).toHaveBeenCalledOnce();
      }
    );

    it.each([
      ['expired', null],
      ['changed profile', "UPDATE tasks SET agent_profile_hint=NULL WHERE id='task-1'"],
      ['changed skill', "UPDATE tasks SET skill_id=NULL WHERE id='task-1'"],
      ['changed profile agent', "UPDATE agent_profiles SET agent_type='claude-code'"],
      ['changed skill agent', "UPDATE skills SET agent_type='claude-code'"],
      ['invalid profile', "UPDATE agent_profiles SET project_id='other-project'"],
      ['changed runner agent', null],
      ['changed account', null],
    ])('blocks a %s approval and clears it before any initial prompt', async (change, sql) => {
      approveCallback();
      const before = fixture.sqlite.prepare('SELECT * FROM credential_limit_windows').all();
      if (sql) fixture.sqlite.exec(sql);
      if (change === 'expired') vi.advanceTimersByTime(60_000);
      if (change === 'changed runner agent') fixture.state.config.agentType = 'claude-code';
      if (change === 'changed account')
        vi.mocked(getSelectedAgentCredentialReference).mockResolvedValueOnce(
          'cc_credentials:other'
        );
      const run = runner();
      await run.runner.alarm();
      expect(run.state().currentStep).toBe('node_selection');
      expect(run.state().stepResults.nodeId).toBeNull();
      expect(run.alarm()).toBeNull();
      expect(startSamAwareAgentSession).not.toHaveBeenCalled();
      const saved = savedApproval();
      expect(saved.admission_state).toBe('provider_limit_blocked');
      expect(JSON.parse(saved.provider_limit_wait_json)).toMatchObject({
        phase: 'blocked',
        credentialKey: 'cc_credentials:quota-key',
      });
      expect(JSON.parse(saved.provider_limit_wait_json).ownerOverride).toBeUndefined();
      expect(fixture.sqlite.prepare('SELECT * FROM credential_limit_windows').all()).toEqual(
        before
      );
    });
  });

  describe('owner controls on a held, never-started task', () => {
    async function heldTask() {
      const db = drizzle(fixture.rc.env.DATABASE, { schema });
      const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task-1')).get();
      if (!task) throw new Error('Missing task');
      return { db, task };
    }
    function holdWithLiveWindow() {
      const reset = Date.now() + 8 * 60 * 60_000;
      rejected(reset);
      return reset;
    }

    it('start anyway proceeds past a still-rejected window and starts the agent once', async () => {
      const reset = holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      expect(run.alarm()).toBeGreaterThan(reset);
      const { task } = await heldTask();
      expect(task).toMatchObject({ status: 'queued', admissionState: 'provider_limit_waiting' });

      await expect(startProviderLimitTaskAnyway(fixture.rc.env, task, 'user-1')).resolves.toEqual({
        status: 'starting',
        taskId: 'task-1',
      });
      // The runner was nudged now, not at the reset.
      expect(run.alarm()).toBe(Date.now());
      await run.runner.alarm();
      expect(run.state().currentStep).not.toBe('node_selection');
      // The rejected window is untouched: the override, not a release, let it through.
      expect(
        fixture.sqlite.prepare('SELECT count(*) AS count FROM credential_limit_windows').get()
      ).toEqual({ count: 1 });
      const row = fixture.sqlite
        .prepare(
          "SELECT admission_state,provider_limit_wait_json AS value FROM tasks WHERE id='task-1'"
        )
        .get() as { admission_state: string | null; value: string };
      expect(row.admission_state).toBeNull();
      expect(JSON.parse(row.value)).toMatchObject({
        phase: 'released',
        ownerOverride: { credentialKey: 'cc_credentials:quota-key' },
      });

      // The pre-start re-check at agent_session honours the same override.
      run.state().currentStep = 'agent_session';
      run.state().stepResults.nodeId = 'existing-node';
      run.state().stepResults.workspaceId = 'old-workspace';
      fixture.sqlite.exec(
        "UPDATE tasks SET status='delegated',workspace_id='old-workspace' WHERE id='task-1'"
      );
      await run.runner.alarm();
      expect(startSamAwareAgentSession).toHaveBeenCalledOnce();
      expect(run.state().currentStep).toBe('running');
      await expect(
        assertProviderLimitCredentialPin(
          fixture.rc.env,
          'old-workspace',
          'cc_credentials:quota-key'
        )
      ).resolves.toBeUndefined();
    });

    it('without the override the same rejected window keeps holding (control)', async () => {
      holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      await run.runner.nudge('control');
      await run.runner.alarm();
      expect(run.state().currentStep).toBe('node_selection');
      expect(
        fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
      ).toEqual({ admission_state: 'provider_limit_waiting' });
    });

    it('a credential change after the override blocks for review instead of starting', async () => {
      holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      const { task } = await heldTask();
      await startProviderLimitTaskAnyway(fixture.rc.env, task, 'user-1');
      vi.mocked(getSelectedAgentCredentialReference).mockResolvedValueOnce(
        'cc_credentials:other-account'
      );
      await run.runner.alarm();
      expect(run.state().currentStep).toBe('node_selection');
      expect(run.alarm()).toBeNull();
      expect(
        fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
      ).toEqual({ admission_state: 'provider_limit_blocked' });
    });

    it('refuses non-owners, blocked waits and callback-origin waits without changing the task', async () => {
      holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      const { task } = await heldTask();
      await expect(startProviderLimitTaskAnyway(fixture.rc.env, task, 'user-2')).rejects.toThrow(
        'Only the task owner'
      );
      const wait = JSON.parse(task.providerLimitWaitJson ?? 'null');
      for (const variant of [
        { ...wait, phase: 'blocked' },
        { ...wait, origin: 'callback' },
      ]) {
        const json = JSON.stringify(variant);
        await expect(
          startProviderLimitTaskAnyway(
            fixture.rc.env,
            { ...task, providerLimitWaitJson: json },
            'user-1'
          )
        ).rejects.toThrow('not waiting on a provider limit');
      }
      expect(
        fixture.sqlite
          .prepare(
            "SELECT admission_state,provider_limit_wait_json AS value FROM tasks WHERE id='task-1'"
          )
          .get()
      ).toEqual({ admission_state: 'provider_limit_waiting', value: task.providerLimitWaitJson });
    });

    it('restores the hold when the runner cannot be nudged', async () => {
      holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      const { task } = await heldTask();
      vi.spyOn(run.runner, 'nudge').mockResolvedValueOnce(false);
      await expect(startProviderLimitTaskAnyway(fixture.rc.env, task, 'user-1')).rejects.toThrow(
        'task runner is unavailable'
      );
      expect(
        fixture.sqlite
          .prepare(
            "SELECT admission_state,provider_limit_wait_json AS value FROM tasks WHERE id='task-1'"
          )
          .get()
      ).toEqual({ admission_state: 'provider_limit_waiting', value: task.providerLimitWaitJson });
    });

    it('a start anyway landing while a hold alarm is mid-flight is not overwritten by the old retry', async () => {
      const reset = holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      expect(run.alarm()).toBeGreaterThan(reset);
      // Hold the next alarm inside its credential lookup: the load-bearing midpoint.
      let release!: () => void;
      vi.mocked(getSelectedAgentCredentialReference).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve('cc_credentials:quota-key');
          })
      );
      const inFlight = run.runner.alarm();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const { task } = await heldTask();
      await startProviderLimitTaskAnyway(fixture.rc.env, task, 'user-1');
      expect(run.alarm()).toBe(Date.now());
      release();
      await inFlight;
      // Without the re-read the stale branch re-armed the alarm at the old reset.
      expect(run.alarm()).toBeLessThanOrEqual(Date.now());
      await run.runner.alarm();
      expect(run.state().currentStep).not.toBe('node_selection');
    });

    it('an override does not survive a block: switching back to the old account still needs review', async () => {
      holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      const { task } = await heldTask();
      await startProviderLimitTaskAnyway(fixture.rc.env, task, 'user-1');
      vi.mocked(getSelectedAgentCredentialReference).mockResolvedValueOnce(
        'cc_credentials:other-account'
      );
      await run.runner.alarm();
      const blocked = fixture.sqlite
        .prepare("SELECT provider_limit_wait_json AS value FROM tasks WHERE id='task-1'")
        .get() as { value: string };
      expect(JSON.parse(blocked.value)).toMatchObject({ phase: 'blocked' });
      expect(JSON.parse(blocked.value).ownerOverride).toBeUndefined();
      // Back on the original account, the blocked wait is not silently bypassed.
      await run.runner.nudge('switched back');
      await run.runner.alarm();
      expect(run.state().currentStep).toBe('node_selection');
    });

    it('cancelling a held task means its reset alarm provisions nothing', async () => {
      const reset = holdWithLiveWindow();
      const run = runner();
      await run.runner.alarm();
      const { db, task } = await heldTask();
      await cancelTask(fixture.rc.env, db, task, 'user-1');
      expect(fixture.sqlite.prepare("SELECT status FROM tasks WHERE id='task-1'").get()).toEqual({
        status: 'cancelled',
      });
      fixture.sqlite.exec('DELETE FROM credential_limit_windows');
      vi.setSystemTime(reset + 60_000);
      await run.runner.alarm();
      // A released, uncancelled task leaves node_selection on this alarm (first test above);
      // the cancelled one's runner is retired without advancing or re-arming.
      expect(run.state().currentStep).toBe('node_selection');
      expect(run.alarm()).toBeNull();
      expect(startSamAwareAgentSession).not.toHaveBeenCalled();
      expect(fixture.sqlite.prepare("SELECT status FROM tasks WHERE id='task-1'").get()).toEqual({
        status: 'cancelled',
      });
    });
  });
});

describe('canStartProviderLimitTaskAnyway', () => {
  const base = newProviderLimitWait({
    taskId: 'task-1',
    origin: 'admission',
    incidentId: 'admission:task-1:1',
    credentialKey: 'cc_credentials:quota-key',
    previous: null,
    now: 1_000,
    resetsAt: 1_000 + 60 * 60_000,
  });
  it.each([
    ['queued admission wait', 'queued', 'provider_limit_waiting', base, true],
    ['delegated admission wait', 'delegated', 'provider_limit_waiting', base, true],
    ['blocked wait', 'queued', 'provider_limit_blocked', { ...base, phase: 'blocked' }, false],
    [
      'callback-origin wait',
      'queued',
      'provider_limit_waiting',
      { ...base, origin: 'callback' },
      false,
    ],
    ['started task', 'in_progress', 'provider_limit_waiting', base, false],
    ['sleeping task', 'sleeping', 'provider_limit_waiting', base, false],
    ['released hold', 'queued', null, { ...base, phase: 'released' }, false],
    ['no wait', 'queued', 'provider_limit_waiting', null, false],
    [
      'wait with no credential',
      'queued',
      'provider_limit_waiting',
      { ...base, credentialKey: null },
      false,
    ],
  ] as const)('%s -> %s', (_name, status, admissionState, wait, expected) => {
    expect(
      canStartProviderLimitTaskAnyway(
        { status, admissionState },
        wait as Parameters<typeof canStartProviderLimitTaskAnyway>[1]
      )
    ).toBe(expected);
  });
});
