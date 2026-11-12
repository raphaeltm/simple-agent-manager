/** Owner HTTP action -> native D1 CAS + ProjectData session authority -> retained runner. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import { syncProviderLimitAttention } from '../../src/durable-objects/project-data/provider-limit-attention';
import { resolveSessionAccess } from '../../src/durable-objects/project-data/session-access';
import { getSession } from '../../src/durable-objects/project-data/session-reads';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { providerLimitResumeRoutes } from '../../src/routes/tasks/provider-limit-resume';
import { recoverStuckTasks, selectStuckTaskCandidates } from '../../src/scheduled/stuck-tasks';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import {
  newProviderLimitWait,
  type ProviderLimitWait,
} from '../../src/services/provider-limit-policy';
import { preserveProviderLimitWait } from '../../src/services/provider-limit-reconciliation';
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

describe('durable owner-approved provider recovery', () => {
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
    env = createEvictionEnv(d1, {
      ENCRYPTION_KEY: 'test-key',
      KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      } as unknown as KVNamespace,
    });
    seedEvictionOwnerAndNode(d1);
    const db = drizzle(env.DATABASE, { schema });
    // External catalog fixture; pool publication, owner picks and placement stay real.
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: 'user-1',
      projectId: 'project-1',
      includeInstallation: true,
      env,
      offeringResolver: async () => [
        {
          provider: 'hetzner',
          location: 'nbg1',
          providerInstanceType: 'cx23',
          providerInstanceSku: null,
          displayName: 'Test VM',
          vcpu: 2,
          memoryMb: 4096,
          diskGb: 40,
          currency: 'EUR',
          priceMonthly: 10,
          catalogSource: 'api',
          catalogLastSeenAt: new Date().toISOString(),
          available: true,
        },
      ],
    });
    await pickStarterMachines(db);
    local = new Database(':memory:');
    boundary.sql = createSqlStorage(local);
    runMigrations(boundary.sql);
    boundary.sql
      .exec(`INSERT INTO chat_sessions(id,task_id,created_by_user_id,status,topic,message_count,started_at,created_at,updated_at)
      VALUES ('chat-1','task-1','user-1','sleeping','Task',1,1,1,1)`);
    boundary.sql.exec(
      "INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES ('original-message','chat-1','user','Deliver this original message once',1)"
    );
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
