/**
 * Inbox slice E, the sleep-loss error item, entered through the real trigger.
 *
 * Every scenario runs the scheduled sleep sweep (`runSessionSleepSweep`, with a `waitUntil`
 * collector like the cron handler) on a real SQL engine: the real claim, final capture wait,
 * failure accounting, bounded fallback (`runSessionSleepFallback`), shared teardown, and then the
 * real filer (`fileSleepLossError`) writing the shipped `asks` schema (migrations 0245, 0247,
 * 0248). Only the external planes are substituted: ProjectData, the VM agent, R2, the
 * NodeLifecycle DO and the notification DO. Nothing in the filing path is mocked, so deleting the
 * `fileSleepLossError` call from the fallback turns the positive tests red.
 *
 * Time is injected with a fake clock moving the sweep five minutes per tick; the budgets are the
 * production defaults (3 failed attempts), not test overrides.
 *
 * The close of the item on a person's chat message is covered where it is written
 * (`closeChatErrorAsksForHumanMessage`), not here.
 */
import { listInbox, type OperationContext } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createOperationPorts } from '../../src/operation-ports';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import {
  claimSessionSnapshotRecovery,
  completeSessionSnapshotRecovery,
} from '../../src/services/session-snapshots';
import { seedSnapshotGeneration, type SnapshotSeedMode } from '../helpers/session-snapshot-seed';
import { applySqliteMigration, createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

// The sleep side's edges, each a vi.fn the tests drive; `forward` builds the module mocks from
// them so a mocked module reaches the same spy the test asserts on.
const { mocks, forward } = vi.hoisted(() => {
  const names = [
    'cleanupTaskRun',
    'createNotification',
    'deleteNodeResourcesStrict',
    'destroyVmAgentContainer',
    'failSession',
    'finishBlockedSessionSleep',
    'getAcpSession',
    'getSession',
    'getSessionState',
    'hibernateAgentSessionOnNode',
    'markIdle',
    'markVmAgentContainerActiveWorkStarted',
    'persistMessage',
    'scheduleWorkspaceDeletion',
    'sleepSession',
    'sleepVmAgentContainer',
    'startTaskRunnerDO',
    'stopComputeTracking',
    'stopSession',
    'stopWorkspaceOnNode',
    'transitionAcpSession',
  ] as const;
  const spies = Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
    (typeof names)[number],
    ReturnType<typeof vi.fn>
  >;
  const forwardTo = (...keys: Array<(typeof names)[number]>) =>
    Object.fromEntries(
      keys.map((key) => [key, (...args: unknown[]) => spies[key](...args)])
    ) as Record<string, (...args: unknown[]) => unknown>;
  return { mocks: spies, forward: forwardTo };
});

vi.mock('../../src/services/node-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/node-agent')>()),
  ...forward('hibernateAgentSessionOnNode', 'stopWorkspaceOnNode'),
  cancelAgentSessionOnNode: () => Promise.resolve({ success: false, status: 409 }),
}));

// The filer reads the chat from the D1 chat index and only falls back to ProjectData when the
// index has no row, so the real module stays in place and just the sleep-side calls are replaced.
vi.mock('../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/project-data')>(
    '../../src/services/project-data'
  )),
  finishConfirmedSessionSleep: vi.fn(async () => true),
  ...forward(
    'finishBlockedSessionSleep',
    'failSession',
    'getAcpSession',
    'getSession',
    'getSessionState',
    'persistMessage',
    'sleepSession',
    'stopSession',
    'transitionAcpSession'
  ),
}));

vi.mock('../../src/services/compute-usage', () => forward('stopComputeTracking'));

vi.mock('../../src/services/task-runner-do', () => ({
  ...forward('startTaskRunnerDO'),
  ensureTaskRunnerStarted: vi.fn(async () => false),
}));

vi.mock('../../src/services/nodes', () => forward('deleteNodeResourcesStrict'));

vi.mock('../../src/services/task-runner', () => forward('cleanupTaskRun'));

