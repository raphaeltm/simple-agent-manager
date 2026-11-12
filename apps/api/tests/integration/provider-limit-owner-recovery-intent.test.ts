/** Owner HTTP action -> native D1 CAS + ProjectData session authority -> retained runner. */
// Register the shared external-boundary doubles before importing recovery consumers.
import '../helpers/provider-limit-owner-resume-harness';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSession } from '../../src/durable-objects/project-data/session-reads';
import type { Env } from '../../src/env';
import { recoverStuckTasks, selectStuckTaskCandidates } from '../../src/scheduled/stuck-tasks';
import { preserveProviderLimitWait } from '../../src/services/provider-limit-reconciliation';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

describe('durable owner-approved provider recovery', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;
  let d1: Database.Database;
  let env: Env;
  let local: Database.Database;
  let task: typeof harness.task;
  let claim: typeof harness.claim;
  let wait: typeof harness.wait;
  let resume: typeof harness.resume;
  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.nudge.mockResolvedValue(true);
    boundary.status.mockResolvedValue({ taskId: 'task-1' });
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    harness = await createOwnerResumeHarness({
      KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      } as unknown as KVNamespace,
    });
    ({ d1, local, env, task, claim, wait, resume } = harness);
    boundary.sql.exec(
      "INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES ('original-message','chat-1','user','Deliver this original message once',1)"
    );
  });
  afterEach(() => harness.close());

  async function interruptAfterRelease() {
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("admission_state='provider_limit_recovery_pending'")) return statement;
      return {
        ...statement,
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return {
            ...bound,
            run: async () => {
              await bound.run();
              throw new Error('worker interrupted after committed owner release');
            },
          };
        },
      } as D1PreparedStatement;
    });
    try {
      expect((await resume()).status).toBe(500);
    } finally {
      fault.mockRestore();
    }
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(wait().phase).toBe('released');
    expect(wait().ownerOverride).toMatchObject({
      recoveryPending: true,
      ownerUserId: 'user-1',
      snapshotId: 'snapshot-1',
    });
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
    return task().provider_limit_wait_json;
  }

  it('retains the same approval across a transient canonical profile lookup failure', async () => {
    const receipt = await interruptAfterRelease();
    const before = claim();
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('"agent_profiles"')) throw new Error('transient profile lookup');
      return prepare(sql);
    });
    await expect(preserveProviderLimitWait(env, 'task-1', Date.now())).rejects.toThrow(
      'transient profile lookup'
    );
    fault.mockRestore();
    expect(task().provider_limit_wait_json).toBe(receipt);
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(claim()).toEqual(before);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(boundary.nudge).toHaveBeenCalledOnce();
    expect(task().admission_state).toBeNull();
    expect(task().provider_limit_wait_json).toBe(receipt);
  });

  it('repairs a provably stale runner on the current claim instead of acknowledging the old attempt', async () => {
    d1.exec('UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP');
    const receipt = await interruptAfterRelease();
    const retained = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockResolvedValueOnce({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      completed: false,
      currentStep: 'workspace_ready',
      config: { recoveryAttemptId: 'older-claim', resumeSnapshotChatSessionId: 'chat-1' },
    });
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      recoveryAttemptId: 'existing-claim',
      providerLimitRecoveryApproval: { receipt },
    });
    expect(boundary.nudge).toHaveBeenCalledTimes(2);
    expect(task()).toMatchObject({ admission_state: null, provider_limit_wait_json: receipt });
    expect(claim()).toEqual(retained);
  });

  it.each([
    'equal attempt',
    'task',
    'project',
    'user',
    'session',
    'nonrecovery',
    'empty attempt',
    'malformed step',
    'malformed completion',
  ])('never repairs a false nudge with unproven or nonstale %s evidence', async (changed) => {
    const receipt = await interruptAfterRelease();
    const retained = claim();
    const status = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      completed: false as unknown,
      currentStep: 'workspace_ready' as unknown,
      config: {
        recoveryAttemptId: 'older-claim' as unknown,
        resumeSnapshotChatSessionId: 'chat-1' as unknown,
      },
    };
    if (changed === 'equal attempt') status.config.recoveryAttemptId = 'existing-claim';
    if (changed === 'task') status.taskId = 'foreign-task';
    if (changed === 'project') status.projectId = 'foreign-project';
    if (changed === 'user') status.userId = 'foreign-owner';
    if (changed === 'session') status.config.resumeSnapshotChatSessionId = 'foreign-chat';
    if (changed === 'nonrecovery') status.config.recoveryAttemptId = null;
    if (changed === 'empty attempt') status.config.recoveryAttemptId = '';
    if (changed === 'malformed step') status.currentStep = null;
    if (changed === 'malformed completion') status.completed = undefined;
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockResolvedValueOnce(status);
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(boundary.start).not.toHaveBeenCalled();
    expect(task()).toMatchObject({
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(claim()).toEqual(retained);
  });

  it('starts a missing runner on its existing queued wake claim without renewing or replacing that claim', async () => {
    d1.exec('UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP');
    const receipt = await interruptAfterRelease();
    const retained = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockResolvedValueOnce(null);
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      recoveryAttemptId: 'existing-claim',
      providerLimitRecoveryApproval: { receipt },
    });
    expect(boundary.nudge).toHaveBeenCalledTimes(2);
    expect(task()).toMatchObject({ admission_state: null, provider_limit_wait_json: receipt });
    expect(claim()).toEqual(retained);
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(boundary.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['existing', { completed: false }],
    ['terminal', { completed: true }],
    ['ambiguous', undefined],
  ])(
    'does not infer missing state from a false nudge with %s runner evidence',
    async (_label, status) => {
      const receipt = await interruptAfterRelease();
      const retained = claim();
      boundary.nudge.mockResolvedValueOnce(false);
      boundary.status.mockResolvedValueOnce(status);
      await preserveProviderLimitWait(env, 'task-1', Date.now());
      expect(boundary.start).not.toHaveBeenCalled();
      expect(task()).toMatchObject({
        admission_state: 'provider_limit_recovery_pending',
        provider_limit_wait_json: receipt,
      });
      expect(claim()).toEqual(retained);
    }
  );

  it('preserves the same pending approval when the authoritative runner probe fails', async () => {
    const receipt = await interruptAfterRelease();
    const retained = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockRejectedValueOnce(new Error('runner probe unavailable'));
    await expect(preserveProviderLimitWait(env, 'task-1', Date.now())).rejects.toThrow(
      'runner probe unavailable'
    );
    expect(boundary.start).not.toHaveBeenCalled();
    expect(task()).toMatchObject({
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(claim()).toEqual(retained);
  });

  it.each([
    ['claim replaced', "UPDATE session_snapshots SET recovery_attempt_id='newer-claim'"],
    ['task cancelled', "UPDATE tasks SET status='cancelled'"],
    [
      'consent replaced',
      "UPDATE tasks SET provider_limit_wait_json=json_set(provider_limit_wait_json,'$.scheduleKey','new-consent')",
    ],
  ])(
    'does not bootstrap a missing runner if %s while presence is being probed',
    async (_label, change) => {
      await interruptAfterRelease();
      boundary.nudge.mockResolvedValueOnce(false);
      boundary.status.mockImplementationOnce(async () => {
        d1.exec(change);
        return null;
      });
      await preserveProviderLimitWait(env, 'task-1', Date.now());
      expect(boundary.start).not.toHaveBeenCalled();
      expect(task().admission_state).toBe('provider_limit_recovery_pending');
      expect(boundary.nudge).toHaveBeenCalledOnce();
    }
  );

  it('bounds a stalled runner so later candidates and the scan cursor still progress', async () => {
    const receipt = await interruptAfterRelease();
    const retained = claim();
    env.PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS = '20';
    boundary.nudge.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    d1.prepare(
      `INSERT INTO tasks(id,project_id,user_id,status,admission_state,provider_limit_wait_json,updated_at)
      VALUES ('later-task','project-1','user-1','queued','provider_limit_waiting',?,'2099-01-01T00:00:00Z')`
    ).run(
      JSON.stringify({ ...wait(), origin: 'admission', phase: 'waiting', ownerOverride: undefined })
    );
    const result = await recoverStuckTasks(env);
    expect(result.candidatesScanned).toBe(2);
    expect(result.errors).toBe(0);
    expect(task()).toMatchObject({
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(claim()).toEqual(retained);
    expect(env.KV.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('later-task')
    );
    expect(d1.prepare("SELECT status FROM tasks WHERE id='later-task'").get()).toEqual({
      status: 'queued',
    });
  }, 1000);

  it('retains pending consent when the claim advances after a successful nudge', async () => {
    const receipt = await interruptAfterRelease();
    boundary.nudge.mockImplementationOnce(async () => {
      d1.exec("UPDATE session_snapshots SET recovery_attempt_id='next-claim'");
      return true;
    });
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(task().provider_limit_wait_json).toBe(receipt);
    expect(claim().recovery_attempt_id).toBe('next-claim');
  });

  it('does not acknowledge a late nudge after its background wait timed out', async () => {
    const receipt = await interruptAfterRelease();
    const retained = claim();
    env.PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS = '10';
    let finish!: (value: boolean) => void;
    boundary.nudge.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(task()).toMatchObject({
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(claim()).toEqual(retained);
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task().admission_state).toBeNull();
    expect(boundary.nudge).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unchanged approval', null],
    ['expired approval', null],
    ['profile type changed', "UPDATE agent_profiles SET agent_type='codex'"],
    ['cancelled', "UPDATE tasks SET status='cancelled'"],
    [
      'approval replaced',
      "UPDATE tasks SET provider_limit_wait_json=json_set(provider_limit_wait_json,'$.scheduleKey','new-owner-consent')",
    ],
    ['source generation changed', 'UPDATE agent_sessions SET agent_credential_generation=8'],
  ])(
    'the exact approval fences late recovery for %s after a timed-out lookup',
    async (_label, mutation) => {
      d1.exec(
        "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
      );
      if (_label === 'expired approval') {
        const held = wait();
        d1.prepare("UPDATE tasks SET provider_limit_wait_json=? WHERE id='task-1'").run(
          JSON.stringify({ ...held, deadlineAt: Date.now() + 120 })
        );
      }
      await interruptAfterRelease();
      env.PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS = '10';
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      let finish!: () => void;
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((query: string) => {
        const statement = prepare(query);
        if (!query.includes('from "session_snapshots"')) return statement;
        const originalBind = statement.bind.bind(statement);
        statement.bind = ((...values: unknown[]) => {
          const bound = originalBind(...values);
          const raw = bound.raw.bind(bound);
          bound.raw = (async (...args: Parameters<typeof raw>) => {
            const value = await raw(...args);
            await gate;
            complete();
            return value;
          }) as typeof raw;
          return bound;
        }) as typeof statement.bind;
        return statement;
      });
      await preserveProviderLimitWait(env, 'task-1', Date.now());
      if (mutation) d1.exec(mutation);
      if (_label === 'expired approval') await new Promise((resolve) => setTimeout(resolve, 140));
      const retained = claim();
      const receipt = task().provider_limit_wait_json;
      finish();
      await completed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      fault.mockRestore();
      expect(boundary.start).toHaveBeenCalledTimes(_label === 'unchanged approval' ? 1 : 0);
      expect(boundary.nudge).not.toHaveBeenCalled();
      expect(task().provider_limit_wait_json).toBe(receipt);
      expect(task().admission_state).toBe('provider_limit_recovery_pending');
      // Refusal diagnostics may advance, but the snapshot, claim and retry budget cannot.
      if (_label === 'unchanged approval') {
        expect(claim()).toMatchObject({ recovery_status: 'waking', recovery_task_id: 'task-1' });
        expect(boundary.start.mock.calls[0]?.[1]).toHaveProperty(
          'providerLimitRecoveryApproval.receipt',
          receipt
        );
        return;
      }
      expect(claim()).toEqual(retained);
    }
  );

  it('does not clear workspace bindings or add queued events when queued-task consent changes before reactivation', async () => {
    d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP,chat_session_id='chat-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    await interruptAfterRelease();
    const batch = env.DATABASE.batch.bind(env.DATABASE);
    const fault = vi.spyOn(env.DATABASE, 'batch').mockImplementationOnce(async (statements) => {
      d1.exec(
        "UPDATE tasks SET provider_limit_wait_json=json_set(provider_limit_wait_json,'$.scheduleKey','new-consent')"
      );
      return batch(statements);
    });
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    fault.mockRestore();
    expect(
      d1.prepare("SELECT chat_session_id FROM workspaces WHERE id='workspace-1'").get()
    ).toEqual({ chat_session_id: 'chat-1' });
    expect(
      d1.prepare("SELECT count(*) AS count FROM task_status_events WHERE task_id='task-1'").get()
    ).toEqual({ count: 0 });
    expect(boundary.start).not.toHaveBeenCalled();
  });

  it('the reactivation CAS cannot resurrect cancellation that lands after the claim', async () => {
    d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    const receipt = await interruptAfterRelease();
    const batch = env.DATABASE.batch.bind(env.DATABASE);
    const fault = vi.spyOn(env.DATABASE, 'batch').mockImplementationOnce(async (statements) => {
      d1.exec("UPDATE tasks SET status='cancelled'");
      return batch(statements);
    });
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    fault.mockRestore();
    expect(task()).toMatchObject({
      status: 'cancelled',
      provider_limit_wait_json: receipt,
      admission_state: 'provider_limit_recovery_pending',
    });
    expect(boundary.start).not.toHaveBeenCalled();
    expect(claim()).toMatchObject({ recovery_status: 'failed', recovery_task_id: 'task-1' });
  });

  it('blocks an approved profile whose agent type changed even when its credential stayed the same', async () => {
    const receipt = await interruptAfterRelease();
    const before = claim();
    d1.exec("UPDATE agent_profiles SET agent_type='codex'");
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task().admission_state).toBe('provider_limit_blocked');
    expect(task().provider_limit_wait_json).not.toBe(receipt);
    expect(wait().ownerOverride).toBeUndefined();
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(claim()).toEqual(before);
  });

  it('the bounded sweep resumes a sleeping unclaimed release interrupted immediately after CAS exactly once', async () => {
    d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    const receipt = await interruptAfterRelease();
    const first = await recoverStuckTasks(env);
    expect(first.errors).toBe(0);
    expect(first.candidatesScanned).toBe(1);
    expect(task()).toMatchObject({
      status: 'queued',
      admission_state: null,
      provider_limit_wait_json: receipt,
    });
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      resumeSnapshotChatSessionId: 'chat-1',
    });
    const retained = claim();
    expect(retained).toMatchObject({ recovery_task_id: 'task-1', recovery_status: 'waking' });
    expect(await preserveProviderLimitWait(env, 'task-1', Date.now())).toBe(false);
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(claim()).toEqual(retained);
    expect(getSession(boundary.sql, 'chat-1')?.messageCount).toBe(1);
    expect(
      local.prepare("SELECT id,content FROM chat_messages WHERE session_id='chat-1'").all()
    ).toEqual([{ id: 'original-message', content: 'Deliver this original message once' }]);
  });

  it('retries the same accepted approval and existing queued claim after a lost nudge', async () => {
    const before = claim();
    const receipt = await interruptAfterRelease();
    boundary.nudge.mockRejectedValueOnce(new Error('RPC acknowledgement lost'));
    await expect(preserveProviderLimitWait(env, 'task-1', Date.now())).rejects.toThrow('lost');
    expect(task()).toMatchObject({
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(await preserveProviderLimitWait(env, 'task-1', Date.now())).toBe(true);
    expect(task()).toMatchObject({ admission_state: null, provider_limit_wait_json: receipt });
    expect(boundary.nudge).toHaveBeenCalledTimes(2);
    expect(boundary.start).not.toHaveBeenCalled();
    expect(claim()).toEqual(before);
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(boundary.nudge).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['profile', "UPDATE tasks SET agent_profile_hint='changed-profile'"],
    ['skill', "UPDATE tasks SET skill_id='changed-skill'"],
    ['source generation', 'UPDATE agent_sessions SET agent_credential_generation=8'],
    ['project membership', "UPDATE project_members SET status='removed'"],
    ['snapshot claim', "UPDATE session_snapshots SET recovery_task_id='other-task'"],
  ])('never uses the approval after %s changes', async (_label, change) => {
    await interruptAfterRelease();
    d1.exec(change);
    const before = claim();
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task().admission_state).toBe('provider_limit_blocked');
    expect(wait().ownerOverride).toBeUndefined();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(claim()).toEqual(before);
  });

  it('does not rewrite a task transferred to another owner', async () => {
    const receipt = await interruptAfterRelease();
    d1.exec("UPDATE tasks SET user_id='changed-owner'");
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task()).toMatchObject({
      user_id: 'changed-owner',
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.nudge).not.toHaveBeenCalled();
  });

  it.each([
    ['cancellation', "UPDATE tasks SET status='cancelled'"],
    ['profile', "UPDATE tasks SET agent_profile_hint='changed-profile'"],
    ['source generation', 'UPDATE agent_sessions SET agent_credential_generation=8'],
    ['membership', "UPDATE project_members SET status='removed'"],
  ])(
    'rechecks %s changed during credential selection before recovery dispatch',
    async (_label, change) => {
      const receipt = await interruptAfterRelease();
      boundary.selected.mockImplementationOnce(async () => {
        d1.exec(change);
        return 'cc_credentials:account-1';
      });
      const before = claim();
      await preserveProviderLimitWait(env, 'task-1', Date.now());
      expect(task()).toMatchObject({
        admission_state: 'provider_limit_recovery_pending',
        provider_limit_wait_json: receipt,
      });
      expect(boundary.start).not.toHaveBeenCalled();
      expect(boundary.nudge).not.toHaveBeenCalled();
      expect(claim()).toEqual(before);
    }
  );

  it('rejects a changed session owner before waking or nudging', async () => {
    await interruptAfterRelease();
    boundary.sql.exec("UPDATE chat_sessions SET created_by_user_id='changed-owner'");
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task().admission_state).toBe('provider_limit_blocked');
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.nudge).not.toHaveBeenCalled();
  });

  it('expires accepted recovery without refreshing its consent or claim', async () => {
    const receipt = await interruptAfterRelease();
    const before = claim();
    await preserveProviderLimitWait(env, 'task-1', wait().deadlineAt + 1);
    expect(task().admission_state).toBe('provider_limit_blocked');
    expect(task().provider_limit_wait_json).not.toBe(receipt);
    expect(wait().ownerOverride).toBeUndefined();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(claim()).toEqual(before);
  });

  it('cancelled work is excluded and cannot be restarted even through the consumer directly', async () => {
    const receipt = await interruptAfterRelease();
    d1.exec("UPDATE tasks SET status='cancelled'");
    expect((await selectStuckTaskCandidates(env, 1)).tasks).toEqual([]);
    await preserveProviderLimitWait(env, 'task-1', Date.now());
    expect(task().provider_limit_wait_json).toBe(receipt);
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.nudge).not.toHaveBeenCalled();
  });

  it('does not select unrelated sleeping work and respects the existing page budget', async () => {
    await interruptAfterRelease();
    d1.exec(
      "UPDATE tasks SET status='sleeping'; INSERT INTO tasks(id,status,updated_at) VALUES ('unrelated-sleep','sleeping','2099-01-01T00:00:00Z'),('queued-peer','queued','2099-01-01T00:00:00Z')"
    );
    const newest = await selectStuckTaskCandidates(env, 1);
    expect(newest.tasks).toHaveLength(1);
    expect(newest.tasks[0]?.id).toBe('queued-peer');
    vi.mocked(env.KV.get).mockResolvedValue(JSON.stringify(newest.nextCursor) as never);
    const wrapped = await selectStuckTaskCandidates(env, 1);
    expect(wrapped.tasks).toHaveLength(1);
    expect(wrapped.tasks[0]?.id).toBe('task-1');
    expect(wrapped.tasks.some((row) => row.id === 'unrelated-sleep')).toBe(false);
  });
});
