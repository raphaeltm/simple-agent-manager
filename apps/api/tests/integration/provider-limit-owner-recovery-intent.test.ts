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