vi.mock('../../src/services/vm-agent-container', () =>
  forward(
    'destroyVmAgentContainer',
    'markVmAgentContainerActiveWorkStarted',
    'sleepVmAgentContainer'
  )
);

const START = new Date('2026-10-04T08:00:00.000Z');
const TICK_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PROJECT = 'project-1';
/** The person who started the chat. Not the workspace user, so the assignee choice is observable. */
const CREATOR = 'creator-1';
/** The workspace's own user: the fallback's `input.userId`. */
const WORKSPACE_USER = 'user-1';

const EXACT_BODY =
  'SAM could not save a fresh snapshot, so it slept the chat from its last complete one; changes made after that snapshot may be lost.';
const UNSAVED_BODY =
  'SAM could not save a snapshot before it shut the workspace down, so unsaved files and uncommitted work may be lost.';

type CaptureMode =
  /** HOME and WIP bundle, exact commit: a complete generation. */
  | 'complete'
  /** WIP bundle and commit kept, HOME skipped: degraded. */
  | 'home-skipped'
  /** The VM agent never accepts the final capture request. */
  | 'unreachable';

describe('sleep-loss inbox item through the real bounded sleep fallback', () => {
  let sqlite: Database.Database;
  let env: Env;
  let capture: CaptureMode;
  let captureByChat: Map<string, CaptureMode>;
  let captureCount: number;
  let r2Objects: Map<string, { size: number; sha256: string | null }>;
  let projectData: Map<string, { status: string }>;
  let notices: Array<{ chatSessionId: string; content: string; messageId: string }>;

  function hex(value: string): ArrayBuffer {
    return Uint8Array.from(Buffer.from(value, 'hex')).buffer;
  }

  function ctx(userId: string): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
      requestId: 'test',
    };
  }

  function insert(table: string, values: Record<string, unknown>) {
    const keys = Object.keys(values);
    sqlite
      .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(values));
  }

  /** One idle VM workspace running a chat, with a bound task and an agent session. */
  function seedSession(id: string, topic: string | null = `Fix flaky ${id}`) {
    const nodeId = `node-${id}`;
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, node_class, runtime)
         VALUES (?, ?, 'running', 'workspace', 'managed', 'vm')`
      )
      .run(nodeId, WORKSPACE_USER);
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, branch, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', 'sam/feature', ?)`
      )
      .run(`ws-${id}`, nodeId, PROJECT, WORKSPACE_USER, `chat-${id}`, START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, workspace_id, chat_session_id, status,
           completed_at, updated_at, auto_provisioned_node_id)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
      )
      .run(
        `task-${id}`,
        PROJECT,
        WORKSPACE_USER,
        `ws-${id}`,
        `chat-${id}`,
        new Date(START.getTime() - 60 * 60 * 1000).toISOString(),
        new Date(START.getTime() - 60 * 60 * 1000).toISOString(),
        nodeId
      );
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, created_by_user_id, status, topic, task_id, workspace_id,
            message_count, started_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 4, ?, ?)`
      )
      .run(
        `chat-${id}`,
        PROJECT,
        WORKSPACE_USER,
        CREATOR,
        topic,
        `task-${id}`,
        `ws-${id}`,
        START.getTime(),
        START.getTime()
      );
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, status, agent_type, created_at)
         VALUES (?, ?, 'running', 'claude-code', ?)`
      )
      .run(`agent-${id}`, `ws-${id}`, START.toISOString());
    projectData.set(`chat-${id}`, { status: 'active' });
  }

  function snapshot(id = 'a') {
    return sqlite
      .prepare(`SELECT * FROM session_snapshots WHERE chat_session_id = ?`)
      .get(`chat-${id}`) as Record<string, unknown> & {
      sleep_status: string | null;
      sleep_episode_failures: number | null;
      snapshot_generation: string | null;
      status: string;
      degradation: string;
    };
  }

  function workspaceStatus(id = 'a') {
    return (
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = ?`).get(`ws-${id}`) as {
        status: string;
      }
    ).status;
  }

  function sleepItems(sessionId?: string) {
    return sqlite
      .prepare(
        `SELECT * FROM asks WHERE kind = 'error' AND source_session_id ${
          sessionId ? '= ?' : 'IS NOT NULL'
        } ORDER BY created_at`
      )
      .all(...(sessionId ? [sessionId] : [])) as Array<Record<string, unknown>>;
  }

  /** Write a completed generation the way `/session-snapshot/complete` would. */
  function completeGeneration(
    chatSessionId: string,
    workspaceId: string,
    generation: string,
    mode: SnapshotSeedMode
  ) {
    seedSnapshotGeneration(sqlite, r2Objects, chatSessionId, workspaceId, generation, mode);
  }

  /** An idle checkpoint taken before the sleep episode began (the exact-restore recovery point). */
  function seedCompleteCheckpoint(id: string) {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id,
            runtime, status, degradation, manifest_r2_key, expires_at, sleep_attempts,
            sleep_episode_failures, recovery_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'vm', 'pending', 'none', 'placeholder', ?, 0, 0, 0, ?, ?)`
      )
      .run(
        `snapshot-${id}`,
        PROJECT,
        `ws-${id}`,
        `node-${id}`,
        WORKSPACE_USER,
        `chat-${id}`,
        `agent-${id}`,
        new Date(START.getTime() + DAY_MS).toISOString(),
        START.toISOString(),
        START.toISOString()
      );
    completeGeneration(`chat-${id}`, `ws-${id}`, `gen-checkpoint-${id}`, 'complete');
  }

  /** Run the sweep as the scheduled handler does, then drain its background work. */
  async function sweepAt(at: Date) {
    vi.setSystemTime(at);
    const background: Promise<unknown>[] = [];
    const stats = await runSessionSleepSweep(env, at, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);
    return stats;
  }

  function tick(n: number): Date {
    return new Date(START.getTime() + n * TICK_MS);
  }

  /** Three failed full attempts at production defaults: ticks `from`..`from + 2`. */
  async function spendFullBudget(ids: string[], from = 0) {
    for (let index = from; index < from + 3; index++) {
      await sweepAt(tick(index));
    }
    for (const id of ids) {
      expect(snapshot(id)).toMatchObject({ sleep_status: 'failed', sleep_episode_failures: 3 });
    }
  }

  /** The fallback attempt itself: the sweep tick after the budget is spent. */
  async function runFallback(at: number) {
    const stats = await sweepAt(tick(at));
    expect(stats).toMatchObject({ fallbacks: expect.any(Number) });
    return stats;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    // The shipped asks migrations, not the drizzle mirror: the partial indexes are under test too.
    sqlite.exec('DROP TABLE asks');
    for (const file of ['0245_asks.sql', '0247_asks_questions.sql', '0248_asks_system_errors.sql'])
      applySqliteMigration(sqlite, new URL(`../../src/db/migrations/${file}`, import.meta.url));
    for (const id of [WORKSPACE_USER, CREATOR])
      insert('users', { id, email: `${id}@x.test`, name: id, role: 'user', status: 'active' });
    insert('projects', {
      id: PROJECT,
      user_id: WORKSPACE_USER,
      name: 'One',
      repository: 'o/one',
      warm_node_timeout_ms: 2700000,
    });
    for (const [user, role] of [
      [WORKSPACE_USER, 'owner'],
      [CREATOR, 'maintainer'],
    ])
      insert('project_members', { project_id: PROJECT, user_id: user, role, status: 'active' });

    capture = 'home-skipped';
    captureByChat = new Map();
    captureCount = 0;
    r2Objects = new Map();
    projectData = new Map();
    notices = [];

    // Idle for an hour: past the automatic idle interval.
    mocks.getSessionState.mockImplementation(async () => ({
      activity: 'idle',
      activityAt: START.getTime() - 60 * 60 * 1000,
    }));
    mocks.getSession.mockImplementation(
      async (_env: Env, _projectId: string, chatSessionId: string) =>
        projectData.get(chatSessionId) ?? null
    );
    mocks.sleepSession.mockImplementation(
      async (_env: Env, _projectId: string, chatSessionId: string) => {
        const state = projectData.get(chatSessionId);
        if (state?.status !== 'active') return false;
        state.status = 'sleeping';
        return true;
      }
    );
    mocks.stopSession.mockImplementation(
      async (_env: Env, _projectId: string, chatSessionId: string) => {
        const state = projectData.get(chatSessionId);
        if (state) state.status = 'stopped';
        return true;
      }
    );
    mocks.persistMessage.mockImplementation(
      async (
        _env: Env,
        _projectId: string,
        chatSessionId: string,
        _role: string,
        content: string,
        _toolMetadata: unknown,
        messageId: string
      ) => {
        if (!notices.some((notice) => notice.messageId === messageId))
          notices.push({ chatSessionId, content, messageId });
        return messageId;
      }
    );
    mocks.getAcpSession.mockResolvedValue(null);
    mocks.stopComputeTracking.mockResolvedValue(1);
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
    mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.markIdle.mockImplementation(async (nodeId: string) => ({
      nodeId,
      status: 'warm',
      warmSince: Date.now(),
    }));
    mocks.createNotification.mockResolvedValue({ id: 'n-1' });
    mocks.hibernateAgentSessionOnNode.mockImplementation(
      async (
        _nodeId: string,
        workspaceId: string,
        _agentSessionId: string,
        _env: Env,
        _userId: string,
        options?: { chatSessionId?: string }
      ) => {
        const chatSessionId = options?.chatSessionId ?? 'chat-a';
        const mode = captureByChat.get(chatSessionId) ?? capture;
        captureCount++;
        if (mode === 'unreachable') {
          throw new Error('Node Agent request failed: VM agent unreachable');
        }
        completeGeneration(
          chatSessionId,
          workspaceId,
          `gen-${chatSessionId}-${captureCount}`,
          mode
        );
        return { status: 'pending', accepted: true };
      }
    );

    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
      R2: {
        head: vi.fn(async (key: string) => {
          const object = r2Objects.get(key);
          return object
            ? { size: object.size, checksums: object.sha256 ? { sha256: hex(object.sha256) } : {} }
            : null;
        }),
        delete: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) r2Objects.delete(key);
        }),
        put: vi.fn(async () => undefined),
      },
      SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
      SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '1000',
      NODE_LIFECYCLE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          markIdle: mocks.markIdle,
          scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
        })),
      },
      NOTIFICATION: {
        idFromName: (name: string) => name,
        get: () => ({
          createNotification: mocks.createNotification,
          claimNotificationDeduplication: vi.fn().mockResolvedValue(true),
        }),
      },
    } as unknown as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
    vi.useRealTimers();
  });

  describe('a fallback sleep without a fresh snapshot files one item for the chat creator', () => {
    it('words a degraded recovery point as unsaved work that may be lost', async () => {
      seedSession('a');
      capture = 'home-skipped';

      await spendFullBudget(['a']);
      // Nothing is filed while the bounded attempts are still failing: the chat has not slept.
      expect(sleepItems()).toHaveLength(0);
      expect(mocks.createNotification).not.toHaveBeenCalled();

      await runFallback(3);

      // Liveness: the fallback really slept the chat on its degraded recovery point.
      expect(snapshot()).toMatchObject({
        sleep_status: 'sleeping',
        status: 'degraded',
        degradation: 'home-skipped',
      });
      expect(workspaceStatus()).toBe('sleeping');
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);

      const items = sleepItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'error',
        project_id: PROJECT,
        // The chat's creator, not the workspace user.
        assignee_user_id: CREATOR,
        dedupe_key: 'error:sleep:chat-a',
        source_session_id: 'chat-a',
        source_task_id: 'task-a',
        title: '“Fix flaky a” went to sleep without saving its latest work',
        failure_count: 1,
        status: 'open',
      });
      // A degraded point is not an exact restore: the unsaved-work sentence, not the snapshot one.
      expect(String(items[0]!.body_md)).toBe(UNSAVED_BODY);
      expect(String(items[0]!.body_md)).not.toBe(EXACT_BODY);
    });

    it('words an exact last-complete-snapshot restore differently', async () => {
      seedSession('a');
      seedCompleteCheckpoint('a');
      captureByChat.set('chat-a', 'unreachable');

      await spendFullBudget(['a']);
      await runFallback(3);

      expect(snapshot()).toMatchObject({
        sleep_status: 'sleeping',
        status: 'available',
        degradation: 'none',
        snapshot_generation: 'gen-checkpoint-a',
      });
      expect(workspaceStatus()).toBe('sleeping');
      const items = sleepItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        assignee_user_id: CREATOR,
        dedupe_key: 'error:sleep:chat-a',
      });
      expect(String(items[0]!.body_md)).toBe(EXACT_BODY);
    });

    it('offers only open_chat, and tells exactly that one person once', async () => {
      seedSession('a');
      await spendFullBudget(['a']);
      await runFallback(3);

      const items = sleepItems();
      expect(items).toHaveLength(1);
      const item = items[0]!;
      // The stored answer spec: one action, `open_chat`. No retry, no free text.
      expect(JSON.parse(String(item.answer_spec_json))).toEqual({
        type: 'actions',
        actions: [{ id: 'open_chat', label: 'Open chat' }],
      });
      // And the creator's real inbox read shows the same single action.
      const page = await listInbox(ctx(CREATOR), { projectId: PROJECT });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        kind: 'error',
        sessionId: 'chat-a',
        canAct: true,
        answerSpec: { type: 'actions', actions: [{ id: 'open_chat', label: 'Open chat' }] },
      });

      expect(mocks.createNotification).toHaveBeenCalledTimes(1);
      const [userId, payload] = mocks.createNotification.mock.calls[0]!;
      expect(userId).toBe(CREATOR);
      expect(payload).toMatchObject({
        type: 'error',
        title: '“Fix flaky a” went to sleep without saving its latest work',
        projectId: PROJECT,
        sessionId: 'chat-a',
        taskId: 'task-a',
      });
      expect(payload.actionUrl).toContain(`/projects/${PROJECT}/inbox?item=`);
    });

    it('falls back to the workspace user when the chat has no recorded creator', async () => {
      seedSession('a');
      sqlite
        .prepare(`UPDATE session_summaries SET created_by_user_id = NULL WHERE id = 'chat-a'`)
        .run();
      await spendFullBudget(['a']);
      await runFallback(3);

      const items = sleepItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ assignee_user_id: WORKSPACE_USER });
      expect(mocks.createNotification.mock.calls[0]![0]).toBe(WORKSPACE_USER);
    });
  });

  describe('a sleep that saved a fresh snapshot files nothing', () => {
    it('files nothing for the ordinary sleep, while the fallback of another chat in the same sweep does', async () => {
      // Chat a captures a complete snapshot on its first attempt (an ordinary sleep). Chat b's
      // agent never answers, so it exhausts the budget and takes the fallback. Both run through the
      // same sweeps, so "nothing filed for a" cannot mean "the filer never ran".
      seedSession('a');
      seedSession('b');
      captureByChat.set('chat-a', 'complete');
      captureByChat.set('chat-b', 'unreachable');

      await sweepAt(tick(0));
      expect(snapshot('a')).toMatchObject({
        sleep_status: 'sleeping',
        status: 'available',
        degradation: 'none',
        sleep_fallback_json: null,
      });
      expect(workspaceStatus('a')).toBe('sleeping');
      expect(sleepItems('chat-a')).toHaveLength(0);

      await sweepAt(tick(1));
      await sweepAt(tick(2));
      await runFallback(3);

      expect(snapshot('b')).toMatchObject({ sleep_status: 'sleeping' });
      expect(workspaceStatus('b')).toBe('sleeping');
      // The filer ran for b...
      expect(sleepItems('chat-b')).toHaveLength(1);
      // ...and still has nothing for the chat that slept on a fresh snapshot.
      expect(sleepItems('chat-a')).toHaveLength(0);
      expect(sleepItems()).toHaveLength(1);
      expect(mocks.createNotification).toHaveBeenCalledTimes(1);
      expect(mocks.createNotification.mock.calls[0]![0]).toBe(CREATOR);
    });
  });

  describe('a second fallback sleep of the same chat while the item is open', () => {
    it('updates the one item (failure_count 2) and sends no second notification', async () => {
      seedSession('a');
      await spendFullBudget(['a']);
      await runFallback(3);
      const first = sleepItems();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ failure_count: 1, status: 'open' });
      expect(mocks.createNotification).toHaveBeenCalledTimes(1);

      // The chat wakes through the real wake claim and commit, and the replacement runtime goes
      // idle again. The item stays open: nobody has answered or messaged.
      const db = drizzle(env.DATABASE, { schema });
      await expect(
        claimSessionSnapshotRecovery(db, env, {
          chatSessionId: 'chat-a',
          userId: WORKSPACE_USER,
          taskId: 'wake-task',
          now: tick(4),
        })
      ).resolves.toMatchObject({ status: 'claimed' });
      await expect(
        completeSessionSnapshotRecovery(db, 'chat-a', 'wake-task', 'ws-a')
      ).resolves.toBe(true);
      sqlite.prepare(`UPDATE workspaces SET status = 'running' WHERE id = 'ws-a'`).run();
      sqlite.prepare(`UPDATE nodes SET status = 'running' WHERE id = 'node-a'`).run();
      sqlite.prepare(`UPDATE agent_sessions SET status = 'running' WHERE id = 'agent-a'`).run();
      projectData.set('chat-a', { status: 'active' });
      expect(snapshot()).toMatchObject({ sleep_status: null });

      await spendFullBudget(['a'], 10);
      await runFallback(13);

      // Liveness: the second fallback really slept the chat again.
      expect(snapshot()).toMatchObject({ sleep_status: 'sleeping' });
      expect(workspaceStatus()).toBe('sleeping');
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(2);

      const second = sleepItems();
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        id: first[0]!.id,
        dedupe_key: 'error:sleep:chat-a',
        failure_count: 2,
        status: 'open',
      });
      expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('an archived chat files nothing', () => {
    it('skips the archived chat while the active one in the same sweep files its item', async () => {
      seedSession('a');
      seedSession('b');
      captureByChat.set('chat-a', 'unreachable');
      captureByChat.set('chat-b', 'unreachable');
      // The chat was archived (a normal ending) after its agent stopped answering.
      sqlite.prepare(`UPDATE session_summaries SET status = 'archived' WHERE id = 'chat-a'`).run();

      await spendFullBudget(['a', 'b']);
      await runFallback(3);

      // Both runtimes were released by the fallback: the archived chat did go through it.
      for (const id of ['a', 'b']) {
        expect(snapshot(id)).toMatchObject({ sleep_status: 'sleeping' });
        expect(workspaceStatus(id)).toBe('sleeping');
      }
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(2);

      expect(sleepItems('chat-a')).toHaveLength(0);
      expect(sleepItems('chat-b')).toHaveLength(1);
      expect(sleepItems()).toHaveLength(1);
      expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('filing never stops the sleep', () => {
    it('still completes the fallback sleep when the asks table is gone', async () => {
      seedSession('a');
      await spendFullBudget(['a']);
      sqlite.exec('DROP TABLE asks');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const stats = await runFallback(3);

      // The filer ran and failed...
      const logged = errors.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('inbox.system_error_file_failed');
      // ...and the sleep completed regardless: the row, the workspace, the teardown and the
      // post-teardown cleanup all happened, and the outcome is not a retry.
      expect(stats).toMatchObject({ fallbacks: 1 });
      expect(snapshot()).toMatchObject({ sleep_status: 'sleeping' });
      expect(workspaceStatus()).toBe('sleeping');
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
      expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith(
        'node-a',
        'ws-a',
        WORKSPACE_USER,
        { retryAfterMs: 0 }
      );
      expect(projectData.get('chat-a')?.status).toBe('sleeping');
      expect(mocks.createNotification).not.toHaveBeenCalled();
    });
  });
});
