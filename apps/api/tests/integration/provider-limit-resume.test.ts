/** Owner HTTP action -> real D1 recovery claim -> retained TaskRunner start. */
import {
  createAttentionMarker,
  listActiveAttentionMarkers,
  resolveAttentionMarkers,
} from '@simple-agent-manager/project-data/internal/do/attention';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import { syncProviderLimitAttention } from '@simple-agent-manager/project-data/internal/do/provider-limit-attention';
import { sleepSession } from '@simple-agent-manager/project-data/internal/do/sessions';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { providerLimitResumeRoutes } from '../../src/routes/tasks/provider-limit-resume';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { presentBlockedProviderLimitWait } from '../../src/services/provider-limit-recovery';
import { createAllSchemaTables } from '../helpers/sqlite-d1';
import {
  createEvictionEnv,
  pickEvictionPools,
  seedEvictionOwnerAndNode,
} from '../helpers/workspace-eviction-route-harness';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const boundary = vi.hoisted(() => ({
  userId: 'user-1',
  start: vi.fn(),
  nudge: vi.fn(async () => true),
  sql: null as unknown as SqlStorage,
}));
vi.mock('../../src/middleware/auth', () => ({
  getUserId: () => boundary.userId,
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: (...args: unknown[]) => boundary.start(...args),
  ensureTaskRunnerStarted: vi.fn(async () => false),
  nudgeTaskRunnerDO: (...args: unknown[]) => boundary.nudge(...args),
}));
vi.mock('../../src/services/project-data', () => ({
  syncProviderLimitAttention: async (
    env: Env,
    projectId: string,
    taskId: string,
    sessionId: string
  ) => syncProviderLimitAttention(boundary.sql, env.DATABASE, { projectId, taskId, sessionId }),
  getSession: vi.fn(async () => ({ id: 'chat-1', status: 'sleeping', taskId: 'task-1' })),
  sleepSession: async (_env: unknown, _project: string, session: string) =>
    sleepSession(boundary.sql, session),
  listActiveAttentionMarkers: async (_env: unknown, _project: string, session: string) =>
    listActiveAttentionMarkers(boundary.sql, session),
  createAttentionMarker: async (
    _env: unknown,
    _project: string,
    opts: Parameters<typeof createAttentionMarker>[1]
  ) => createAttentionMarker(boundary.sql, opts),
  resolveSessionAttentionMarkers: async (_env: unknown, _project: string, session: string) =>
    resolveAttentionMarkers(boundary.sql, session, null),
}));

