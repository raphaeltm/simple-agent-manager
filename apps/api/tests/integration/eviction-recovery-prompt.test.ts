/**
 * What a recovered agent is told to do first. An eviction kills the runtime mid-work with
 * nothing queued, so a task-mode agent must continue its task; a wake caused by a queued
 * message keeps telling the agent to answer it. Both paths run the real recovery code
 * from their production entry points; only the TaskRunner start is a boundary.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import {
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
} from '../../src/durable-objects/project-data/durability-foundation';
import { acceptPromptDelivery } from '../../src/durable-objects/project-data/prompt-delivery';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { workspaceEvictionCallbackRoute } from '../../src/routes/projects/workspace-eviction-callback';
import { buildAcpInteractionRuntimeConfig } from '../../src/services/acp-interaction-runtime-config';
import {
  SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
  SESSION_RECOVERY_INITIAL_PROMPT,
} from '../../src/services/session-sleep-fallback-messages';
import { finalizeWorkspaceEvictionInNode } from '../../src/services/workspace-eviction-lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const mocks = vi.hoisted(() => ({
  startTaskRunnerDO: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ scope: 'node', workspace: 'node-1' })),
}));
vi.mock('../../src/services/project-data', () => ({
  stopSession: vi.fn(async () => undefined),
  cleanupWorkspaceActivity: vi.fn(async () => undefined),
  recordActivityEvent: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: vi.fn(async () => false),
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

type TaskMode = 'task' | 'conversation';
type Lifecycle = 'evictable' | 'slept';

interface SeedOptions {
  taskMode: TaskMode;
  lifecycle: Lifecycle;
  /** Task mode recorded in the snapshot's runtime contract, which the TaskRunner config uses. */
  contractTaskMode?: TaskMode;
}

