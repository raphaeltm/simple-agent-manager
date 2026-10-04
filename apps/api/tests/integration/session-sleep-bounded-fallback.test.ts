/**
 * Vertical slice for the bounded sleep-failure episode (`session-sleep-episode.ts`).
 *
 * Every scenario enters through the scheduled trigger (`runSessionSleepSweep`, with a
 * `waitUntil` collector like the cron handler) and runs the real D1 lifecycle on SQLite:
 * reconciliation, claim, final capture wait, failure accounting, the transcript-and-Git
 * fallback, the blocked outcome, the shared teardown, and the seven-day purge. Only the
 * external planes are substituted — ProjectData, the VM agent, R2 and the NodeLifecycle
 * DO — and the budgets are the production defaults resolved by the real config readers
 * (3 failed attempts or 15 minutes, ceiling 9, 5-minute retry), not test overrides.
 *
 * Time is injected: a fake clock moves the sweep forward five minutes per tick, so no
 * test keeps anything running for real (task brief: inject clocks/faults).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { sessionSnapshotRoutes } from '../../src/routes/workspaces/session-snapshots';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { runSessionSnapshotPurge } from '../../src/scheduled/session-snapshot-purge';
import { sleepWorkspaceSession } from '../../src/services/session-sleep';
import { parseSessionSleepFallbackRecord } from '../../src/services/session-sleep-episode';
import { sessionRecoveryInitialPrompt } from '../../src/services/session-sleep-fallback-messages';
import { findRestorableOrInFlightSleepSnapshot } from '../../src/services/session-snapshot-sleep-predicate';
import {
  cancelScheduledSessionSleep,
  claimSessionSnapshotRecovery,
  completeSessionSnapshot,
  completeSessionSnapshotRecovery,
  recordSessionSnapshotProgress,
} from '../../src/services/session-snapshots';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import { createRouteTestApp } from '../unit/routes/route-test-app';

const mocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(),
  destroyVmAgentContainer: vi.fn(),
  failSession: vi.fn(),
  getAcpSession: vi.fn(),
  getSession: vi.fn(),
  getSessionState: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  markIdle: vi.fn(),
  markVmAgentContainerActiveWorkStarted: vi.fn(),
  persistMessage: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  sleepSession: vi.fn(),
  sleepVmAgentContainer: vi.fn(),
  stopComputeTracking: vi.fn(),
  stopSession: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  transitionAcpSession: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

vi.mock('../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/jwt')>()),
  verifyCallbackToken: (...args: unknown[]) => mocks.verifyCallbackToken(...args),
}));

vi.mock('../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: (...args: unknown[]) => mocks.hibernateAgentSessionOnNode(...args),
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  failSession: (...args: unknown[]) => mocks.failSession(...args),
  getAcpSession: (...args: unknown[]) => mocks.getAcpSession(...args),
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  getSessionState: (...args: unknown[]) => mocks.getSessionState(...args),
  persistMessage: (...args: unknown[]) => mocks.persistMessage(...args),
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  transitionAcpSession: (...args: unknown[]) => mocks.transitionAcpSession(...args),
}));

vi.mock('../../src/services/compute-usage', () => ({
  stopComputeTracking: (...args: unknown[]) => mocks.stopComputeTracking(...args),
}));

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

vi.mock('../../src/services/vm-agent-container', () => ({
  destroyVmAgentContainer: (...args: unknown[]) => mocks.destroyVmAgentContainer(...args),
  markVmAgentContainerActiveWorkStarted: (...args: unknown[]) =>
    mocks.markVmAgentContainerActiveWorkStarted(...args),
  sleepVmAgentContainer: (...args: unknown[]) => mocks.sleepVmAgentContainer(...args),
}));

const START = new Date('2026-10-04T08:00:00.000Z');
const TICK_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_COMMIT = 'a'.repeat(40);
const HOME_SHA256 = 'ab'.repeat(32);
const WIP_SHA256 = 'cd'.repeat(32);

type CaptureMode =
  /** Complete: HOME and WIP bundle, exact commit (a full sleep can use it). */
  | 'complete'
  /** Current agent whose HOME overflows the budget: WIP bundle and commit kept, HOME skipped. */
  | 'home-skipped'
  /** WIP failed but the commit was recorded: a local-only hash with no retained objects. */
  | 'wip-skipped'
  /** Pre-fix agent: the upload completes but `/complete` is rejected (body too large). */
  | 'old-agent-rejected'
  /** The VM agent never accepts the final capture request. */
  | 'unreachable';

interface ProjectDataState {
  status: string;
}