describe('blocked provider wait owner recovery', () => {
  let d1: Database.Database;
  let local: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  beforeEach(async () => {
    vi.clearAllMocks();
    boundary.userId = 'user-1';
    d1 = new Database(':memory:');
    createAllSchemaTables(d1, schema);
    env = createEvictionEnv(d1);
    seedEvictionOwnerAndNode(d1);
    await pickEvictionPools(env);
    local = new Database(':memory:');
    boundary.sql = createSqlStorage(local);
    runMigrations(boundary.sql);
    boundary.sql.exec(
      `INSERT INTO chat_sessions(id,task_id,status,topic,message_count,started_at,created_at,updated_at) VALUES ('chat-1','task-1','sleeping','Task',1,1,1,1)`
    );
    d1.exec(`INSERT INTO workspaces(id,user_id,project_id,node_id,status,branch,vm_size,vm_location,workspace_profile,created_at,updated_at)
      VALUES ('workspace-1','user-1','project-1','node-1','deleted','main','small','nbg1','lightweight',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO tasks(id,project_id,user_id,chat_session_id,title,status,priority,task_mode,dispatch_depth,triggered_by,created_by,created_at,updated_at)
      VALUES ('task-1','project-1','user-1','chat-1','Task','queued',0,'task',0,'mcp','user-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO session_snapshots(id,project_id,user_id,chat_session_id,workspace_id,node_id,runtime,status,degradation,manifest_r2_key,manifest_json,expires_at,sleeping_at,sleep_status,recovery_status,recovery_task_id,recovery_attempt_id,recovery_attempts,sleep_attempts,created_at,updated_at)
      VALUES ('snapshot-1','project-1','user-1','chat-1','workspace-1','node-1','vm','available','none','retained/wip','{}','2099-01-01T00:00:00Z',CURRENT_TIMESTAMP,'sleeping','waking','task-1','old-claim',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    const wait = {
      ...newProviderLimitWait({
        taskId: 'task-1',
        origin: 'callback',
        incidentId: 'incident',
        credentialKey: 'old-account',
        previous: null,
        now: Date.now(),
        resetsAt: null,
      }),
      phase: 'blocked',
      reason: 'Blocked: selected provider credential changed; review before resuming.',
    };
    d1.prepare(
      "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',admission_reason=?,execution_step='node_selection' WHERE id='task-1'"
    ).run(JSON.stringify(wait), wait.reason);
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
  function resume(project = 'project-1') {
    return app.request(
      `/projects/${project}/tasks/task-1/provider-limit/resume`,
      { method: 'POST' },
      env
    );
  }
  function task() {
    return d1.prepare("SELECT * FROM tasks WHERE id='task-1'").get() as Record<string, unknown>;
  }
  it('presents needs-you coherently then resumes from the retained snapshot through the owner route', async () => {
    const wait = JSON.parse(task().provider_limit_wait_json as string);
    await presentBlockedProviderLimitWait(
      env,
      { id: 'task-1', projectId: 'project-1', chatSessionId: 'chat-1', workspaceId: null },
      wait
    );
    expect(task()).toMatchObject({
      status: 'sleeping',
      execution_step: null,
      admission_state: 'provider_limit_blocked',
    });
    expect(
      d1
        .prepare(
          'SELECT recovery_status,recovery_attempt_id,manifest_r2_key FROM session_snapshots'
        )
        .get()
    ).toEqual({
      recovery_status: 'failed',
      recovery_attempt_id: null,
      manifest_r2_key: 'retained/wip',
    });
    expect(listActiveAttentionMarkers(boundary.sql, 'chat-1')).toEqual([
      expect.objectContaining({ kind: 'provider_limit_blocked', reason: wait.reason }),
    ]);
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await response.json()).toEqual({ status: 'waking', taskId: 'task-1' });
    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.start.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-1',
      resumeSnapshotChatSessionId: 'chat-1',
      restoredSessionPrompt: expect.stringContaining('Continue the task'),
    });
    expect(task()).toMatchObject({ status: 'queued', admission_state: null, workspace_id: null });
    expect(
      d1
        .prepare(
          'SELECT recovery_status,recovery_attempt_id,manifest_r2_key FROM session_snapshots'
        )
        .get()
    ).toMatchObject({
      recovery_status: 'waking',
      recovery_attempt_id: expect.not.stringMatching(/^old-claim$/),
      manifest_r2_key: 'retained/wip',
    });
    expect(listActiveAttentionMarkers(boundary.sql, 'chat-1')).toHaveLength(0);
    expect((await resume()).status).toBe(409);
    expect(boundary.start).toHaveBeenCalledOnce();
  });
  it('denies another project member and cross-project task lookup', async () => {
    d1.exec(
      "INSERT INTO users(id,status) VALUES ('other','active'); INSERT INTO project_members(project_id,user_id,role,status) VALUES ('project-1','other','maintainer','active')"
    );
    boundary.userId = 'other';
    expect((await resume()).status).toBe(403);
    boundary.userId = 'user-1';
    expect((await resume('another-project')).status).toBe(404);
    expect(task().admission_state).toBe('provider_limit_blocked');
    expect(boundary.start).not.toHaveBeenCalled();
  });
  it('does not restore blocked attention from a stale presentation after owner approval', async () => {
    const stale = JSON.parse(task().provider_limit_wait_json as string);
    createAttentionMarker(boundary.sql, {
      sessionId: 'chat-1',
      taskId: 'task-1',
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });
    expect((await resume()).status).toBe(202);
    await presentBlockedProviderLimitWait(
      env,
      { id: 'task-1', projectId: 'project-1', chatSessionId: 'chat-1', workspaceId: null },
      stale
    );
    expect(listActiveAttentionMarkers(boundary.sql, 'chat-1')).toEqual([
      expect.objectContaining({ kind: 'needs_input' }),
    ]);
    expect(d1.prepare('SELECT recovery_status FROM session_snapshots').get()).toEqual({
      recovery_status: 'waking',
    });
  });
  it('retains the resume action when a snapshot is expired', async () => {
    d1.exec("UPDATE session_snapshots SET expires_at='2000-01-01T00:00:00Z'");
    expect((await resume()).status).toBe(409);
    expect(task().admission_state).toBe('provider_limit_blocked');
    expect(boundary.start).not.toHaveBeenCalled();
  });
  it('keeps a supported retry if the runner cannot start', async () => {
    boundary.start.mockRejectedValueOnce(new Error('test start unavailable'));
    const response = await resume();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(task()).toMatchObject({ status: 'sleeping', admission_state: 'provider_limit_blocked' });
    expect((await resume()).status).toBe(202);
  });

  describe('start anyway through the owner route', () => {
    beforeEach(() => {
      const wait = newProviderLimitWait({
        taskId: 'task-1',
        origin: 'admission',
        incidentId: 'admission:task-1:1',
        credentialKey: 'cc_credentials:quota-key',
        previous: null,
        now: Date.now(),
        resetsAt: Date.now() + 8 * 60 * 60_000,
      });
      d1.prepare(
        "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_waiting',admission_reason=?,status='queued' WHERE id='task-1'"
      ).run(JSON.stringify(wait), wait.reason);
    });
    function startAnyway(project = 'project-1') {
      return app.request(
        `/projects/${project}/tasks/task-1/provider-limit/start-anyway`,
        { method: 'POST' },
        env
      );
    }

    it('lets the owner start a waiting task and records the scoped override', async () => {
      const response = await startAnyway();
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await response.json()).toEqual({ status: 'starting', taskId: 'task-1' });
      expect(boundary.nudge).toHaveBeenCalledOnce();
      const row = task();
      expect(row.admission_state).toBeNull();
      expect(JSON.parse(row.provider_limit_wait_json as string)).toMatchObject({
        phase: 'released',
        ownerOverride: { credentialKey: 'cc_credentials:quota-key' },
      });
      // A second press is a conflict, not a second start.
      expect((await startAnyway()).status).toBe(409);
      expect(boundary.nudge).toHaveBeenCalledOnce();
    });

    it('refuses another project member and a cross-project lookup without changing the task', async () => {
      const before = task().provider_limit_wait_json;
      d1.exec(
        "INSERT INTO users(id,status) VALUES ('other','active'); INSERT INTO project_members(project_id,user_id,role,status) VALUES ('project-1','other','maintainer','active')"
      );
      boundary.userId = 'other';
      expect((await startAnyway()).status).toBe(403);
      boundary.userId = 'user-1';
      expect((await startAnyway('another-project')).status).toBe(404);
      expect(task()).toMatchObject({
        admission_state: 'provider_limit_waiting',
        provider_limit_wait_json: before,
      });
      expect(boundary.nudge).not.toHaveBeenCalled();
    });

    it('keeps the hold when the runner has nothing to run', async () => {
      const before = task().provider_limit_wait_json;
      boundary.nudge.mockResolvedValueOnce(false);
      expect((await startAnyway()).status).toBe(409);
      expect(task()).toMatchObject({
        admission_state: 'provider_limit_waiting',
        provider_limit_wait_json: before,
      });
    });

    it('keeps the override when the nudge outcome is ambiguous', async () => {
      boundary.nudge.mockRejectedValueOnce(new Error('rpc reset'));
      expect((await startAnyway()).status).toBe(409);
      // The runner may already be acting on it; re-imposing the hold could stall a live start.
      expect(task().admission_state).toBeNull();
      expect(JSON.parse(task().provider_limit_wait_json as string)).toMatchObject({
        ownerOverride: { credentialKey: 'cc_credentials:quota-key' },
      });
    });
  });
});
