/**
 * What a recovered agent is told to do first. An eviction kills the runtime mid-work with
 * nothing queued, so a task-mode agent must continue its task; a wake caused by a queued
 * message keeps telling the agent to answer it. Both paths run the real recovery code
 * from their production entry points; only the TaskRunner start is a boundary.
 */
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import {
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
} from '../../src/durable-objects/project-data/durability-foundation';
import { acceptPromptDelivery } from '../../src/durable-objects/project-data/prompt-delivery';
import type { Env } from '../../src/env';
import { buildAcpInteractionRuntimeConfig } from '../../src/services/acp-interaction-runtime-config';
import type { SessionSleepFallbackRecord } from '../../src/services/session-sleep-episode';
import {
  SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
  SESSION_RECOVERY_INITIAL_PROMPT,
  sessionRecoveryInitialPrompt,
} from '../../src/services/session-sleep-fallback-messages';
import { createAllSchemaTables } from '../helpers/sqlite-d1';
import {
  createEvictionApp,
  createEvictionEnv,
  postEvictionCallback,
  seedEvictionOwnerAndNode,
} from '../helpers/workspace-eviction-route-harness';
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
    env = createEvictionEnv(sqlite, { DURABLE_PROMPT_DELIVERY_ENABLED: 'true' });
    app = createEvictionApp();
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
    seedEvictionOwnerAndNode(sqlite);
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
    const response = await postEvictionCallback(app, env);
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

describe('continue-task wording after a fallback recovery point', () => {
  const fallback: SessionSleepFallbackRecord = {
    version: 1,
    outcome: 'slept',
    trigger: 'attempt_budget',
    blockedReason: null,
    decidedAt: '2026-10-04T08:15:00.000Z',
    episodeStartedAt: '2026-10-04T08:00:00.000Z',
    failedAttempts: 3,
    lastError: null,
    recoveryPoint: {
      generation: 'gen-3',
      commit: 'f'.repeat(40),
      branch: 'sam/feature',
      detached: false,
      upstream: 'origin/sam/feature',
      capturedAt: '2026-10-04T08:10:00.000Z',
      snapshotStatus: 'degraded',
      degradation: 'home-skipped',
      workingTreeSaved: true,
      homeSaved: false,
    },
  };

  it('keeps the recovery-point checks and ends by continuing the task', () => {
    const prompt = sessionRecoveryInitialPrompt(fallback, 'continue_assigned_task');
    expect(prompt).toContain(`confirm the workspace is at commit ${'f'.repeat(12)}`);
    expect(prompt).toContain('Do not repeat actions with effects outside this workspace');
    expect(
      prompt.endsWith('Then continue your assigned task from where the transcript ends.')
    ).toBe(true);
    expect(prompt).not.toMatch(/wait for and answer/i);
  });

  it('defaults to answering the queued message', () => {
    expect(sessionRecoveryInitialPrompt(fallback)).toMatch(
      /Then wait for and answer the latest queued follow-up message\.$/
    );
  });
});
