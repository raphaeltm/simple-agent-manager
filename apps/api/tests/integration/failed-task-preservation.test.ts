/**
 * Vertical slice for failed-task work preservation (idea 01M1XGHX7NQZQYWQRV5C1PJ60N,
 * policy a3780107): a task that FAILS while its workspace holds unpushed work must
 * end with a verified snapshot and a conversation the resumer will wake.
 *
 * Real: D1 lifecycle state (SQLite), `cleanupTerminalTaskResources` (the choke
 * point the VM-agent failure callback and the status route call), the preservation
 * decision, the scheduled session-sleep sweep, `sleepWorkspaceSession`, snapshot
 * lifecycle writes, and the resumer's own claim gate. Substituted: ProjectData, the
 * VM agent, R2 and the NodeLifecycle DO — the external control planes.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import {
  failedTaskIncompleteSnapshotMessage,
  failedTaskNoticeId,
  failedTaskWorkLossMessage,
} from '../../src/services/failed-task-preservation';
import {
  claimSessionSnapshotRecovery,
  markSessionSnapshotAwakeInPlace,
} from '../../src/services/session-snapshots';
import { cleanupTerminalTaskResources } from '../../src/services/task-terminal-cleanup';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(),
  failSession: vi.fn(),
  stopSession: vi.fn(),
  persistMessage: vi.fn(),
  getAcpSession: vi.fn(),
  getSession: vi.fn(),
  getSessionState: vi.fn(),
  sleepSession: vi.fn(),
  transitionAcpSession: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  sleepVmAgentContainer: vi.fn(),
  markIdle: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  r2Head: vi.fn(),
  r2Delete: vi.fn(),
  stopComputeTracking: vi.fn(),
  cancelVmTaskAdmission: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: (...args: unknown[]) => mocks.hibernateAgentSessionOnNode(...args),
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  failSession: (...args: unknown[]) => mocks.failSession(...args),
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  persistMessage: (...args: unknown[]) => mocks.persistMessage(...args),
  getAcpSession: (...args: unknown[]) => mocks.getAcpSession(...args),
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  getSessionState: (...args: unknown[]) => mocks.getSessionState(...args),
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
  transitionAcpSession: (...args: unknown[]) => mocks.transitionAcpSession(...args),
}));

vi.mock('../../src/services/compute-usage', () => ({
  stopComputeTracking: (...args: unknown[]) => mocks.stopComputeTracking(...args),
}));

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

vi.mock('../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: (...args: unknown[]) => mocks.cancelVmTaskAdmission(...args),
}));

vi.mock('../../src/services/vm-agent-container', () => ({
  markVmAgentContainerActiveWorkStarted: vi.fn(),
  sleepVmAgentContainer: (...args: unknown[]) => mocks.sleepVmAgentContainer(...args),
}));

const START = new Date('2026-09-25T09:00:00.000Z');
const HOME_SHA256 = 'cd'.repeat(32);
const WIP_SHA256 = 'ef'.repeat(32);
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORK_LOSS_NOTICE_ID = failedTaskNoticeId('work-loss', 'task-1', 'chat-1');
const HOUR = 60 * 60 * 1000;

function checksumBytes(hex: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
}

describe('failed-task work preservation vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let order: string[];
  let projectDataStatus: string;
  let capture: 'complete' | 'transcript-only';

  function seedFailedTask(
    runtime: 'vm' | 'cf-container',
    taskStatus = 'failed',
    failedAt = START.toISOString()
  ) {
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, runtime)
         VALUES ('node-1', 'user-1', 'running', 'workspace', ?)`
      )
      .run(runtime);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status, updated_at)
         VALUES ('workspace-1', 'node-1', 'project-1', 'user-1', 'chat-1', 'running', ?)`
      )
      .run(START.toISOString());
    // The row as the VM-agent failure callback leaves it: terminal before cleanup runs.
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, workspace_id, chat_session_id, status, error_message,
            completed_at, updated_at)
         VALUES ('task-1', 'project-1', 'user-1', 'workspace-1', 'chat-1', ?, 'Agent prompt failed', ?, ?)`
      )
      .run(taskStatus, failedAt, failedAt);
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, task_id, workspace_id, message_count, started_at, updated_at)
         VALUES ('chat-1', 'project-1', 'user-1', 'active', 'task-1', 'workspace-1', 4, ?, ?)`
      )
      .run(START.getTime(), START.getTime());
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, status, agent_type, created_at)
         VALUES ('agent-1', 'workspace-1', 'running', 'claude-code', ?)`
      )
      .run(START.toISOString());
  }

  function snapshotRow() {
    return sqlite
      .prepare(
        `SELECT status, degradation, sleep_status, sleep_after, sleeping_at, expires_at,
                wip_r2_key, home_r2_key
         FROM session_snapshots WHERE chat_session_id = 'chat-1'`
      )
      .get() as Record<string, unknown> | undefined;
  }

  /** Run `concurrent` (once) just before the next statement matching `pattern` is prepared. */
  function interleaveBefore(pattern: RegExp, concurrent: () => void) {
    const base = env.DATABASE;
    const state = { fired: false };
    env = {
      ...env,
      DATABASE: {
        ...base,
        prepare: (query: string) => {
          if (!state.fired && pattern.test(query)) {
            state.fired = true;
            concurrent();
          }
          return base.prepare(query);
        },
      } as unknown as D1Database,
    } as Env;
    return state;
  }

  const EXHAUSTION_WRITE =
    /^update "session_snapshots" set "sleep_status" = \?, "sleep_after" = \?, "sleep_error"/i;

  function statusOf(table: 'workspaces' | 'agent_sessions' | 'nodes', id: string) {
    return (
      sqlite.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }
    ).status;
  }

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
      schema.projectDataSessionLocations,
    ]);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    sqlite
      .prepare(`INSERT INTO projects (id, warm_node_timeout_ms) VALUES ('project-1', 2700000)`)
      .run();

    order = [];
    projectDataStatus = 'active';
    capture = 'complete';
    mocks.stopComputeTracking.mockResolvedValue(1);
    mocks.cancelVmTaskAdmission.mockResolvedValue(undefined);
    mocks.getSessionState.mockResolvedValue({ activity: 'idle', activityAt: START.getTime() });
    mocks.getSession.mockImplementation(async () => ({ status: projectDataStatus }));
    // ProjectData's own transition rules: sleep only from active, fail from active|sleeping.
    mocks.sleepSession.mockImplementation(async () => {
      order.push('project-data-sleep');
      if (projectDataStatus !== 'active') return false;
      projectDataStatus = 'sleeping';
      return true;
    });
    mocks.failSession.mockImplementation(async () => {
      order.push('project-data-fail');
      projectDataStatus = 'failed';
    });
    mocks.persistMessage.mockImplementation(async () => {
      order.push('system-notice');
      return 'notice-1';
    });
    mocks.getAcpSession.mockResolvedValue(null);
    mocks.cleanupTaskRun.mockImplementation(async () => {
      order.push('task-cleanup');
    });
    mocks.stopWorkspaceOnNode.mockImplementation(async () => {
      order.push('stop-workspace');
    });
    mocks.sleepVmAgentContainer.mockImplementation(async () => {
      order.push('sleep-container');
    });
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.markIdle.mockResolvedValue(undefined);
    mocks.r2Head.mockImplementation(async (key: string) =>
      key.endsWith('/home.tar')
        ? { size: 4, checksums: { sha256: checksumBytes(HOME_SHA256) } }
        : key.endsWith('/wip.bundle')
          ? { size: 9, checksums: { sha256: checksumBytes(WIP_SHA256) } }
          : { size: 128, checksums: {} }
    );
    // The VM agent capturing the failed task's dirty workspace: the uncommitted
    // change lands in the WIP artifact. A stalled capture completes transcript-only.
    mocks.hibernateAgentSessionOnNode.mockImplementation(async () => {
      const generation = 'generation-final';
      const prefix = `session-snapshots/chat-1/${generation}`;
      if (capture === 'transcript-only') {
        sqlite
          .prepare(
            `UPDATE session_snapshots
             SET status = 'degraded', degradation = 'transcript-only',
                 snapshot_generation = ?, capture_generation = NULL,
                 manifest_r2_key = ?, manifest_json = ?
             WHERE chat_session_id = 'chat-1'`
          )
          .run(
            generation,
            `${prefix}/manifest.json`,
            JSON.stringify({
              version: 1,
              chatSessionId: 'chat-1',
              workspaceId: 'workspace-1',
              status: 'degraded',
              degradation: 'transcript-only',
              artifacts: {},
            })
          );
      } else {
        sqlite
          .prepare(
            `UPDATE session_snapshots
             SET status = 'available', degradation = 'none',
                 snapshot_generation = ?, capture_generation = NULL,
                 home_r2_key = ?, home_sha256 = ?, wip_r2_key = ?, wip_sha256 = ?,
                 manifest_r2_key = ?, manifest_json = ?
             WHERE chat_session_id = 'chat-1'`
          )
          .run(
            generation,
            `${prefix}/home.tar`,
            HOME_SHA256,
            `${prefix}/wip.bundle`,
            WIP_SHA256,
            `${prefix}/manifest.json`,
            JSON.stringify({
              artifacts: { home: { sizeBytes: 4 }, wip: { sizeBytes: 9, sha256: WIP_SHA256 } },
            })
          );
      }
      order.push('final-snapshot');
      return { status: 'pending', accepted: true };
    });

    env = {
      DATABASE: createSqliteD1(sqlite),
      R2: { head: mocks.r2Head, delete: mocks.r2Delete },
      SESSION_SLEEP_AFTER_MS: '900000',
      SESSION_SLEEP_RETRY_DELAY_MS: '60000',
      SESSION_SLEEP_MAX_ATTEMPTS: '2',
      SESSION_SLEEP_SWEEP_BATCH_SIZE: '5',
      SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
      SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '1000',
      NODE_LIFECYCLE: {
        idFromName: vi.fn(() => 'node-do-id'),
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

  it('ends a failed VM task with a verified snapshot and a conversation the resumer will wake', async () => {
    seedFailedTask('vm');

    await cleanupTerminalTaskResources(env, 'task-1', {
      status: 'failed',
      logContext: { source: 'task.callback' },
    });

    // Nothing destroyed at failure time: a snapshot-backed sleep is queued instead.
    expect(snapshotRow()).toMatchObject({
      status: 'pending',
      sleep_status: 'scheduled',
      sleep_after: START.toISOString(),
    });
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();

    const sweep = await runSessionSleepSweep(env, START);

    expect(sweep).toMatchObject({ selected: 1, claimed: 1, slept: 1, failed: 0 });
    expect(snapshotRow()).toMatchObject({
      status: 'available',
      degradation: 'none',
      sleep_status: 'sleeping',
      sleeping_at: START.toISOString(),
      // Failed-task snapshots use the standard retention, nothing new.
      expires_at: new Date(START.getTime() + SNAPSHOT_TTL_MS).toISOString(),
      wip_r2_key: 'session-snapshots/chat-1/generation-final/wip.bundle',
    });
    expect(statusOf('workspaces', 'workspace-1')).toBe('sleeping');
    expect(statusOf('agent_sessions', 'agent-1')).toBe('sleeping');
    expect(projectDataStatus).toBe('sleeping');
    // The runtime is only stopped after the snapshot holding the work is verified.
    expect(order.indexOf('final-snapshot')).toBeLessThan(order.indexOf('project-data-sleep'));
    expect(order.indexOf('project-data-sleep')).toBeLessThan(order.indexOf('stop-workspace'));
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.persistMessage).not.toHaveBeenCalled();

    // Wakeable: the resumer's authorizing claim accepts it.
    const claim = await claimSessionSnapshotRecovery(drizzle(env.DATABASE, { schema }), env, {
      chatSessionId: 'chat-1',
      userId: 'user-1',
      taskId: 'recovery-task-1',
    });
    expect(claim).toEqual({ status: 'claimed', taskId: 'recovery-task-1' });
  });

  it('sleeps a failed Instant (cf-container) task through the container sleep path', async () => {
    seedFailedTask('cf-container');

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const sweep = await runSessionSleepSweep(env, START);

    expect(sweep).toMatchObject({ claimed: 1, slept: 1 });
    expect(mocks.sleepVmAgentContainer).toHaveBeenCalledWith(env, 'node-1');
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(statusOf('nodes', 'node-1')).toBe('sleeping');
    expect(snapshotRow()).toMatchObject({ status: 'available', sleep_status: 'sleeping' });
    expect(projectDataStatus).toBe('sleeping');
    expect(mocks.failSession).not.toHaveBeenCalled();
  });

  it('surfaces an incomplete snapshot instead of implying the work was saved', async () => {
    seedFailedTask('vm');
    capture = 'transcript-only';

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const sweep = await runSessionSleepSweep(env, START);

    expect(sweep).toMatchObject({ slept: 1 });
    expect(snapshotRow()).toMatchObject({
      status: 'degraded',
      degradation: 'transcript-only',
      sleep_status: 'sleeping',
    });
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskIncompleteSnapshotMessage('transcript-only', 'vm'),
      null,
      failedTaskNoticeId('snapshot-incomplete', 'task-1', 'chat-1')
    );
    expect(mocks.failSession).not.toHaveBeenCalled();
  });

  it.each(['vm', 'cf-container'] as const)(
    'tears the %s runtime down and says so once preservation exhausts its retries',
    async (runtime) => {
      seedFailedTask(runtime);
      mocks.hibernateAgentSessionOnNode.mockRejectedValue(new Error('VM agent unreachable'));

      await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
      const first = await runSessionSleepSweep(env, START);
      expect(first).toMatchObject({ claimed: 1, failed: 1 });
      // One attempt left: the failed task's runtime must still be preserved.
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
      expect(mocks.failSession).not.toHaveBeenCalled();

      const retryAt = new Date(START.getTime() + 60_000);
      vi.setSystemTime(retryAt);
      const second = await runSessionSleepSweep(env, retryAt);

      expect(second).toMatchObject({ claimed: 1, failed: 1 });
      // The release ends the episode, so no later sweep retries it.
      expect(snapshotRow()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });
      expect(mocks.persistMessage).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'system',
        failedTaskWorkLossMessage('snapshot_retry_exhausted'),
        null,
        WORK_LOSS_NOTICE_ID
      );
      expect(mocks.failSession).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'Agent prompt failed'
      );
      expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
      expect(order.slice(-3)).toEqual(['system-notice', 'project-data-fail', 'task-cleanup']);
    }
  );

  it('gives a failure a real sleep attempt even after an earlier sleep spent its budget', async () => {
    // An earlier idle sleep of this still-running workspace exhausted its retries.
    // The failure must start its own episode; otherwise the sweep releases it on
    // sight and tears the runtime down without a single capture attempt.
    seedFailedTask('vm');
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, user_id, chat_session_id, agent_session_id, runtime,
            status, degradation, manifest_r2_key, expires_at, sleep_status, sleep_after,
            sleep_attempts, recovery_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'user-1', 'chat-1', 'agent-1', 'vm',
                 'pending', 'none', 'session-snapshots/chat-1/old/manifest.json', ?, 'failed',
                 NULL, 2, 0, ?, ?)`
      )
      .run(
        new Date(START.getTime() + SNAPSHOT_TTL_MS).toISOString(),
        START.toISOString(),
        START.toISOString()
      );

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const sweep = await runSessionSleepSweep(env, START);

    expect(sweep).toMatchObject({ claimed: 1, slept: 1, exhausted: 0 });
    expect(order).toContain('final-snapshot');
    expect(snapshotRow()).toMatchObject({ status: 'available', sleep_status: 'sleeping' });
    // No release: nothing says the work was lost, and the session slept, not failed.
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(projectDataStatus).toBe('sleeping');
  });

  it('releases a queued preservation whose agent session errors before the sweep claims it', async () => {
    // A prompt timeout or unrecoverable crash: the VM agent posts the failure
    // callback and reports `error` activity back to back, and the error can land
    // second. The sleep path needs a resumable agent session, so the sweep would
    // otherwise defer this row forever.
    seedFailedTask('vm');
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    expect(snapshotRow()).toMatchObject({ sleep_status: 'scheduled' });
    // The `error` activity fanout as production applies it
    // (`applyErrorFailureFanout`): agent session errored, ACP session failed, and
    // the chat session failed with it.
    sqlite.prepare(`UPDATE agent_sessions SET status = 'error' WHERE id = 'agent-1'`).run();
    projectDataStatus = 'failed';
    mocks.getSessionState.mockResolvedValue(null);
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskWorkLossMessage('no_resumable_agent_session'),
      null,
      WORK_LOSS_NOTICE_ID
    );
    expect(order.slice(-3)).toEqual(['system-notice', 'project-data-fail', 'task-cleanup']);
    expect(snapshotRow()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });

    // Bounded: the next sweep no longer selects it.
    const next = await runSessionSleepSweep(env, new Date(START.getTime() + 10 * 60_000));
    expect(next).toMatchObject({ selected: 0 });
  });

  it('releases through the selection-time budget check, off the sweep critical path', async () => {
    // Two claims crashed mid-sleep without recording a failure: the stale claim is
    // re-selected with no attempt left, and the budget check itself gives up.
    seedFailedTask('vm');
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_attempts = 2, sleep_claim_id = 'crashed-claim',
             sleep_claimed_at = ?
         WHERE chat_session_id = 'chat-1'`
      )
      .run(new Date(START.getTime() - 24 * 60 * 60 * 1000).toISOString());
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });

    expect(sweep).toMatchObject({ claimed: 0, exhausted: 1 });
    // The teardown is handed to waitUntil, not awaited inside the sweep.
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskWorkLossMessage('snapshot_retry_exhausted'),
      null,
      WORK_LOSS_NOTICE_ID
    );
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
    expect(snapshotRow()).toMatchObject({ sleep_status: 'terminal_failed' });
  });

  it('does not exhaust a sleep episode a fresh failure restarted after selection', async () => {
    // The sweep selected a spent row; before its exhaustion write lands, a replayed
    // failure callback starts a fresh episode. The write is a compare-and-set on
    // the attempts it selected, so the new episode survives and nothing is released.
    seedFailedTask('vm');
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_attempts = 2, sleep_claim_id = 'crashed-claim',
             sleep_claimed_at = ?
         WHERE chat_session_id = 'chat-1'`
      )
      .run(new Date(START.getTime() - 24 * 60 * 60 * 1000).toISOString());
    const interleave = interleaveBefore(EXHAUSTION_WRITE, () => {
      sqlite
        .prepare(
          `UPDATE session_snapshots
           SET sleep_status = 'scheduled', sleep_after = ?, sleep_attempts = 0,
               sleep_claim_id = NULL, sleep_claimed_at = NULL
           WHERE chat_session_id = 'chat-1'`
        )
        .run(START.toISOString());
    });
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(interleave.fired).toBe(true);
    expect(sweep).toMatchObject({ exhausted: 0 });
    expect(background).toHaveLength(0);
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    expect(snapshotRow()).toMatchObject({
      sleep_status: 'scheduled',
      sleep_after: START.toISOString(),
    });
  });

  it('does not exhaust a stale claim whose owner moved it on after selection', async () => {
    // The sweep re-selects a stale `preparing` claim at the attempt limit; before
    // its exhaustion write lands, the slow owner passes its point of no return.
    // Overwriting `stopping` with `failed` would strand a stopped runtime.
    seedFailedTask('vm');
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_attempts = 2, sleep_claim_id = 'slow-claim',
             sleep_claimed_at = ?
         WHERE chat_session_id = 'chat-1'`
      )
      .run(new Date(START.getTime() - 24 * HOUR).toISOString());
    const interleave = interleaveBefore(EXHAUSTION_WRITE, () => {
      sqlite
        .prepare(
          `UPDATE session_snapshots SET sleep_status = 'stopping', sleep_stopping_since = ?
           WHERE chat_session_id = 'chat-1'`
        )
        .run(START.toISOString());
    });
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(interleave.fired).toBe(true);
    expect(sweep).toMatchObject({ exhausted: 0 });
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    expect(snapshotRow()).toMatchObject({ sleep_status: 'stopping' });
  });

  it.each([
    // The woken agent has not reported yet: only the wake itself dates the episode.
    ['before its agent has reported', () => null],
    [
      'while its agent works on the follow-up',
      (wokeAt: number) => ({
        activity: 'prompting',
        activityAt: wokeAt + 60_000,
        promptStartedAt: wokeAt,
      }),
    ],
  ])('keeps a woken Instant conversation %s, however old the failure', async (_label, state) => {
    // An Instant conversation wakes in place under the same failed task
    // (`commitContainerWake`), and the sweep re-queues its sleep straight away.
    // Measured from the failure, the maximum wait would tear the woken
    // conversation down.
    seedFailedTask('cf-container', 'failed', new Date(START.getTime() - 9 * HOUR).toISOString());
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    expect(await runSessionSleepSweep(env, START)).toMatchObject({ slept: 1 });
    mocks.persistMessage.mockClear();
    mocks.cleanupTaskRun.mockClear();

    const wokeAt = new Date(START.getTime() + HOUR);
    vi.setSystemTime(wokeAt);
    await markSessionSnapshotAwakeInPlace(env, 'chat-1', 'task-1', 'workspace-1');
    // What the resumed container and ProjectData's wakeSession record.
    sqlite.prepare(`UPDATE nodes SET status = 'running' WHERE id = 'node-1'`).run();
    sqlite.prepare(`UPDATE workspaces SET status = 'running' WHERE id = 'workspace-1'`).run();
    sqlite.prepare(`UPDATE agent_sessions SET status = 'running' WHERE id = 'agent-1'`).run();
    projectDataStatus = 'active';
    mocks.getSessionState.mockResolvedValue(state(wokeAt.getTime()));
    const later = new Date(wokeAt.getTime() + 5 * 60_000);
    vi.setSystemTime(later);
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, later, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(sweep).toMatchObject({ reconciled: 1, claimed: 0, deferred: 1 });
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    expect(snapshotRow()).toMatchObject({ sleep_status: 'scheduled', sleeping_at: null });
  });

  it('restarts the maximum wait for each turn on a live failed conversation', async () => {
    // Never slept: the user kept the failed conversation busy for hours. Each new
    // turn is fresh work, not a hung one.
    seedFailedTask('vm', 'failed', new Date(START.getTime() - 9 * HOUR).toISOString());
    mocks.getSessionState.mockResolvedValue({
      activity: 'prompting',
      activityAt: START.getTime() - 30_000,
      promptStartedAt: START.getTime() - 10 * 60_000,
    });
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    expect(snapshotRow()).toMatchObject({ sleep_status: 'scheduled' });
  });

  it('still reaches the maximum wait when the sweep keeps failing to check eligibility', async () => {
    // Rule 47: a candidate that throws every sweep is deferred without spending an
    // attempt, so the catch branch needs the same escape as any other deferral.
    env.FAILED_TASK_PRESERVATION_MAX_WAIT_MS = String(HOUR);
    seedFailedTask('vm', 'failed', new Date(START.getTime() - 61 * 60_000).toISOString());
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const base = env.DATABASE;
    env = {
      ...env,
      DATABASE: {
        ...base,
        prepare: (query: string) => {
          if (/from "workspaces" left join "session_summaries"/i.test(query)) {
            throw new Error('D1_ERROR: overloaded');
          }
          return base.prepare(query);
        },
      } as unknown as D1Database,
    } as Env;
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(sweep).toMatchObject({ claimed: 0, failed: 1 });
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskWorkLossMessage('preservation_timed_out'),
      null,
      WORK_LOSS_NOTICE_ID
    );
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
    expect(snapshotRow()).toMatchObject({ sleep_status: 'terminal_failed' });
  });

  it('defers a failed task whose agent is still working, without spending its attempts', async () => {
    // The agent kept working after the failure. Sleeping it mid-turn would abort on
    // the next activity change (`sleepWorkspaceSession`) and burn the retry budget,
    // leaving an unwakeable capture: the drain follows activity, as for completed.
    seedFailedTask('vm', 'failed', new Date(START.getTime() - 20 * 60_000).toISOString());
    mocks.getSessionState.mockResolvedValue({
      activity: 'prompting',
      activityAt: START.getTime() - 60_000,
    });

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const sweep = await runSessionSleepSweep(env, START);

    expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    // Re-armed for the end of the drain the working agent holds open.
    const drainEnd = new Date(START.getTime() - 60_000 + 900_000);
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleep_after, sleep_attempts FROM session_snapshots
           WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'scheduled',
      sleep_after: drainEnd.toISOString(),
      sleep_attempts: 0,
    });

    // Once the turn ends, the sweep that comes due keeps the work.
    mocks.getSessionState.mockResolvedValue({ activity: 'idle', activityAt: START.getTime() });
    vi.setSystemTime(drainEnd);
    const next = await runSessionSleepSweep(env, drainEnd);
    expect(next).toMatchObject({ claimed: 1, slept: 1 });
    expect(snapshotRow()).toMatchObject({ status: 'available', sleep_status: 'sleeping' });
  });

  it('releases a preservation still waiting on a turn after the maximum wait', async () => {
    // Rule 47: a turn that never ends defers without spending an attempt, so only
    // the maximum wait bounds it. Driven through the real sweep's deferral branch.
    env.FAILED_TASK_PRESERVATION_MAX_WAIT_MS = String(60 * 60_000);
    seedFailedTask('vm', 'failed', new Date(START.getTime() - 61 * 60_000).toISOString());
    // One turn, hung since before the failure, re-reporting every minute.
    mocks.getSessionState.mockResolvedValue({
      activity: 'prompting',
      activityAt: START.getTime() - 60_000,
      promptStartedAt: START.getTime() - 2 * HOUR,
    });
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'failed' });
    const background: Promise<unknown>[] = [];

    const sweep = await runSessionSleepSweep(env, START, {
      waitUntil: (promise) => background.push(promise),
    });
    await Promise.all(background);

    expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskWorkLossMessage('preservation_timed_out'),
      null,
      WORK_LOSS_NOTICE_ID
    );
    expect(order.slice(-3)).toEqual(['system-notice', 'project-data-fail', 'task-cleanup']);
    expect(snapshotRow()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });
    const next = await runSessionSleepSweep(env, new Date(START.getTime() + 10 * 60_000));
    expect(next).toMatchObject({ selected: 0 });
  });

  it('keeps a completed task with a still-reporting prompt draining (control)', async () => {
    seedFailedTask('vm', 'completed', new Date(START.getTime() - 20 * 60_000).toISOString());
    mocks.getSessionState.mockResolvedValue({
      activity: 'prompting',
      activityAt: START.getTime() - 60_000,
    });

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });
    const sweep = await runSessionSleepSweep(env, START);

    expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
  });

  it('leaves an exhausted completed-task sleep to its pre-existing handling', async () => {
    // Control: the exhaustion release is scoped to failed tasks only.
    seedFailedTask('vm', 'completed');
    mocks.hibernateAgentSessionOnNode.mockRejectedValue(new Error('VM agent unreachable'));

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });
    await runSessionSleepSweep(env, START);
    const retryAt = new Date(START.getTime() + 60_000);
    vi.setSystemTime(retryAt);
    await runSessionSleepSweep(env, retryAt);

    expect(snapshotRow()).toMatchObject({ sleep_status: 'failed', sleep_after: null });
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
  });

  it('keeps Archive of a failed task destructive: no sleep, immediate teardown', async () => {
    // Control (policy e8897480): explicit archive / Complete & Delete.
    seedFailedTask('vm');

    await cleanupTerminalTaskResources(env, 'task-1', {
      status: 'failed',
      destructiveSessionEnd: true,
    });

    expect(snapshotRow()).toBeUndefined();
    expect(mocks.failSession).toHaveBeenCalledOnce();
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env, undefined, undefined);
    expect(order).toEqual(['project-data-fail', 'task-cleanup']);
  });
});
