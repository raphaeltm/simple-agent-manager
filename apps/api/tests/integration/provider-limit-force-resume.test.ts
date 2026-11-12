/** Owner HTTP action -> native D1 CAS + ProjectData session authority -> retained runner. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import {
  createAttentionMarker,
  listActiveAttentionMarkers,
} from '../../src/durable-objects/project-data/attention';
import { syncProviderLimitAttention } from '../../src/durable-objects/project-data/provider-limit-attention';
import { resolveSessionAccess } from '../../src/durable-objects/project-data/session-access';
import { getSession } from '../../src/durable-objects/project-data/session-reads';
import { findRecoveryAuthorityFailure } from '../../src/durable-objects/task-runner/recovery-authority';
import type { StartTaskInput } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { providerLimitResumeRoutes } from '../../src/routes/tasks/provider-limit-resume';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import {
  newProviderLimitWait,
  type ProviderLimitWait,
} from '../../src/services/provider-limit-policy';
import { pickStarterMachines } from '../helpers/capacity-pool-picks';
import { createAllSchemaTables } from '../helpers/sqlite-d1';
import {
  createEvictionEnv,
  seedEvictionOwnerAndNode,
} from '../helpers/workspace-eviction-route-harness';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const boundary = vi.hoisted(() => ({
  userId: 'user-1',
  start: vi.fn(),
  nudge: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  selected: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  sql: null as unknown as SqlStorage,
}));
vi.mock('../../src/middleware/auth', () => ({
  getUserId: () => boundary.userId,
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
// Credential decryption is outside this slice. Profile resolution, source generation,
// credential reference comparison and every persistence predicate remain real.
vi.mock('../../src/services/agent-key-resolution', () => ({
  getSelectedAgentCredentialReference: (...args: unknown[]) => boundary.selected(...args),
}));
vi.mock('../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: (...args: unknown[]) => boundary.start(...args),
  ensureTaskRunnerStarted: vi.fn(async () => false),
  nudgeTaskRunnerDO: (...args: unknown[]) => boundary.nudge(...args),
}));
vi.mock('../../src/services/project-data', () => ({
  getSessionAccess: async (_env: unknown, _project: string, sessionId: string, userId: string) => ({
    session: getSession(boundary.sql, sessionId),
    access: resolveSessionAccess(boundary.sql, sessionId, userId),
  }),
  getSession: async (_env: unknown, _project: string, sessionId: string) =>
    getSession(boundary.sql, sessionId),
  syncProviderLimitAttention: async (
    env: Env,
    projectId: string,
    taskId: string,
    sessionId: string
  ) => syncProviderLimitAttention(boundary.sql, env.DATABASE, { projectId, taskId, sessionId }),
}));

describe('callback provider hold owner force resume', () => {
  let d1: Database.Database;
  let local: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.nudge.mockResolvedValue(true);
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    d1 = new Database(':memory:');
    createAllSchemaTables(d1, schema);
    env = createEvictionEnv(d1, { ENCRYPTION_KEY: 'test-key' });
    seedEvictionOwnerAndNode(d1);
    const db = drizzle(env.DATABASE, { schema });
    // External catalog fixture; pool publication, owner picks and placement stay real.
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: 'user-1', projectId: 'project-1', includeInstallation: true, env,
      offeringResolver: async () => [{
        provider: 'hetzner', location: 'nbg1', providerInstanceType: 'cx23',
        providerInstanceSku: null, displayName: 'Test VM', vcpu: 2, memoryMb: 4096,
        diskGb: 40, currency: 'EUR', priceMonthly: 10, catalogSource: 'api',
        catalogLastSeenAt: new Date().toISOString(), available: true,
      }],
    });
    await pickStarterMachines(db);
    local = new Database(':memory:');
    boundary.sql = createSqlStorage(local);
    runMigrations(boundary.sql);
    boundary.sql
      .exec(`INSERT INTO chat_sessions(id,task_id,created_by_user_id,status,topic,message_count,started_at,created_at,updated_at)
      VALUES ('chat-1','task-1','user-1','sleeping','Task',1,1,1,1)`);
    d1.exec(`INSERT INTO agent_profiles(id,project_id,user_id,name,agent_type)
      VALUES ('profile-1','project-1','user-1','Claude','claude-code');
      INSERT INTO workspaces(id,user_id,project_id,node_id,status,branch,vm_size,vm_location,workspace_profile,created_at,updated_at)
      VALUES ('workspace-1','user-1','project-1','node-1','deleted','main','small','nbg1','lightweight',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO tasks(id,project_id,user_id,chat_session_id,agent_profile_hint,title,status,priority,task_mode,dispatch_depth,triggered_by,created_by,created_at,updated_at)
      VALUES ('task-1','project-1','user-1','chat-1','profile-1','Task','queued',0,'task',0,'mcp','user-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO agent_sessions(id,workspace_id,user_id,status,agent_type,agent_profile_id,agent_credential_reference,agent_credential_generation)
      VALUES ('source-1','workspace-1','user-1','stopped','claude-code','profile-1','cc_credentials:account-1',7);
      INSERT INTO session_snapshots(id,project_id,user_id,chat_session_id,workspace_id,node_id,runtime,status,degradation,manifest_r2_key,manifest_json,expires_at,sleeping_at,sleep_status,recovery_status,recovery_task_id,recovery_attempt_id,recovery_attempts,sleep_attempts,created_at,updated_at)
      VALUES ('snapshot-1','project-1','user-1','chat-1','workspace-1','node-1','vm','available','none','retained/wip','{}','2099-01-01T00:00:00Z',CURRENT_TIMESTAMP,'sleeping','waking','task-1','existing-claim',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    setWait({
      ...newProviderLimitWait({
        taskId: 'task-1',
        origin: 'callback',
        incidentId: 'rejected-prompt-1',
        credentialKey: 'cc_credentials:account-1',
        previous: null,
        now: Date.now(),
        resetsAt: Date.now() + 8 * 60 * 60_000,
        jitter: 0,
      }),
      sourceAgentSessionId: 'source-1',
      sourceCredentialGeneration: 7,
    });
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode)
        : c.json({ error: String(error) }, 500)
    );
    app.route('/projects/:projectId/tasks', providerLimitResumeRoutes);
  });
  afterEach(() => {
    d1.close();
    local.close();
  });

  function task() {
    return d1.prepare("SELECT * FROM tasks WHERE id='task-1'").get() as Record<string, unknown>;
  }
  function claim() {
    return d1.prepare('SELECT * FROM session_snapshots').get() as Record<string, unknown>;
  }
  function wait(): ProviderLimitWait {
    return JSON.parse(task().provider_limit_wait_json as string);
  }
  function setWait(value: ProviderLimitWait) {
    d1.prepare(
      "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_waiting',admission_reason=?,admission_next_retry_at=? WHERE id='task-1'"
    ).run(JSON.stringify(value), value.reason, new Date(value.nextRetryAt).toISOString());
  }
  function resume(project = 'project-1') {
    return app.request(
      `/projects/${project}/tasks/task-1/provider-limit/start-anyway`,
      { method: 'POST' },
      env
    );
  }
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
      'Owner resumed despite provider limit'
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
    expect(task().admission_state).toBeNull();
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
    expect(task().admission_state).toBeNull();
    expect(wait().phase).toBe('released');
  });

  it('claims an unclaimed sleeping snapshot through normal recovery and starts the same task', async () => {
    d1.exec(
      "UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP; UPDATE tasks SET status='sleeping',workspace_id='workspace-1'; UPDATE session_snapshots SET recovery_status=NULL,recovery_task_id=NULL,recovery_attempt_id=NULL"
    );
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      resumeSnapshotChatSessionId: 'chat-1',
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
    ['expired', "UPDATE session_snapshots SET expires_at='2000-01-01T00:00:00Z'"],
    ['malformed expiry', "UPDATE session_snapshots SET expires_at='tomorrow'"],
    ['unavailable', "UPDATE session_snapshots SET status='failed'"],
    ['incoherent degradation', "UPDATE session_snapshots SET degradation='missing_wip'"],
    ['degraded without reason', "UPDATE session_snapshots SET status='degraded'"],
    ['awake snapshot', "UPDATE session_snapshots SET sleep_status='waking'"],
    ['foreign claim', "UPDATE session_snapshots SET recovery_task_id='another-task'"],
    ['claim without attempt', 'UPDATE session_snapshots SET recovery_attempt_id=NULL'],
    ['active workspace', "UPDATE workspaces SET status='running'"],
    ['different workspace', "UPDATE tasks SET workspace_id='another-workspace'"],
    ['changed generation', 'UPDATE agent_sessions SET agent_credential_generation=8'],
    [
      'changed source account',
      "UPDATE agent_sessions SET agent_credential_reference='cc_credentials:other'",
    ],
    ['changed source profile', 'UPDATE agent_sessions SET agent_profile_id=NULL'],
    ['invalid profile ownership', "UPDATE agent_profiles SET project_id='another-project'"],
    ['changed profile agent', "UPDATE agent_profiles SET agent_type='codex'"],
    ['cancelled task', "UPDATE tasks SET status='cancelled'"],
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
    ['cancelled', "UPDATE tasks SET status='cancelled'"],
    ['source generation changed', 'UPDATE agent_sessions SET agent_credential_generation=8'],
    [
      'source account changed',
      "UPDATE agent_sessions SET agent_credential_reference='cc_credentials:other'",
    ],
    ['task profile changed', 'UPDATE tasks SET agent_profile_hint=NULL'],
    ['membership revoked', "UPDATE project_members SET status='removed'"],
    ['user disabled', "UPDATE users SET status='suspended'"],
    ['snapshot expired', "UPDATE session_snapshots SET expires_at='2000-01-01T00:00:00Z'"],
    ['snapshot invalidated', "UPDATE session_snapshots SET status='failed'"],
    ['workspace awoke', "UPDATE workspaces SET status='running'"],
    ['claim owner changed', "UPDATE session_snapshots SET recovery_task_id='another-task'"],
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
