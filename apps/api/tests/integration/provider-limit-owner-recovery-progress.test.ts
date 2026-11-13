/** Native SQLite races between owner recovery validation and its blocking CAS. */
import '../helpers/provider-limit-owner-resume-harness';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { preserveProviderLimitWait } from '../../src/services/provider-limit-reconciliation';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

describe('owner recovery progress during approval validation', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;

  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    harness = await createOwnerResumeHarness();
  });
  afterEach(() => harness.close());

  async function releaseWithoutDispatch() {
    const { env, resume, task } = harness;
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("admission_state='provider_limit_recovery_pending'")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        const bound = bind(...args);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          await run();
          throw new Error('interrupted after owner release');
        };
        return bound;
      };
      return statement;
    });
    try {
      expect((await resume()).status).toBe(500);
    } finally {
      fault.mockRestore();
    }
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
    return task().provider_limit_wait_json;
  }

  function materialize(attempt = 'existing-claim') {
    harness.d1
      .exec(`INSERT INTO workspaces(id,user_id,project_id,node_id,status,created_at,updated_at)
      VALUES ('replacement','user-1','project-1','node-1','running',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO agent_sessions(id,user_id,workspace_id,status,agent_type,agent_profile_id,agent_credential_reference,agent_credential_generation)
      VALUES ('replacement-agent','user-1','replacement','running','claude-code','profile-1','cc_credentials:account-1',1);
      UPDATE tasks SET status='delegated',workspace_id='replacement';`);
    harness.d1
      .prepare(
        `UPDATE session_snapshots SET recovery_status='restored',
      recovery_workspace_id='replacement',recovery_attempt_id=?,sleep_status=NULL,sleeping_at=NULL`
      )
      .run(attempt);
    boundary.sql.exec("UPDATE chat_sessions SET status='active',workspace_id='replacement'");
    boundary.status.mockResolvedValue({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      completed: false,
      currentStep: 'agent_session',
      config: { recoveryAttemptId: 'existing-claim', resumeSnapshotChatSessionId: 'chat-1' },
    });
  }

  it.each(['existing-claim', 'foreign-claim'])(
    'defers revocation when %s progresses during the real profile read',
    async (attempt) => {
      const receipt = await releaseWithoutDispatch();
      const { env, task, claim, wait } = harness;
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes('"agent_profiles"')) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          const raw = bound.raw.bind(bound);
          bound.raw = (async (...values: Parameters<typeof raw>) => {
            const result = await raw(...values);
            entered = true;
            await gate;
            return result;
          }) as typeof raw;
          return bound;
        };
        return statement;
      });
      const repair = preserveProviderLimitWait(env, 'task-1', Date.now());
      // Attach a handler immediately so a failed lookup cannot become an unhandled rejection.
      const settled = repair.then(
        () => undefined,
        (error: unknown) => error
      );
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        expect(boundary.status).not.toHaveBeenCalled();
        materialize(attempt);
        const committedTask = task();
        const committedClaim = claim();
        release();
        expect(await settled).toBeUndefined();
        expect(task()).toEqual(committedTask);
        expect(claim()).toEqual(committedClaim);
        expect(task().provider_limit_wait_json).toBe(receipt);
        expect(wait().ownerOverride).toMatchObject({
          recoveryPending: true,
          snapshotId: 'snapshot-1',
        });
      } finally {
        release();
        await settled;
        fault.mockRestore();
      }
      expect(boundary.nudge).not.toHaveBeenCalled();
      expect(boundary.start).not.toHaveBeenCalled();
      const committedClaim = claim();
      await preserveProviderLimitWait(env, 'task-1', Date.now());
      expect(claim()).toEqual(committedClaim);
      if (attempt === 'foreign-claim') {
        expect(task().admission_state).toBe('provider_limit_blocked');
        expect(wait().ownerOverride).toBeUndefined();
      } else {
        expect(task().provider_limit_wait_json).toBe(receipt);
        expect(task().admission_state).toBe('provider_limit_recovery_pending');
      }
      expect(boundary.nudge).not.toHaveBeenCalled();
      expect(boundary.start).not.toHaveBeenCalled();
    }
  );

  it('atomically preserves a restore committed immediately before the blocking UPDATE executes', async () => {
    const receipt = await releaseWithoutDispatch();
    const { env, task, claim, wait } = harness;
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    let profileRead = false;
    let blockingUpdate = false;
    let committedTask: ReturnType<typeof task> | undefined;
    let committedClaim: ReturnType<typeof claim> | undefined;
    const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql.includes('"agent_profiles"')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          const raw = bound.raw.bind(bound);
          bound.raw = (async (...values: Parameters<typeof raw>) => {
            const result = await raw(...values);
            profileRead = true;
            // Restore has cleared the sleep flags, but has not published its replacement yet.
            harness.d1.exec('UPDATE session_snapshots SET sleep_status=NULL,sleeping_at=NULL');
            return result;
          }) as typeof raw;
          return bound;
        };
      } else if (sql.includes("admission_state='provider_limit_blocked'")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            expect(profileRead).toBe(true);
            blockingUpdate = true;
            materialize();
            committedTask = task();
            committedClaim = claim();
            return run();
          };
          return bound;
        };
      }
      return statement;
    });
    try {
      await preserveProviderLimitWait(env, 'task-1', Date.now());
    } finally {
      fault.mockRestore();
    }
    expect(blockingUpdate).toBe(true);
    expect(task()).toEqual(committedTask);
    expect(claim()).toEqual(committedClaim);
    expect(task().provider_limit_wait_json).toBe(receipt);
    expect(wait().ownerOverride).toMatchObject({ recoveryPending: true, snapshotId: 'snapshot-1' });
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
  });

  it.each(['snapshot completion', 'lease heartbeat'] as const)(
    'isolates the snapshot CAS from task identity during a %s',
    async (change) => {
      const receipt = await releaseWithoutDispatch();
      const { env, d1, task, claim, wait } = harness;
      if (change === 'snapshot completion') {
        materialize();
        // The same runner has allocated its workspace and cleared sleep flags,
        // but has not committed snapshot completion yet.
        d1.exec("UPDATE session_snapshots SET recovery_status='waking'");
        boundary.sql.exec("UPDATE chat_sessions SET status='sleeping'");
        boundary.status.mockResolvedValueOnce(null);
      } else {
        d1.exec("UPDATE project_members SET status='removed'");
      }
      const originalTask = task();
      const originalClaim = claim();
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      let profileRead = false;
      let updateEntered = false;
      let committedClaim: ReturnType<typeof claim> | undefined;
      const fault = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (sql.includes('"agent_profiles"')) {
          const bind = statement.bind.bind(statement);
          statement.bind = (...args: unknown[]) => {
            const bound = bind(...args);
            const raw = bound.raw.bind(bound);
            bound.raw = (async (...values: Parameters<typeof raw>) => {
              const result = await raw(...values);
              profileRead = true;
              return result;
            }) as typeof raw;
            return bound;
          };
        } else if (sql.includes("admission_state='provider_limit_blocked'")) {
          const bind = statement.bind.bind(statement);
          statement.bind = (...args: unknown[]) => {
            const bound = bind(...args);
            const run = bound.run.bind(bound);
            bound.run = async () => {
              expect(profileRead).toBe(true);
              updateEntered = true;
              if (change === 'snapshot completion') {
                d1.exec(
                  "UPDATE session_snapshots SET recovery_status='restored',sleep_status=NULL,sleeping_at=NULL"
                );
                boundary.sql.exec("UPDATE chat_sessions SET status='active'");
              } else {
                d1.exec(
                  "UPDATE session_snapshots SET recovery_claimed_at='2098-01-01T00:00:00.000Z',updated_at='2098-01-01T00:00:00.000Z'"
                );
              }
              committedClaim = claim();
              expect(task()).toEqual(originalTask);
              return run();
            };
            return bound;
          };
        }
        return statement;
      });
      try {
        await preserveProviderLimitWait(env, 'task-1', Date.now());
      } finally {
        fault.mockRestore();
      }
      expect(updateEntered).toBe(true);
      expect(claim()).toEqual(committedClaim);
      expect(claim().recovery_attempt_id).toBe(originalClaim.recovery_attempt_id);
      expect(task().status).toBe(originalTask.status);
      expect(task().workspace_id).toBe(originalTask.workspace_id);
      if (change === 'snapshot completion') {
        expect(boundary.status).toHaveBeenCalledOnce();
        expect(task()).toEqual(originalTask);
        expect(task().provider_limit_wait_json).toBe(receipt);
        expect(wait().ownerOverride).toMatchObject({
          recoveryPending: true,
          snapshotId: 'snapshot-1',
        });
      } else {
        expect(task().admission_state).toBe('provider_limit_blocked');
        expect(wait().ownerOverride).toBeUndefined();
      }
      expect(boundary.nudge).not.toHaveBeenCalled();
      expect(boundary.start).not.toHaveBeenCalled();
    }
  );
});
