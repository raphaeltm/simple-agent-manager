/** Owner HTTP action -> native D1 CAS + ProjectData session authority -> retained runner. */
// Register the shared external-boundary doubles before importing recovery consumers.
import '../helpers/provider-limit-owner-resume-harness';

import {
  createAttentionMarker,
  listActiveAttentionMarkers,
} from '@simple-agent-manager/project-data/internal/do/attention';
import { getSession } from '@simple-agent-manager/project-data/internal/do/session-reads';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findRecoveryAuthorityFailure } from '../../src/durable-objects/task-runner/recovery-authority';
import type { StartTaskInput } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

const authorityMutations = {
  'snapshot expired': "UPDATE session_snapshots SET expires_at='2000-01-01T00:00:00Z'",
  'snapshot invalidated': "UPDATE session_snapshots SET status='failed'",
  'workspace awoke': "UPDATE workspaces SET status='running'",
  'claim owner changed': "UPDATE session_snapshots SET recovery_task_id='another-task'",
  'source generation changed': 'UPDATE agent_sessions SET agent_credential_generation=8',
  'source account changed':
    "UPDATE agent_sessions SET agent_credential_reference='cc_credentials:other'",
  'task cancelled': "UPDATE tasks SET status='cancelled'",
};

describe('callback provider hold owner force resume', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;
  let d1: Database.Database;
  let env: Env;
  let task: typeof harness.task;
  let claim: typeof harness.claim;
  let wait: typeof harness.wait;
  let resume: typeof harness.resume;
  let setWait: typeof harness.setWait;
  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.nudge.mockResolvedValue(true);
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    harness = await createOwnerResumeHarness();
    ({ d1, env, task, claim, wait, setWait, resume } = harness);
  });
  afterEach(() => harness.close());

  async function expectRefused(status = 409) {
    const original = task().provider_limit_wait_json;
    const originalClaim = claim();
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(status);
    expect(task().provider_limit_wait_json).toBe(original);
    expect(claim()).toEqual(originalClaim);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
  }

  it('resolves a scoped profile name to the same saved profile before granting consent', async () => {
    d1.exec("UPDATE tasks SET agent_profile_hint='Claude'");
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(wait().ownerOverride?.profileId).toBe('profile-1');
    expect(task().agent_profile_hint).toBe('profile-1');
  });

  it.each(['agent_credential_generation', 'agent_type', 'updated_at'])(
    'rejects a malformed snapshot authority row field %s',
    async (field) => {
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      env.DATABASE.prepare = ((query: string) => {
        const statement = prepare(query);
        if (
          !query.includes('a.agent_credential_generation') ||
          !query.includes('FROM session_snapshots s')
        )
          return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = ((...values: unknown[]) => {
          const bound = bind(...values);
          const first = bound.first.bind(bound);
          bound.first = (async () => ({ ...(await first()), [field]: {} })) as typeof bound.first;
          return bound;
        }) as typeof statement.bind;
        return statement;
      }) as typeof env.DATABASE.prepare;
      await expectRefused(409);
      expect(boundary.selected).not.toHaveBeenCalled();
    }
  );

  it('overrides a future timer while preserving the exact snapshot and already-owned recovery claim', async () => {
    const before = claim();
    const held = wait();
    createAttentionMarker(boundary.sql, {
      sessionId: 'chat-1',
      taskId: 'task-1',
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });
    expect(held.nextRetryAt).toBeGreaterThan(Date.now());
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await response.json()).toEqual({ status: 'waking', taskId: 'task-1' });
    expect(boundary.nudge).toHaveBeenCalledExactlyOnceWith(
      env,
      'task-1',
      'Owner resumed despite provider limit',
      {
        receipt: task().provider_limit_wait_json,
        ownerUserId: 'user-1',
        snapshotId: 'snapshot-1',
        expiresAt: held.deadlineAt,
        sourceCredentialReference: 'cc_credentials:account-1',
      }
    );
    expect(boundary.start).not.toHaveBeenCalled();
    expect(claim()).toEqual(before);
    expect(task()).toMatchObject({
      status: 'queued',
      workspace_id: null,
      chat_session_id: 'chat-1',
      admission_state: null,
      admission_next_retry_at: null,
    });
    expect(wait()).toMatchObject({
      phase: 'released',
      incidentId: held.incidentId,
      sourceAgentSessionId: 'source-1',
      sourceCredentialGeneration: 7,
      attempts: held.attempts,
      ownerOverride: {
        credentialKey: held.credentialKey,
        profileId: 'profile-1',
        skillId: null,
        agentType: 'claude-code',
        expiresAt: held.deadlineAt,
      },
    });
    expect(wait().scheduleKey).not.toBe(held.scheduleKey);
    expect(listActiveAttentionMarkers(boundary.sql, 'chat-1')).toEqual([
      expect.objectContaining({ kind: 'needs_input' }),
    ]);
    expect(getSession(boundary.sql, 'chat-1')).toMatchObject({
      status: 'sleeping',
      taskId: 'task-1',
    });
  });

  it('serializes simultaneous clicks through the persisted hold CAS', async () => {
    const before = claim();
    const responses = await Promise.all([resume(), resume()]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(boundary.nudge).toHaveBeenCalledOnce();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(claim()).toEqual(before);
  });

  it('retains accepted consent when the claimed recovery has no runner yet', async () => {
    const retainedClaim = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockResolvedValueOnce(null);
    expect((await resume()).status).toBe(409);
    expect(wait().phase).toBe('released');
    expect(wait().ownerOverride?.recoveryPending).toBe(true);
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(claim()).toEqual(retainedClaim);
  });

  it('retains accepted consent when runner presence cannot be confirmed', async () => {
    const retainedClaim = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockRejectedValueOnce(new Error('ambiguous runner status'));
    expect((await resume()).status).toBe(409);
    expect(wait().phase).toBe('released');
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(claim()).toEqual(retainedClaim);
  });

  it('retains accepted consent when the same runner still has the preceding claim', async () => {
    const retainedClaim = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    boundary.status.mockResolvedValueOnce({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      completed: false,
      currentStep: 'node_selection',
      config: { resumeSnapshotChatSessionId: 'chat-1', recoveryAttemptId: 'preceding-claim' },
    });
    expect((await resume()).status).toBe(409);
    expect(wait().phase).toBe('released');
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(claim()).toEqual(retainedClaim);
  });

  it('restores the original hold after a definitive nudge refusal without releasing its claim', async () => {
    const original = task().provider_limit_wait_json;
    const before = claim();
    boundary.nudge.mockResolvedValueOnce(false);
    expect((await resume()).status).toBe(409);
    expect(task()).toMatchObject({
      admission_state: 'provider_limit_waiting',
      provider_limit_wait_json: original,
    });
    expect(claim()).toEqual(before);
    expect((await resume()).status).toBe(202);
  });

  it('retains approval and the claim when a nudge response is lost', async () => {
    const before = claim();
    boundary.nudge.mockRejectedValueOnce(new Error('RPC response lost'));
    expect((await resume()).status).toBe(409);
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(wait()).toMatchObject({
      phase: 'released',
      ownerOverride: { credentialKey: 'cc_credentials:account-1' },
    });
    expect(claim()).toEqual(before);
    expect((await resume()).status).toBe(409);
    expect(boundary.nudge).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer recovery attempt when a nudge definitively fails', async () => {
    boundary.nudge.mockImplementationOnce(async () => {
      d1.exec("UPDATE session_snapshots SET recovery_attempt_id='new-claim'");
      return false;
    });
    expect((await resume()).status).toBe(409);
    expect(claim().recovery_attempt_id).toBe('new-claim');
    expect(task().admission_state).toBe('provider_limit_recovery_pending');
    expect(wait().phase).toBe('released');
  });

  it('claims an unclaimed sleeping snapshot through normal recovery and starts the same task', async () => {
    d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(boundary.nudge).toHaveBeenCalledOnce();
    expect(boundary.nudge.mock.calls[0]?.slice(1)).toEqual([
      'task-1',
      'Confirm owner-approved recovery runner',
      expect.objectContaining({
        receipt: task().provider_limit_wait_json,
        ownerUserId: 'user-1',
        snapshotId: 'snapshot-1',
      }),
    ]);
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      resumeSnapshotChatSessionId: 'chat-1',
      providerLimitRecoveryApproval: {
        receipt: task().provider_limit_wait_json,
        ownerUserId: 'user-1',
        snapshotId: 'snapshot-1',
        expiresAt: wait().deadlineAt,
        sourceCredentialReference: 'cc_credentials:account-1',
      },
    });
    expect(claim()).toMatchObject({
      id: 'snapshot-1',
      recovery_status: 'waking',
      recovery_task_id: 'task-1',
      recovery_attempt_id: expect.any(String),
      manifest_r2_key: 'retained/wip',
    });
    expect(task()).toMatchObject({
      id: 'task-1',
      chat_session_id: 'chat-1',
      status: 'queued',
      admission_state: null,
    });
  });

  it('revokes an approved existing runner after project write access is removed', async () => {
    expect((await resume()).status).toBe(202);
    const input: StartTaskInput = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      config: {
        vmSize: 'small',
        vmLocation: 'nbg1',
        branch: 'main',
        defaultBranch: 'main',
        preferredNodeId: null,
        userName: 'Test User',
        userEmail: 'test@example.com',
        githubId: 'gh-1',
        taskTitle: 'Task',
        taskDescription: 'Continue the task',
        repository: 'owner/repo',
        installationId: 'install-1',
        outputBranch: null,
        projectDefaultVmSize: null,
        chatSessionId: 'chat-1',
        agentType: 'claude-code',
        workspaceProfile: 'lightweight',
        devcontainerConfigName: null,
        cloudProvider: 'hetzner',
        credentialAttributionUserId: 'user-1',
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
        taskMode: 'task',
        model: null,
        effort: null,
        permissionMode: null,
        opencodeProvider: null,
        opencodeBaseUrl: null,
        systemPromptAppend: null,
        agentProfileHint: 'profile-1',
        attachments: null,
        resumeSnapshotChatSessionId: 'chat-1',
        recoveryAttemptId: 'existing-claim',
        // The pre-existing human wake has no orchestration parent guard.
        recoverySourceTaskId: null,
      },
    };
    const ctx = { storage: { get: vi.fn(async () => undefined) } } as unknown as DurableObjectState;
    expect(await findRecoveryAuthorityFailure(env, ctx, input)).toBeNull();
    d1.exec("UPDATE project_members SET role='viewer'");
    expect(await findRecoveryAuthorityFailure(env, ctx, input)).toBe('recovery_task_authority');
    expect(claim().recovery_attempt_id).toBe('existing-claim');
  });

  it('restores a retryable hold when a newly claimed recovery cannot start', async () => {
    d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    const original = task().provider_limit_wait_json;
    boundary.start.mockRejectedValueOnce(new Error('runner unavailable'));
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(task()).toMatchObject({
      status: 'sleeping',
      workspace_id: null,
      admission_state: 'provider_limit_waiting',
      provider_limit_wait_json: original,
    });
    expect(claim()).toMatchObject({
      id: 'snapshot-1',
      recovery_status: 'failed',
      manifest_r2_key: 'retained/wip',
    });
    expect((await resume()).status).toBe(202);
  });

  it.each([
    ...Object.entries(authorityMutations),
    ['malformed expiry', "UPDATE session_snapshots SET expires_at='tomorrow'"],
    ['incoherent degradation', "UPDATE session_snapshots SET degradation='missing_wip'"],
    ['degraded without reason', "UPDATE session_snapshots SET status='degraded'"],
    ['awake snapshot', "UPDATE session_snapshots SET sleep_status='waking'"],
    ['claim without attempt', 'UPDATE session_snapshots SET recovery_attempt_id=NULL'],
    ['different workspace', "UPDATE tasks SET workspace_id='another-workspace'"],
    ['changed source profile', 'UPDATE agent_sessions SET agent_profile_id=NULL'],
    ['invalid profile ownership', "UPDATE agent_profiles SET project_id='another-project'"],
    ['changed profile agent', "UPDATE agent_profiles SET agent_type='codex'"],
    ['terminal task', "UPDATE tasks SET status='completed'"],
  ])('refuses %s without mutating the hold or claim', async (_label, mutation) => {
    d1.exec(mutation);
    await expectRefused();
  });

  it('supports snapshots with an explicit degradation reason', async () => {
    d1.exec("UPDATE session_snapshots SET status='degraded',degradation='missing_wip'");
    const before = claim();
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(claim()).toEqual(before);
  });

  it.each([
    ['deadline expired', { deadlineAt: 1 }],
    ['missing credential', { credentialKey: null }],
    ['blocked wait', { phase: 'blocked' }],
    ['missing source', { sourceAgentSessionId: undefined }],
    ['missing source generation', { sourceCredentialGeneration: undefined }],
  ] as const)('refuses a %s callback hold', async (_label, mutation) => {
    setWait({ ...wait(), ...mutation });
    await expectRefused();
  });

  it('refuses a changed selected account', async () => {
    boundary.selected.mockResolvedValueOnce('cc_credentials:other');
    await expectRefused();
  });

  it('rejects task-owner access when session ownership changed', async () => {
    boundary.sql.exec("UPDATE chat_sessions SET created_by_user_id='other'");
    await expectRefused(403);
  });

  it('rejects a task/session authority mismatch', async () => {
    boundary.sql.exec("UPDATE chat_sessions SET task_id='another-task'");
    await expectRefused();
  });

  it('rejects a session that is already active', async () => {
    boundary.sql.exec("UPDATE chat_sessions SET status='active'");
    await expectRefused();
  });

  it('refuses another maintainer and a cross-project lookup', async () => {
    d1.exec(
      "INSERT INTO users(id,status) VALUES ('other','active'); INSERT INTO project_members(project_id,user_id,role,status) VALUES ('project-1','other','maintainer','active')"
    );
    boundary.userId = 'other';
    await expectRefused(403);
    boundary.userId = 'user-1';
    expect((await resume('another-project')).status).toBe(404);
  });

  it('refuses revoked project capability before issuing approval', async () => {
    d1.exec("UPDATE project_members SET role='viewer'");
    await expectRefused(403);
  });

  it.each([
    ...Object.entries(authorityMutations),
    ['task profile changed', 'UPDATE tasks SET agent_profile_hint=NULL'],
    ['membership revoked', "UPDATE project_members SET status='removed'"],
    ['user disabled', "UPDATE users SET status='suspended'"],
    ['source agent changed', "UPDATE agent_sessions SET agent_type='openai-codex'"],
    ['claim replaced', "UPDATE session_snapshots SET recovery_attempt_id='new-claim'"],
  ])('CAS refuses a concurrent %s before the runner nudge', async (_label, mutation) => {
    const original = task().provider_limit_wait_json;
    boundary.selected.mockImplementationOnce(async () => {
      d1.exec(mutation);
      return 'cc_credentials:account-1';
    });
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(task().provider_limit_wait_json).toBe(original);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
  });
  it('refuses expiry elapsed during credential resolution without changing the hold', async () => {
    const original = task().provider_limit_wait_json;
    const originalClaim = claim();
    let restoreClock: (() => void) | undefined;
    boundary.selected.mockImplementationOnce(async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(wait().deadlineAt + 1);
      restoreClock = () => clock.mockRestore();
      return 'cc_credentials:account-1';
    });
    try {
      const response = await resume();
      expect(response.status, await response.clone().text()).toBe(409);
      expect(task().provider_limit_wait_json).toBe(original);
      expect(claim()).toEqual(originalClaim);
      expect(boundary.nudge).not.toHaveBeenCalled();
    } finally {
      restoreClock?.();
    }
  });
  it('retains the owner retry if recovery lookup throws before taking a claim', async () => {
    d1.exec(
      "UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    const original = task().provider_limit_wait_json;
    const originalClaim = claim();
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    boundary.selected.mockImplementationOnce(async () => {
      env.DATABASE.prepare = (sql: string) => {
        if (sql.includes('from "session_snapshots"')) throw new Error('transient context lookup');
        return prepare(sql);
      };
      return 'cc_credentials:account-1';
    });
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(task().provider_limit_wait_json).toBe(original);
    expect(task().admission_state).toBe('provider_limit_waiting');
    expect(claim()).toEqual(originalClaim);
    expect(boundary.start).not.toHaveBeenCalled();
  });
});