describe('bounded sleep-failure episode: transcript-and-Git fallback', () => {
  let sqlite: Database.Database;
  let env: Env;
  let capture: CaptureMode;
  let captureCount: number;
  let r2Objects: Map<string, { size: number; sha256: string | null }>;
  let projectData: Map<string, ProjectDataState>;
  let activity: Record<string, unknown>;
  let notices: Array<{ chatSessionId: string; content: string; messageId: string }>;
  let order: string[];

  function hex(value: string): ArrayBuffer {
    return Uint8Array.from(Buffer.from(value, 'hex')).buffer;
  }

  function seedSession(input: {
    id: string;
    runtime?: 'vm' | 'cf-container';
    taskStatus?: string;
    nodeId?: string;
  }) {
    const nodeId = input.nodeId ?? 'node-1';
    const runtime = input.runtime ?? 'vm';
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO nodes (id, user_id, status, node_role, runtime)
         VALUES (?, 'user-1', 'running', 'workspace', ?)`
      )
      .run(nodeId, runtime);
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, branch, updated_at)
         VALUES (?, ?, 'project-1', 'user-1', ?, 'running', 'sam/feature', ?)`
      )
      .run(`ws-${input.id}`, nodeId, `chat-${input.id}`, START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, workspace_id, status, completed_at, updated_at)
         VALUES (?, 'project-1', 'user-1', ?, ?, ?, ?)`
      )
      .run(
        `task-${input.id}`,
        `ws-${input.id}`,
        input.taskStatus ?? 'completed',
        new Date(START.getTime() - 60 * 60 * 1000).toISOString(),
        new Date(START.getTime() - 60 * 60 * 1000).toISOString()
      );
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, task_id, workspace_id, message_count, started_at, updated_at)
         VALUES (?, 'project-1', 'user-1', 'active', ?, ?, 4, ?, ?)`
      )
      .run(
        `chat-${input.id}`,
        `task-${input.id}`,
        `ws-${input.id}`,
        START.getTime(),
        START.getTime()
      );
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, status, agent_type, created_at)
         VALUES (?, ?, 'running', 'claude-code', ?)`
      )
      .run(`agent-${input.id}`, `ws-${input.id}`, START.toISOString());
    projectData.set(`chat-${input.id}`, { status: 'active' });
  }

  function row(id = 'a') {
    return sqlite
      .prepare(`SELECT * FROM session_snapshots WHERE chat_session_id = ?`)
      .get(`chat-${id}`) as Record<string, unknown> & {
      sleep_status: string | null;
      sleep_after: string | null;
      sleep_episode_failures: number | null;
      sleep_episode_started_at: string | null;
      sleep_fallback_json: string | null;
      sleeping_at: string | null;
      expires_at: string;
      status: string;
      degradation: string;
      snapshot_generation: string | null;
      capture_generation: string | null;
    };
  }

  function fallbackRecord(id = 'a') {
    return parseSessionSleepFallbackRecord(row(id).sleep_fallback_json);
  }

  /**
   * The wake's restore request, as the vm-agent on the replacement workspace sends it,
   * through the real route and the real snapshot row.
   */
  async function restoreResponse(id = 'a') {
    const workspaceId = `ws-wake-${id}`;
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO nodes (id, user_id, status, node_role, runtime)
         VALUES ('node-wake', 'user-1', 'running', 'workspace', 'vm')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, branch, updated_at)
         VALUES (?, 'node-wake', 'project-1', 'user-1', ?, 'running', 'sam/feature', ?)`
      )
      .run(workspaceId, `chat-${id}`, new Date().toISOString());
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: workspaceId,
      type: 'callback',
      scope: 'workspace',
    });
    const res = await createRouteTestApp('/api/workspaces', sessionSnapshotRoutes).request(
      `/api/workspaces/${workspaceId}/session-snapshot/restore?chatSessionId=chat-${id}`,
      { headers: { Authorization: 'Bearer callback-token' } },
      env
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      available: boolean;
      baseCommit: string | null;
      manifest: Record<string, unknown> | null;
      download: Record<string, string | null>;
    };
  }

  function workspaceStatus(id = 'a') {
    return (
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = ?`).get(`ws-${id}`) as {
        status: string;
      }
    ).status;
  }

  /** Write a completed generation the way `/session-snapshot/complete` would. */
  function completeGeneration(
    chatSessionId: string,
    workspaceId: string,
    generation: string,
    mode: 'complete' | 'home-skipped' | 'wip-skipped'
  ) {
    const prefix = `session-snapshots/${chatSessionId}/${generation}`;
    const home = mode === 'complete' || mode === 'wip-skipped';
    const wip = mode === 'complete' || mode === 'home-skipped';
    if (home) r2Objects.set(`${prefix}/home.tar`, { size: 4, sha256: HOME_SHA256 });
    if (wip) r2Objects.set(`${prefix}/wip.bundle`, { size: 9, sha256: WIP_SHA256 });
    r2Objects.set(`${prefix}/manifest.json`, { size: 512, sha256: null });
    const status = mode === 'complete' ? 'available' : 'degraded';
    const degradation = mode === 'complete' ? 'none' : mode;
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET status = ?, degradation = ?, snapshot_generation = ?, capture_generation = NULL,
             capture_error = NULL, base_commit = ?,
             home_r2_key = ?, home_sha256 = ?, wip_r2_key = ?, wip_sha256 = ?,
             manifest_r2_key = ?, manifest_json = ?, expires_at = ?
         WHERE chat_session_id = ?`
      )
      .run(
        status,
        degradation,
        generation,
        BASE_COMMIT,
        home ? `${prefix}/home.tar` : null,
        home ? HOME_SHA256 : null,
        wip ? `${prefix}/wip.bundle` : null,
        wip ? WIP_SHA256 : null,
        `${prefix}/manifest.json`,
        JSON.stringify({
          version: 1,
          chatSessionId,
          workspaceId,
          agentSessionId: workspaceId.replace('ws-', 'agent-'),
          acpSessionId: 'acp-1',
          agentType: 'claude-code',
          baseCommit: BASE_COMMIT,
          git: {
            branch: 'sam/feature',
            upstream: 'origin/sam/feature',
            remote: 'origin',
            detached: false,
          },
          status,
          degradation,
          skipped: mode === 'complete' ? [] : [{ path: '$HOME', reason: 'budget exhausted' }],
          artifacts: {
            ...(home ? { home: { sizeBytes: 4, sha256: HOME_SHA256 } } : {}),
            ...(wip ? { wip: { sizeBytes: 9, sha256: WIP_SHA256 } } : {}),
          },
          createdAt: new Date().toISOString(),
        }),
        new Date(Date.now() + 7 * DAY_MS).toISOString(),
        chatSessionId
      );
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

  /** Run `concurrent` once, just before the next statement matching `pattern` is prepared. */
  function interleaveBefore(pattern: RegExp, concurrent: () => void | Promise<void>) {
    const base = env.DATABASE;
    const state = { fired: false };
    env = {
      ...env,
      DATABASE: {
        ...base,
        prepare: (query: string) => {
          if (!state.fired && pattern.test(query)) {
            state.fired = true;
            void concurrent();
          }
          return base.prepare(query);
        },
      } as unknown as D1Database,
    } as Env;
    return state;
  }

  const FALLBACK_STOPPING_WRITE =
    /^update "session_snapshots" set "sleep_status" = \?, "sleep_after" = \?, "sleep_claimed_at" = \?, "sleep_stopping_since" = COALESCE\("session_snapshots"\."sleep_stopping_since", \?\), "sleep_fallback_json"/i;
  /** The fallback's first read after its claim: well before its point of no return. */
  const FALLBACK_EPISODE_READ =
    /"sleep_episode_started_at", "sleep_episode_failures", "capture_generation" from "session_snapshots"/i;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.projects,
      schema.nodes,
      schema.workspaces,
      schema.tasks,
      schema.sessionSummaries,
      schema.agentSessions,
      schema.sessionSnapshots,
      schema.computeUsage,
      // Read by the wake claim's archive-migration fence.
      schema.projectDataSessionLocations,
    ]);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    sqlite
      .prepare(`INSERT INTO projects (id, warm_node_timeout_ms) VALUES ('project-1', 2700000)`)
      .run();

    capture = 'home-skipped';
    captureCount = 0;
    r2Objects = new Map();
    projectData = new Map();
    notices = [];
    order = [];
    // Idle for an hour: past the automatic idle interval.
    activity = { activity: 'idle', activityAt: START.getTime() - 60 * 60 * 1000 };

    mocks.getSessionState.mockImplementation(async () => activity);
    mocks.getSession.mockImplementation(
      async (_env: Env, _projectId: string, chatSessionId: string) =>
        projectData.get(chatSessionId) ?? null
    );
    mocks.sleepSession.mockImplementation(
      async (_env: Env, _projectId: string, chatSessionId: string) => {
        const state = projectData.get(chatSessionId);
        if (state?.status !== 'active') return false;
        state.status = 'sleeping';
        order.push(`project-data-sleep:${chatSessionId}`);
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
        const existing = notices.find((notice) => notice.messageId === messageId);
        if (existing && existing.content !== content) {
          throw new Error('Duplicate message id with different content');
        }
        if (!existing) notices.push({ chatSessionId, content, messageId });
        order.push(`notice:${messageId}`);
        return messageId;
      }
    );
    mocks.getAcpSession.mockResolvedValue(null);
    mocks.stopComputeTracking.mockResolvedValue(1);
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
    mocks.stopWorkspaceOnNode.mockImplementation(async (_nodeId: string, workspaceId: string) => {
      order.push(`stop:${workspaceId}`);
    });
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.markIdle.mockImplementation(async (nodeId: string) => {
      order.push(`warm:${nodeId}`);
    });
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
        captureCount++;
        order.push(`capture:${chatSessionId}`);
        if (capture === 'unreachable') {
          throw new Error('Node Agent request failed: VM agent unreachable');
        }
        const generation = `gen-${chatSessionId}-${captureCount}`;
        if (capture === 'old-agent-rejected') {
          // The pre-fix agent prepared and uploaded a full-history bundle, then its
          // /complete was rejected and it reported the failure for its generation.
          const prefix = `session-snapshots/${chatSessionId}/${generation}`;
          r2Objects.set(`${prefix}/wip.bundle`, { size: 258_616_693, sha256: null });
          sqlite
            .prepare(
              `UPDATE session_snapshots SET capture_generation = ?, capture_error = ?
               WHERE chat_session_id = ?`
            )
            .run(
              generation,
              'control plane returned 400: Snapshot request body is too large',
              chatSessionId
            );
          return { status: 'pending', accepted: true };
        }
        completeGeneration(chatSessionId, workspaceId, generation, capture);
        return { status: 'pending', accepted: true };
      }
    );

    env = {
      DATABASE: createSqliteD1(sqlite),
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
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  /** Three failed full attempts at production defaults: ticks 0, 1 and 2. */
  async function spendFullBudget(id = 'a') {
    for (let index = 0; index < 3; index++) {
      const stats = await sweepAt(tick(index));
      expect(stats).toMatchObject({ claimed: 1 });
    }
    expect(row(id)).toMatchObject({ sleep_status: 'failed', sleep_episode_failures: 3 });
  }

  describe('permanently degraded captures', () => {
    it('falls back after three failed attempts, keeping the transcript, exact commit and WIP', async () => {
      seedSession({ id: 'a' });

      await spendFullBudget();
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(captureCount).toBe(3);

      const fallback = await sweepAt(tick(3));

      expect(fallback).toMatchObject({ fallbacks: 1, claimed: 0 });
      // No fourth capture: the fallback releases compute with what was already saved.
      expect(captureCount).toBe(3);
      const slept = row();
      expect(slept).toMatchObject({
        sleep_status: 'sleeping',
        status: 'degraded',
        degradation: 'home-skipped',
        snapshot_generation: 'gen-chat-a-3',
        sleep_episode_failures: 0,
        sleep_episode_started_at: null,
      });
      // Seven-day wake window from the fallback sleep itself.
      expect(Date.parse(slept.expires_at)).toBe(Date.parse(String(slept.sleeping_at)) + 7 * DAY_MS);
      expect(fallbackRecord()).toMatchObject({
        outcome: 'slept',
        trigger: 'attempt_budget',
        failedAttempts: 3,
        episodeStartedAt: tick(0).toISOString(),
        recoveryPoint: {
          generation: 'gen-chat-a-3',
          commit: BASE_COMMIT,
          branch: 'sam/feature',
          workingTreeSaved: true,
          homeSaved: false,
        },
      });
      expect(workspaceStatus()).toBe('sleeping');
      expect(projectData.get('chat-a')?.status).toBe('sleeping');
      // The notice landed in the conversation before the runtime was stopped.
      expect(notices).toHaveLength(1);
      expect(notices[0]?.content).toContain(
        'SAM put this session to sleep without saving all of its files.'
      );
      expect(notices[0]?.content).toContain(
        `branch sam/feature at commit ${BASE_COMMIT.slice(0, 12)}`
      );
      expect(notices[0]?.content).toContain('with its uncommitted changes');
      expect(order.indexOf(`notice:${notices[0]?.messageId}`)).toBeLessThan(
        order.indexOf('stop:ws-a')
      );
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledExactlyOnceWith(
        'node-1',
        'ws-a',
        expect.anything(),
        'user-1'
      );
      expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith('node-1', 'ws-a', 'user-1');
      // The only workspace on the node: it turns warm, keeping warm retention.
      expect(mocks.markIdle).toHaveBeenCalledWith('node-1', 'user-1', 2700000);

      // Bounded: nothing selects or captures it again.
      expect(await sweepAt(tick(4))).toMatchObject({ selected: 0 });
      expect(captureCount).toBe(3);
    });

    it('leaves a wakeable recovery point and an honest wake prompt', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      await sweepAt(tick(3));

      // The resumer's own predicate still sees a restorable sleeping snapshot.
      await expect(
        findRestorableOrInFlightSleepSnapshot(env.DATABASE, env, {
          projectId: 'project-1',
          chatSessionId: 'chat-a',
          now: tick(4),
        })
      ).resolves.toMatchObject({ sleep_status: 'sleeping' });
      const prompt = sessionRecoveryInitialPrompt(fallbackRecord());
      expect(prompt).toContain(`SAM restored commit ${BASE_COMMIT} on branch sam/feature`);
      expect(prompt).toContain('Run git status and git log -1');
      expect(prompt).toContain('Do not repeat actions with effects outside this workspace');
    });
  });

  describe('pre-fix agents that never complete a capture', () => {
    it('ends the episode blocked: no teardown, an actionable notice, no more captures', async () => {
      seedSession({ id: 'a' });
      capture = 'old-agent-rejected';

      await spendFullBudget();
      // Each rejected capture completes as a transcript-only marker with no commit, and
      // its orphaned full-history bundle is cleaned up.
      expect(row()).toMatchObject({ status: 'degraded', degradation: 'transcript-only' });
      expect([...r2Objects.keys()].filter((key) => key.endsWith('wip.bundle'))).toHaveLength(0);

      const blocked = await sweepAt(tick(3));

      expect(blocked).toMatchObject({ fallbacks: 1 });
      expect(row()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });
      expect(fallbackRecord()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'no_git_baseline',
      });
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(workspaceStatus()).toBe('running');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.content).toContain('SAM could not put this session to sleep.');
      expect(notices[0]?.content).toContain(
        'commit and push anything you want to keep, then stop its workspace from the Workspaces page'
      );

      // The exit holds: later sweeps neither select nor capture it.
      for (let index = 4; index < 10; index++) {
        expect(await sweepAt(tick(index))).toMatchObject({ selected: 0 });
      }
      expect(captureCount).toBe(3);
    });

    it('gives a human follow-up a fresh episode, but never an unbounded one', async () => {
      seedSession({ id: 'a' });
      capture = 'old-agent-rejected';
      await spendFullBudget();
      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'terminal_failed' });

      // The user replies: the follow-up route cancels sleep before delivering.
      await cancelScheduledSessionSleep(drizzle(env.DATABASE, { schema }), 'chat-a');
      expect(row()).toMatchObject({
        sleep_status: null,
        sleep_episode_failures: 0,
        sleep_fallback_json: null,
      });

      // Idle again later: discovery queues a new intent and the new episode is bounded too.
      activity = { activity: 'idle', activityAt: tick(4).getTime() - 60 * 60 * 1000 };
      for (let index = 5; index < 8; index++) await sweepAt(tick(index));
      expect(captureCount).toBe(6);
      await sweepAt(tick(8));
      expect(row()).toMatchObject({ sleep_status: 'terminal_failed' });
      for (let index = 9; index < 12; index++) await sweepAt(tick(index));
      expect(captureCount).toBe(6);
    });
  });

  describe('non-degraded exhaustion', () => {
    it('falls back on the last complete snapshot when the agent stops answering', async () => {
      seedSession({ id: 'a' });
      // An idle checkpoint completed earlier (before the sleep episode began).
      capture = 'complete';
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id,
              runtime, status, degradation, manifest_r2_key, expires_at, sleep_attempts,
              sleep_episode_failures, recovery_attempts, created_at, updated_at)
           VALUES ('snapshot-a', 'project-1', 'ws-a', 'node-1', 'user-1', 'chat-a', 'agent-a',
                   'vm', 'pending', 'none', 'placeholder', ?, 0, 0, 0, ?, ?)`
        )
        .run(
          new Date(START.getTime() + DAY_MS).toISOString(),
          START.toISOString(),
          START.toISOString()
        );
      completeGeneration('chat-a', 'ws-a', 'gen-checkpoint', 'complete');
      capture = 'unreachable';

      await spendFullBudget();
      await sweepAt(tick(3));

      expect(row()).toMatchObject({
        sleep_status: 'sleeping',
        status: 'available',
        snapshot_generation: 'gen-checkpoint',
      });
      expect(notices[0]?.content).toContain(
        'SAM put this session to sleep using its last complete snapshot.'
      );
      expect(sessionRecoveryInitialPrompt(fallbackRecord())).toContain(
        'SAM restored that snapshot, so changes made after it are not in this workspace.'
      );
    });

    it('ends blocked when no capture ever recorded a commit', async () => {
      seedSession({ id: 'a' });
      capture = 'unreachable';

      await spendFullBudget();
      await sweepAt(tick(3));

      expect(fallbackRecord()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'no_git_baseline',
      });
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    });

    it('quotes the last error without secrets or control characters', async () => {
      seedSession({ id: 'a' });
      capture = 'unreachable';
      const secret = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
      mocks.hibernateAgentSessionOnNode.mockRejectedValue(
        new Error(`Node Agent request failed: Authorization: ${secret}\u0007 rejected`)
      );

      await spendFullBudget();
      // Liveness: the raw error was recorded for operators, so the scenario is real.
      expect(row().sleep_error).toContain(secret);
      await sweepAt(tick(3));

      expect(notices).toHaveLength(1);
      const notice = notices[0]?.content ?? '';
      expect(notice).toContain('Last error: Node Agent request failed: Authorization: [REDACTED]');
      expect(notice).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
      expect(notice).not.toContain('\u0007');
      expect(fallbackRecord()?.lastError).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    });
  });

  describe('the wake after a fallback sleep', () => {
    // The vm-agent loads the saved agent session only when the restore manifest names
    // it (`snapshotHarnessResumeIdentity`). Without it the restore is degraded and the
    // agent starts fresh with the wake prompt, which is the only path that sends it.
    it('does not resume the stale agent session of a degraded recovery point', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'sleeping', degradation: 'home-skipped' });

      const restore = await restoreResponse();

      expect(restore).toMatchObject({ available: true, baseCommit: BASE_COMMIT });
      expect(restore.manifest).toMatchObject({
        baseCommit: BASE_COMMIT,
        agentType: 'claude-code',
        git: { branch: 'sam/feature', detached: false },
      });
      expect(restore.manifest).not.toHaveProperty('acpSessionId');
      expect(restore.download.wip).toContain('/session-snapshot/artifacts/wip');
    });

    it('restores the files of a complete recovery point but still starts the agent fresh', async () => {
      seedSession({ id: 'a' });
      capture = 'complete';
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id,
              runtime, status, degradation, manifest_r2_key, expires_at, sleep_attempts,
              sleep_episode_failures, recovery_attempts, created_at, updated_at)
           VALUES ('snapshot-a', 'project-1', 'ws-a', 'node-1', 'user-1', 'chat-a', 'agent-a',
                   'vm', 'pending', 'none', 'placeholder', ?, 0, 0, 0, ?, ?)`
        )
        .run(
          new Date(START.getTime() + DAY_MS).toISOString(),
          START.toISOString(),
          START.toISOString()
        );
      completeGeneration('chat-a', 'ws-a', 'gen-checkpoint', 'complete');
      capture = 'unreachable';
      await spendFullBudget();
      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'sleeping', status: 'available' });

      const restore = await restoreResponse();

      expect(restore.download.home).toContain('/session-snapshot/artifacts/home');
      expect(restore.manifest).toMatchObject({ artifacts: { home: { sizeBytes: 4 } } });
      expect(restore.manifest).not.toHaveProperty('acpSessionId');
    });

    it('ends with the wake, so the next restore resumes the agent session again', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      await sweepAt(tick(3));
      const db = drizzle(env.DATABASE, { schema });

      // The wake, through the resumer's own claim, restore and commit.
      await expect(
        claimSessionSnapshotRecovery(db, env, {
          chatSessionId: 'chat-a',
          userId: 'user-1',
          taskId: 'wake-task',
          now: tick(4),
        })
      ).resolves.toMatchObject({ status: 'claimed' });
      expect((await restoreResponse()).manifest).not.toHaveProperty('acpSessionId');
      await expect(
        completeSessionSnapshotRecovery(db, 'chat-a', 'wake-task', 'ws-wake-a')
      ).resolves.toBe(true);
      expect(row()).toMatchObject({
        sleeping_at: null,
        sleep_fallback_json: null,
        sleep_episode_failures: 0,
        sleep_episode_started_at: null,
      });

      // The next sleep's complete capture: its wake loads the agent session normally.
      completeGeneration('chat-a', 'ws-wake-a', 'gen-after-wake', 'complete');
      expect((await restoreResponse()).manifest).toMatchObject({ acpSessionId: 'acp-1' });
    });

    it('still resumes the agent session after an ordinary sleep', async () => {
      seedSession({ id: 'a' });
      capture = 'complete';

      await sweepAt(tick(0));
      expect(row()).toMatchObject({ sleep_status: 'sleeping', sleep_fallback_json: null });
      expect(notices).toHaveLength(0);

      const restore = await restoreResponse();

      expect(restore.manifest).toMatchObject({ acpSessionId: 'acp-1', agentType: 'claude-code' });
    });
  });

  describe('preserving existing good artifacts', () => {
    it('never replaces a Git-bearing generation with a transcript-only marker', async () => {
      seedSession({ id: 'a' });
      capture = 'home-skipped';
      await sweepAt(tick(0));
      const kept = row();
      expect(kept).toMatchObject({
        snapshot_generation: 'gen-chat-a-1',
        degradation: 'home-skipped',
      });
      const keptWip = String(kept.wip_r2_key);

      // The next capture stalls (pre-fix agent). It must be abandoned, not completed
      // over the generation that holds the commit and the bundle.
      capture = 'old-agent-rejected';
      await sweepAt(tick(1));

      expect(row()).toMatchObject({
        snapshot_generation: 'gen-chat-a-1',
        degradation: 'home-skipped',
        capture_generation: null,
        wip_r2_key: keptWip,
      });
      expect(r2Objects.has(keptWip)).toBe(true);
      // The abandoned generation's own upload is gone.
      expect(r2Objects.has('session-snapshots/chat-a/gen-chat-a-2/wip.bundle')).toBe(false);

      // So the fallback still has its recovery point.
      await sweepAt(tick(2));
      await sweepAt(tick(3));
      expect(fallbackRecord()).toMatchObject({ outcome: 'slept' });
      expect(row()).toMatchObject({
        sleep_status: 'sleeping',
        snapshot_generation: 'gen-chat-a-1',
      });
    });

    it('rejects a late completion and progress from a capture the fallback abandoned', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      // A slow capture is still in flight when the fallback runs.
      sqlite
        .prepare(
          `UPDATE session_snapshots SET capture_generation = 'late-gen' WHERE chat_session_id = 'chat-a'`
        )
        .run();
      r2Objects.set('session-snapshots/chat-a/late-gen/wip.bundle', {
        size: 9,
        sha256: WIP_SHA256,
      });

      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'sleeping', capture_generation: null });
      expect(r2Objects.has('session-snapshots/chat-a/late-gen/wip.bundle')).toBe(false);

      const db = drizzle(env.DATABASE, { schema });
      await expect(
        recordSessionSnapshotProgress(db, { chatSessionId: 'chat-a', generation: 'late-gen' })
      ).resolves.toBe(false);
      await expect(
        completeSessionSnapshot(db, env, {
          workspaceId: 'ws-a',
          chatSessionId: 'chat-a',
          agentSessionId: 'agent-a',
          runtime: 'vm',
          baseCommit: BASE_COMMIT,
          captureGeneration: 'late-gen',
          status: 'available',
          degradation: 'none',
          manifest: {
            version: 1,
            chatSessionId: 'chat-a',
            workspaceId: 'ws-a',
            status: 'available',
            degradation: 'none',
            skipped: [],
            artifacts: {},
            createdAt: tick(3).toISOString(),
          },
          artifactSizes: {},
        })
      ).rejects.toThrow('Snapshot capture generation is no longer current');
      // The recovery point the session slept on is untouched.
      expect(row()).toMatchObject({
        snapshot_generation: 'gen-chat-a-3',
        sleep_status: 'sleeping',
      });
    });
  });

  describe('races at the point of no return', () => {
    it('aborts when a human follow-up cancels the claim before teardown', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      // The real follow-up writer, racing the fallback between its claim and its CAS.
      const interleave = interleaveBefore(FALLBACK_EPISODE_READ, () =>
        cancelScheduledSessionSleep(drizzle(createSqliteD1(sqlite), { schema }), 'chat-a')
      );

      await sweepAt(tick(3));

      expect(interleave.fired).toBe(true);
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(notices).toHaveLength(0);
      expect(workspaceStatus()).toBe('running');
      // The follow-up started a new episode.
      expect(row()).toMatchObject({ sleep_status: null, sleep_episode_failures: 0 });
    });

    it('defers without spending the budget when the agent starts working again', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      let reads = 0;
      mocks.getSessionState.mockImplementation(async () => {
        reads++;
        // Idle for the sweep's eligibility and the fallback's first check, then busy.
        return reads <= 2 ? activity : { activity: 'prompting', activityAt: tick(3).getTime() };
      });

      await sweepAt(tick(3));

      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(notices).toHaveLength(0);
      expect(row()).toMatchObject({ sleep_status: 'scheduled', sleep_episode_failures: 3 });
    });

    it('lets a complete capture that lands first win over the fallback decision', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      const interleave = interleaveBefore(FALLBACK_STOPPING_WRITE, () =>
        completeGeneration('chat-a', 'ws-a', 'gen-late-complete', 'complete')
      );

      await sweepAt(tick(3));

      expect(interleave.fired).toBe(true);
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(notices).toHaveLength(0);

      // The next sweep re-decides with the complete generation.
      await sweepAt(tick(4));
      expect(row()).toMatchObject({
        sleep_status: 'sleeping',
        snapshot_generation: 'gen-late-complete',
      });
      expect(notices[0]?.content).toContain('using its last complete snapshot');
    });

    it('tears a runtime down once under overlapping sweeps', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      vi.setSystemTime(tick(3));
      const background: Promise<unknown>[] = [];
      const collect = { waitUntil: (promise: Promise<unknown>) => background.push(promise) };

      await Promise.all([
        runSessionSleepSweep(env, tick(3), collect),
        runSessionSleepSweep(env, tick(3), collect),
      ]);
      await Promise.all(background);

      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
      expect(notices).toHaveLength(1);
      expect(row()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('rolls a crashed fallback teardown forward after a restart', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      mocks.stopWorkspaceOnNode.mockRejectedValueOnce(new Error('Node Agent request timed out'));

      await sweepAt(tick(3));
      // Past the point of no return: the decision is durable, the runtime still up.
      expect(row()).toMatchObject({ sleep_status: 'stopping' });
      expect(fallbackRecord()).toMatchObject({ outcome: 'slept' });

      // A later sweep (a fresh Worker) rolls it forward from D1 state alone.
      await sweepAt(tick(4));

      expect(row()).toMatchObject({ sleep_status: 'sleeping' });
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(2);
      // The notice is written once: the roll-forward's write is the same message.
      expect(notices).toHaveLength(1);
      expect(captureCount).toBe(3);
    });
  });

  describe('shared nodes', () => {
    it('stops only the session workspace and keeps a node with another session active', async () => {
      seedSession({ id: 'a' });
      seedSession({ id: 'b' });
      // Session b is busy, so it never sleeps in this scenario.
      mocks.getSessionState.mockImplementation(
        async (_env: Env, _projectId: string, agentSessionId: string) =>
          agentSessionId === 'agent-b'
            ? { activity: 'prompting', activityAt: START.getTime() }
            : activity
      );

      for (let index = 0; index < 4; index++) await sweepAt(tick(index));

      expect(row('a')).toMatchObject({ sleep_status: 'sleeping' });
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledExactlyOnceWith(
        'node-1',
        'ws-a',
        expect.anything(),
        'user-1'
      );
      expect(workspaceStatus('b')).toBe('running');
      expect(mocks.markIdle).not.toHaveBeenCalled();
    });
  });

  describe('transcript and recovery-point failures', () => {
    it('does not release compute when the transcript refuses the notice, and stays bounded', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      mocks.persistMessage.mockRejectedValue(new Error('ProjectData storage at its limit'));

      await sweepAt(tick(3));

      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(row()).toMatchObject({
        sleep_status: 'failed',
        sleep_fallback_json: null,
        sleep_episode_failures: 4,
      });
      expect(String(row().sleep_error)).toContain('Sleep fallback notice could not be persisted');

      // Each tick retries the cheap fallback, never another capture, until the ceiling.
      for (let index = 4; index < 20; index++) await sweepAt(tick(index));
      expect(captureCount).toBe(3);
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(row()).toMatchObject({ sleep_status: 'terminal_failed', sleep_episode_failures: 9 });
      expect(fallbackRecord()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'retry_ceiling',
      });
    });

    it('refuses a recorded commit whose objects were not kept', async () => {
      seedSession({ id: 'a' });
      capture = 'wip-skipped';

      await spendFullBudget();
      await sweepAt(tick(3));

      expect(fallbackRecord()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'commit_objects_unavailable',
      });
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    });

    it('refuses a WIP bundle that is missing from R2', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      r2Objects.delete('session-snapshots/chat-a/gen-chat-a-3/wip.bundle');

      await sweepAt(tick(3));

      expect(fallbackRecord()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'commit_objects_unavailable',
      });
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    });
  });

  describe('budget boundaries', () => {
    it('is not reset by a capture generation completing mid-episode', async () => {
      seedSession({ id: 'a' });
      capture = 'unreachable';
      await sweepAt(tick(0));
      await sweepAt(tick(1));
      expect(row()).toMatchObject({ sleep_episode_failures: 2 });

      // An idle checkpoint completes through the real completion writer, which resets
      // the claim counter and re-schedules sleep. The episode must not notice.
      const db = drizzle(env.DATABASE, { schema });
      sqlite
        .prepare(
          `UPDATE session_snapshots SET capture_generation = 'checkpoint' WHERE chat_session_id = 'chat-a'`
        )
        .run();
      r2Objects.set('session-snapshots/chat-a/checkpoint/home.tar', {
        size: 4,
        sha256: HOME_SHA256,
      });
      r2Objects.set('session-snapshots/chat-a/checkpoint/wip.bundle', {
        size: 9,
        sha256: WIP_SHA256,
      });
      await completeSessionSnapshot(db, env, {
        workspaceId: 'ws-a',
        chatSessionId: 'chat-a',
        agentSessionId: 'agent-a',
        runtime: 'vm',
        baseCommit: BASE_COMMIT,
        captureGeneration: 'checkpoint',
        status: 'available',
        degradation: 'none',
        artifactSha256: { homeSha256: HOME_SHA256, wipSha256: WIP_SHA256 },
        manifest: {
          version: 1,
          chatSessionId: 'chat-a',
          workspaceId: 'ws-a',
          agentSessionId: 'agent-a',
          baseCommit: BASE_COMMIT,
          git: { branch: 'sam/feature', detached: false },
          status: 'available',
          degradation: 'none',
          skipped: [],
          artifacts: {
            home: { sizeBytes: 4, sha256: HOME_SHA256 },
            wip: { sizeBytes: 9, sha256: WIP_SHA256 },
          },
          createdAt: tick(1).toISOString(),
        },
        artifactSizes: { homeBytes: 4, wipBytes: 9 },
      });
      expect(row()).toMatchObject({
        sleep_attempts: 0,
        sleep_episode_failures: 2,
        sleep_episode_started_at: tick(0).toISOString(),
      });

      await sweepAt(tick(2));
      expect(row()).toMatchObject({ sleep_episode_failures: 3 });
      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'sleeping', snapshot_generation: 'checkpoint' });
      expect(captureCount).toBe(3);
    });

    // The retry falls due on the boundary itself, and the attempt budget is out of reach,
    // so only elapsed time decides between a second full attempt and the fallback.
    it.each([
      { name: 'a millisecond before the budget gives a full attempt', offsetMs: -1, captures: 2 },
      { name: 'exactly at the budget falls back instead', offsetMs: 0, captures: 1 },
    ])('elapsed time $name', async ({ offsetMs, captures }) => {
      const budgetMs = 12 * 60 * 1000;
      seedSession({ id: 'a' });
      capture = 'unreachable';
      env.SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS = String(budgetMs);
      env.SESSION_SLEEP_FAILURE_MAX_ATTEMPTS = '10';
      env.SESSION_SLEEP_RETRY_DELAY_MS = String(budgetMs + offsetMs);
      await sweepAt(tick(0));
      expect(captureCount).toBe(1);

      await sweepAt(new Date(tick(0).getTime() + budgetMs + offsetMs));

      expect(captureCount).toBe(captures);
      if (captures === 1) {
        // No commit was ever captured, so the fallback ends the episode blocked.
        expect(fallbackRecord()).toMatchObject({ outcome: 'blocked', trigger: 'elapsed_budget' });
      } else {
        expect(row()).toMatchObject({ sleep_status: 'failed', sleep_episode_failures: 2 });
      }
    });

    it('gives a full attempt below the attempt budget and the fallback at it', async () => {
      seedSession({ id: 'a' });
      await sweepAt(tick(0));
      await sweepAt(tick(1));
      expect(row()).toMatchObject({ sleep_episode_failures: 2 });
      expect(captureCount).toBe(2);
      await sweepAt(tick(2));
      // Third failure at 10 minutes: under the 15-minute elapsed budget, at the attempt one.
      expect(captureCount).toBe(3);
      await sweepAt(tick(3));
      expect(captureCount).toBe(3);
      expect(fallbackRecord()).toMatchObject({ outcome: 'slept', trigger: 'attempt_budget' });
    });
  });

  describe('Instant runtimes', () => {
    it('bounds the retries and ends blocked instead of tearing the container down', async () => {
      seedSession({ id: 'a', runtime: 'cf-container' });

      await spendFullBudget();
      await sweepAt(tick(3));

      expect(fallbackRecord()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'unsupported_runtime',
      });
      expect(notices[0]?.content).toContain('This Instant workspace keeps running');
      expect(mocks.sleepVmAgentContainer).not.toHaveBeenCalled();
      expect(captureCount).toBe(3);
    });
  });

  describe('explicit sleep after a blocked episode', () => {
    it('lets the user retry a full snapshot, starting a fresh episode', async () => {
      seedSession({ id: 'a' });
      capture = 'old-agent-rejected';
      await spendFullBudget();
      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'terminal_failed' });

      capture = 'complete';
      await sleepWorkspaceSession(env, {
        workspaceId: 'ws-a',
        userId: 'user-1',
        reason: 'Explicit workspace sleep API request',
      });

      expect(row()).toMatchObject({ sleep_status: 'sleeping', status: 'available' });
      expect(captureCount).toBe(4);
    });
  });

  describe('workspaces that are already gone', () => {
    it('retires a sleep intent whose workspace was deleted instead of re-deferring it forever', async () => {
      seedSession({ id: 'a' });
      await sweepAt(tick(0));
      sqlite.prepare(`UPDATE workspaces SET status = 'deleted' WHERE id = 'ws-a'`).run();
      mocks.getSessionState.mockClear();

      const retired = await sweepAt(tick(1));

      expect(retired).toMatchObject({ retired: 1, claimed: 0 });
      expect(row()).toMatchObject({ sleep_status: null, sleep_after: null });
      expect(String(row().sleep_error)).toContain('workspace is deleted');
      expect(mocks.getSessionState).not.toHaveBeenCalled();
      expect(await sweepAt(tick(2))).toMatchObject({ selected: 0 });
    });

    it('retires a stopping roll-forward whose workspace was deleted', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      mocks.stopWorkspaceOnNode.mockRejectedValueOnce(new Error('Node Agent request timed out'));
      await sweepAt(tick(3));
      expect(row()).toMatchObject({ sleep_status: 'stopping' });
      // Someone deleted the node and its workspaces before the roll-forward.
      sqlite.prepare(`UPDATE workspaces SET status = 'deleted' WHERE id = 'ws-a'`).run();

      expect(await sweepAt(tick(4))).toMatchObject({ retired: 1 });
      expect(row()).toMatchObject({ sleep_status: null });
      expect(await sweepAt(tick(5))).toMatchObject({ selected: 0 });
    });
  });

  describe('seven-day retention', () => {
    it('purges a fallback sleep exactly when its wake window ends, and keeps legacy degraded rows', async () => {
      seedSession({ id: 'a' });
      await spendFullBudget();
      await sweepAt(tick(3));
      const sleepingAt = Date.parse(String(row().sleeping_at));
      // A degraded sleep from before the fallback existed, long expired.
      seedSession({ id: 'legacy' });
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
              manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_attempts,
              sleep_episode_failures, recovery_attempts, created_at, updated_at)
           VALUES ('legacy', 'project-1', 'ws-legacy', 'user-1', 'chat-legacy', 'vm', 'degraded',
                   'transcript-only', 'legacy/manifest.json', ?, ?, 'sleeping', 1, 0, 0, ?, ?)`
        )
        .run(
          new Date(START.getTime() - DAY_MS).toISOString(),
          new Date(START.getTime() - 8 * DAY_MS).toISOString(),
          START.toISOString(),
          START.toISOString()
        );
      const purgeEnv = { ...env, SESSION_SNAPSHOT_PURGE_ENABLED: 'true' } as Env;

      const early = await runSessionSnapshotPurge(purgeEnv, new Date(sleepingAt + 7 * DAY_MS - 1));
      expect(early.deletedSnapshots).toBe(0);
      expect(row()).toMatchObject({ sleep_status: 'sleeping' });

      const due = await runSessionSnapshotPurge(purgeEnv, new Date(sleepingAt + 7 * DAY_MS + 1));
      expect(due.deletedSnapshots).toBe(1);
      expect(row()).toBeUndefined();
      expect(projectData.get('chat-a')?.status).toBe('stopped');
      expect(r2Objects.has('session-snapshots/chat-a/gen-chat-a-3/wip.bundle')).toBe(false);
      // Control: the legacy degraded row is untouched by this change.
      expect(row('legacy')).toMatchObject({ sleep_status: 'sleeping' });
    });
  });
});
