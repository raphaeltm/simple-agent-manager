/** Claim acquisition is not runner acknowledgement; interrupted claims retain consent. */
import '../helpers/provider-limit-owner-resume-harness';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

describe('owner-approved recovery claim interruption', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;
  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    boundary.nudge.mockResolvedValue(true);
    boundary.status.mockResolvedValue(null);
    harness = await createOwnerResumeHarness({
      KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      } as unknown as KVNamespace,
    });
    harness.d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    harness.close();
  });

  function raceClaimBeforeThisCallCanClaim() {
    const prepare = harness.env.DATABASE.prepare.bind(harness.env.DATABASE);
    let raced = false;
    return vi.spyOn(harness.env.DATABASE, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (
        !query.startsWith('update "session_snapshots"') ||
        !query.includes('"recovery_attempt_id"')
      )
        return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = ((...values: unknown[]) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = (async () => {
          if (!raced) {
            raced = true;
            harness.d1
              .prepare(
                "UPDATE session_snapshots SET recovery_status='waking',recovery_task_id='task-1',recovery_attempt_id='raced-claim',recovery_claimed_at=?"
              )
              .run(new Date().toISOString());
          }
          return run();
        }) as typeof bound.run;
        return bound;
      }) as typeof statement.bind;
      return statement;
    });
  }

  it('retains the accepted intent when ensure observes another claim without a runner', async () => {
    const fault = raceClaimBeforeThisCallCanClaim();
    boundary.nudge.mockResolvedValueOnce(false);
    const response = await harness.resume();
    fault.mockRestore();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(harness.task()).toMatchObject({
      status: 'sleeping',
      admission_state: 'provider_limit_recovery_pending',
    });
    expect(harness.wait().phase).toBe('released');
    expect(harness.claim()).toMatchObject({
      recovery_status: 'waking',
      recovery_attempt_id: 'raced-claim',
    });
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.nudge).toHaveBeenCalledOnce();
  });

  it('fences an initially unclaimed approval ACK to the exact attempt that confirmed ownership', async () => {
    let confirmedAttempt: unknown;
    boundary.nudge.mockImplementationOnce(async () => {
      confirmedAttempt = harness.claim().recovery_attempt_id;
      harness.d1.exec("UPDATE session_snapshots SET recovery_attempt_id='newer-claim'");
      return true;
    });
    const response = await harness.resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(confirmedAttempt).toEqual(expect.any(String));
    expect(harness.task().admission_state).toBe('provider_limit_recovery_pending');
    expect(harness.claim().recovery_attempt_id).toBe('newer-claim');
    expect(boundary.start).toHaveBeenCalledOnce();
  });

  it('keeps the same approval and claim on an ambiguous initial runner confirmation', async () => {
    boundary.nudge.mockRejectedValueOnce(new Error('runner acknowledgement lost'));
    const response = await harness.resume();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(harness.task().admission_state).toBe('provider_limit_recovery_pending');
    expect(harness.wait().phase).toBe('released');
    expect(harness.claim()).toMatchObject({
      recovery_status: 'waking',
      recovery_task_id: 'task-1',
    });
    expect(boundary.start).toHaveBeenCalledOnce();
  });

  it('repairs the sleeping task on the same interrupted claim and makes a second sweep inert', async () => {
    const fault = raceClaimBeforeThisCallCanClaim();
    boundary.nudge.mockResolvedValueOnce(false);
    await harness.resume();
    fault.mockRestore();
    const receipt = harness.task().provider_limit_wait_json;
    const claim = harness.claim();
    boundary.nudge.mockResolvedValueOnce(false); // The claimed runner still does not exist.
    const first = await recoverStuckTasks(harness.env);
    expect(first.errors).toBe(0);
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      recoveryAttemptId: 'raced-claim',
      providerLimitRecoveryApproval: { receipt },
    });
    expect(harness.task()).toMatchObject({
      status: 'queued',
      workspace_id: null,
      admission_state: null,
    });
    expect(harness.claim()).toEqual(claim);
    const second = await recoverStuckTasks(harness.env);
    expect(second.errors).toBe(0);
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(harness.claim()).toEqual(claim);
  });

  it('does not reset a competing same-attempt repair that advanced before reactivation', async () => {
    const fault = raceClaimBeforeThisCallCanClaim();
    boundary.nudge.mockResolvedValueOnce(false);
    await harness.resume();
    fault.mockRestore();
    const claim = harness.claim();
    const receipt = harness.task().provider_limit_wait_json;
    harness.d1.exec(`INSERT INTO workspaces
      (id,user_id,project_id,node_id,status,branch,vm_size,vm_location,workspace_profile,created_at,updated_at)
      VALUES ('replacement','user-1','project-1','node-1','running','main','small','nbg1','lightweight',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    const prepare = harness.env.DATABASE.prepare.bind(harness.env.DATABASE);
    const batch = harness.env.DATABASE.batch.bind(harness.env.DATABASE);
    let reactivationPrepared = false;
    vi.spyOn(harness.env.DATABASE, 'prepare').mockImplementation((query) => {
      if (query.includes("SET status = 'queued'") && query.includes('requested_vm_size'))
        reactivationPrepared = true;
      return prepare(query);
    });
    vi.spyOn(harness.env.DATABASE, 'batch').mockImplementation(async (statements) => {
      if (reactivationPrepared) {
        reactivationPrepared = false;
        harness.d1.exec(
          "UPDATE tasks SET status='delegated',workspace_id='replacement' WHERE id='task-1'"
        );
      }
      return batch(statements);
    });
    boundary.nudge.mockResolvedValueOnce(false);
    await recoverStuckTasks(harness.env);
    expect(harness.task()).toMatchObject({
      status: 'delegated',
      workspace_id: 'replacement',
      admission_state: 'provider_limit_recovery_pending',
      provider_limit_wait_json: receipt,
    });
    expect(boundary.start).not.toHaveBeenCalled();
    expect(harness.claim()).toEqual(claim);
  });
});