describe('recovery prompt chosen by the wake cause', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    let finalizationQueue: Promise<unknown> = Promise.resolve();
    env = {
      DATABASE: createSqliteD1(sqlite),
      DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
      NODE_LIFECYCLE: {
        idFromName: (id: string) => id,
        get: () => ({
          getWorkspaceDeletionAttemptState: async () => ({ pending: false }),
          finalizeWorkspaceEviction: (
            identity: Parameters<typeof finalizeWorkspaceEvictionInNode>[1]
          ) => {
            const result = finalizationQueue
              .catch(() => undefined)
              .then(() => finalizeWorkspaceEvictionInNode(env, identity));
            finalizationQueue = result;
            return result;
          },
        }),
      },
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as never)
        : c.json({ error: error.message }, 500)
    );
    app.route('/projects', workspaceEvictionCallbackRoute);
  });

  afterEach(() => sqlite.close());

  function seed({ taskMode, lifecycle, contractTaskMode }: SeedOptions) {
    const slept = lifecycle === 'slept';
    const contract = contractTaskMode
      ? JSON.stringify({
          version: 1,
          agentType: 'claude-code',
          model: null,
          effort: null,
          permissionMode: 'bypassPermissions',
          opencodeProvider: null,
          opencodeBaseUrl: null,
          settingsResolved: true,
          acpInteractions: buildAcpInteractionRuntimeConfig(env, contractTaskMode),
          promptKind: contractTaskMode,
          taskContext: {
            projectId: 'project-1',
            taskId: 'source-task',
            taskMode: contractTaskMode,
          },
        })
      : null;
    sqlite.exec(`
      INSERT INTO users (id, name, email, github_id, status)
      VALUES ('user-1', 'Test User', 'test@example.com', 'gh-1', 'active');
      INSERT INTO credentials
        (id, user_id, provider, credential_type, credential_kind, is_active,
         encrypted_token, iv, created_at, updated_at)
      VALUES ('credential-1', 'user-1', 'hetzner', 'cloud-provider', 'api-key', 1,
        'encrypted', 'iv', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO projects
        (id, user_id, name, normalized_name, repository, installation_id, default_branch,
         default_location, created_by, created_at, updated_at)
      VALUES ('project-1', 'user-1', 'Project', 'project', 'owner/repo', 'install-1',
        'main', 'hel1', 'user-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('project-1', 'user-1', 'owner', 'active');
      INSERT INTO nodes
        (id, user_id, name, status, health_status, runtime, vm_size, vm_location,
         cloud_provider, created_at, updated_at)
      VALUES ('node-1', 'user-1', 'Node', 'running', 'healthy', 'vm', 'small', 'nbg1',
        'hetzner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
    sqlite
      .prepare(
        `INSERT INTO workspaces
          (id, user_id, project_id, node_id, chat_session_id, status, branch, vm_size,
           vm_location, workspace_profile, eviction_generation, created_at, updated_at)
         VALUES ('workspace-1', 'user-1', 'project-1', 'node-1', 'chat-1', ?,
           'main', 'small', 'nbg1', 'lightweight', 'generation-1',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(slept ? 'sleeping' : 'running');
    sqlite
      .prepare(
        `INSERT INTO tasks
          (id, project_id, user_id, chat_session_id, workspace_id, title, status, priority,
           task_mode, dispatch_depth, triggered_by, created_by, placement_explanation_json,
           created_at, updated_at)
         VALUES ('source-task', 'project-1', 'user-1', 'chat-1', 'workspace-1', 'Source',
           ?, 0, ?, 0, 'mcp', 'user-1',
           '{"kind":"direct_placement","explicitVmLocation":false}',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(slept ? 'sleeping' : 'in_progress', taskMode);
    // A slept session carries the markers the sleep teardown leaves; an evictable one is
    // still running and only becomes recoverable when the eviction callback marks it.
    // The attempt counters are NOT NULL DEFAULT 0 in D1; the test schema has no defaults.
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
          (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
           degradation, manifest_r2_key, manifest_json, runtime_contract_json, expires_at,
           sleeping_at, sleep_status, recovery_attempts, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
           'available', 'none', 'snapshot/manifest.json', '{}', ?, '2099-01-01T00:00:00.000Z',
           ?, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(contract, slept ? new Date().toISOString() : null, slept ? 'sleeping' : null);
  }

  async function evict() {
    const response = await app.fetch(
      new Request('https://api.test/projects/project-1/workspaces/workspace-1/eviction', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          reason: 'oom_kill',
          snapshotCaptured: true,
          containerStopped: true,
          evictionGeneration: 'generation-1',
        }),
      }),
      env,
      { waitUntil: () => undefined } as unknown as ExecutionContext
    );
    expect(response.status, await response.text()).toBe(204);
  }

  /** A user follow-up to the slept chat, accepted and delivered by the real ProjectData alarm. */
  async function deliverUserFollowUp() {
    const db = new Database(':memory:');
    try {
      const sql = createSqlStorage(db);
      runMigrations(sql);
      sql.exec(
        `INSERT INTO chat_sessions
          (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('chat-1', 'workspace-1', 'source-task', 'Task', 'sleeping', 1, 1, 1, 1)`
      );
      acceptPromptDelivery(
        sql,
        env as never,
        {
          deliveryId: 'follow-up-1',
          targetSessionId: 'chat-1',
          displayContent: 'Any update?',
          senderType: 'human',
          senderId: 'user-1',
          sourceKind: 'user_followup',
        },
        Date.now()
      );
      const deliveries: Promise<unknown>[] = [];
      const hooks: DurabilityFoundationHooks = {
        getProjectId: () => 'project-1',
        transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
        waitUntil: (promise) => {
          deliveries.push(promise);
        },
        recalculateAlarm: vi.fn(async () => undefined),
        scheduleSummarySync: vi.fn(),
        broadcastEvent: vi.fn(),
        armIdleCleanup: vi.fn(),
        nudgeDeliveries: vi.fn(() => 0),
      };
      processPromptDeliveryAlarm(sql, env as never, hooks);
      expect(deliveries).toHaveLength(1);
      await Promise.all(deliveries);
    } finally {
      db.close();
    }
  }

  function recoveryStart() {
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledOnce();
    const [, config] = mocks.startTaskRunnerDO.mock.calls[0] as unknown as [
      Env,
      { taskId: string; taskMode: TaskMode; taskDescription: string },
    ];
    return config;
  }

  it('tells an evicted task-mode agent to continue its task without replaying external effects', async () => {
    seed({ taskMode: 'task', lifecycle: 'evictable' });
    await evict();

    const config = recoveryStart();
    expect(config).toMatchObject({ taskId: 'source-task', taskMode: 'task' });
    expect(config.taskDescription).toBe(SESSION_RECOVERY_CONTINUE_TASK_PROMPT);
    expect(config.taskDescription).toContain('get_session_messages');
    expect(config.taskDescription).toContain('Continue the task from where the transcript ends');
    expect(config.taskDescription).toContain(
      'Do not repeat actions with effects outside this workspace'
    );
    expect(config.taskDescription).not.toMatch(/wait for and answer/i);
  });

  it('follows the task mode the runtime contract recorded', async () => {
    seed({ taskMode: 'conversation', lifecycle: 'evictable', contractTaskMode: 'task' });
    await evict();

    expect(recoveryStart()).toMatchObject({
      taskMode: 'task',
      taskDescription: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
    });
  });

  it('keeps the conversation-mode wording after an eviction', async () => {
    seed({ taskMode: 'conversation', lifecycle: 'evictable' });
    await evict();

    expect(recoveryStart()).toMatchObject({
      taskMode: 'conversation',
      taskDescription: SESSION_RECOVERY_INITIAL_PROMPT,
    });
  });

  it('keeps the answer-the-follow-up wording when a queued user message wakes a task', async () => {
    seed({ taskMode: 'task', lifecycle: 'slept' });
    await deliverUserFollowUp();

    expect(recoveryStart()).toMatchObject({
      taskId: 'source-task',
      taskMode: 'task',
      taskDescription: SESSION_RECOVERY_INITIAL_PROMPT,
    });
  });
});
