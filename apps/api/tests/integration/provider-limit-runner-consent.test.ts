// Real owner CAS/claim and D1 fences; only existing external harness boundaries are doubled.
import '../helpers/provider-limit-owner-resume-harness';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findRecoveryAuthorityFailure } from '../../src/durable-objects/task-runner/recovery-authority';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import type { ProviderLimitRecoveryApproval } from '../../src/services/provider-limit-recovery-approval';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

describe('owner consent survives an in-flight runner state without the newly persisted approval', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;
  let input: TaskRunnerState;
  let persisted: TaskRunnerState;
  let approval: ProviderLimitRecoveryApproval;
  let ctx: DurableObjectState;
  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.nudge.mockResolvedValue(true);
    boundary.status.mockResolvedValue({ taskId: 'task-1' });
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    harness = await createOwnerResumeHarness();
    expect((await harness.resume()).status).toBe(202);
    approval = boundary.nudge.mock.calls[0]?.[3] as ProviderLimitRecoveryApproval;
    expect(approval).toMatchObject({ ownerUserId: 'user-1', snapshotId: 'snapshot-1' });
    expect(harness.claim()).toMatchObject({
      recovery_task_id: 'task-1',
      recovery_attempt_id: 'existing-claim',
    });
    input = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      stepResults: {},
      config: {
        recoveryAttemptId: 'existing-claim',
        recoverySourceTaskId: null,
        chatSessionId: 'chat-1',
        resumeSnapshotChatSessionId: 'chat-1',
      },
    } as TaskRunnerState;
    persisted = { ...input, config: { ...input.config, providerLimitRecoveryApproval: approval } };
    ctx = { storage: { get: vi.fn(async () => persisted) } } as unknown as DurableObjectState;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    harness.close();
  });

  function revoke(scope: string) {
    if (scope === 'deadline') {
      const now = approval.expiresAt + 1;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      harness.d1.function('julianday', { varargs: true }, (...args: unknown[]) => {
        let milliseconds = Date.parse(String(args[0]));
        if (args[0] === 'now') milliseconds = now;
        else if (args[1] === 'unixepoch') milliseconds = Number(args[0]) * 1000;
        return milliseconds / 86_400_000 + 2_440_587.5;
      });
    } else if (scope === 'source generation')
      harness.d1.exec('UPDATE agent_sessions SET agent_credential_generation=8');
    else if (scope === 'source account')
      harness.d1.exec(
        "UPDATE agent_sessions SET agent_credential_reference='cc_credentials:other'"
      );
    else harness.d1.exec("UPDATE agent_profiles SET agent_type='codex'");
  }

  it('permits the unchanged real approval stored for the same task and attempt', async () => {
    expect(input.config.providerLimitRecoveryApproval).toBeUndefined();
    expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBeNull();
  });

  it('hydrates the same in-flight object with its validated persisted consent', async () => {
    expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBeNull();
    expect(input.config.providerLimitRecoveryApproval).toEqual(approval);
  });

  it('hydrates the same in-flight object from validated live D1 consent when both configs omit it', async () => {
    delete persisted.config.providerLimitRecoveryApproval;
    expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBeNull();
    expect(input.config.providerLimitRecoveryApproval).toEqual(approval);
  });

  it.each(['source generation', 'source account', 'profile type', 'deadline'])(
    'enforces persisted consent after %s changes even when the in-flight input lacks it',
    async (scope) => {
      revoke(scope);
      expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBe(
        'recovery_task_authority'
      );
      expect(input.config.providerLimitRecoveryApproval).toBeUndefined();
    }
  );

  it('prefers same-attempt persisted consent over the older in-flight receipt', async () => {
    input.config.providerLimitRecoveryApproval = {
      ...approval,
      receipt: JSON.stringify({ ...JSON.parse(approval.receipt), scheduleKey: 'older-consent' }),
    };
    expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBeNull();
  });

  it('rejects an in-flight alarm from a superseded attempt', async () => {
    persisted.config.recoveryAttemptId = 'new-attempt';
    expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBe(
      'runner_attempt_superseded'
    );
    expect(input.config.providerLimitRecoveryApproval).toBeUndefined();
  });

  it.each(['taskId', 'projectId', 'userId'] as const)(
    'rejects persisted state with a different %s',
    async (field) => {
      persisted[field] = 'different-identity';
      expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).not.toBeNull();
    }
  );

  it('reconstructs valid scoped consent from the real task when both configs omit it', async () => {
    delete persisted.config.providerLimitRecoveryApproval;
    expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBeNull();
  });

  it.each(['source generation', 'source account', 'profile type', 'deadline'])(
    'fails closed for %s through the live D1 fallback when both configs omit consent',
    async (scope) => {
      delete persisted.config.providerLimitRecoveryApproval;
      revoke(scope);
      expect(await findRecoveryAuthorityFailure(harness.env, ctx, input)).toBe(
        'recovery_task_authority'
      );
      expect(input.config.providerLimitRecoveryApproval).toBeUndefined();
    }
  );
});
