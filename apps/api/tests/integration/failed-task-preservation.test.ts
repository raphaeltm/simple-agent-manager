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
  failedTaskWorkLossMessage,
} from '../../src/services/failed-task-preservation';
import { claimSessionSnapshotRecovery } from '../../src/services/session-snapshots';
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

function checksumBytes(hex: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
}

describe('failed-task work preservation vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let order: string[];
  let projectDataStatus: string;
  let capture: 'complete' | 'transcript-only';

  function seedFailedTask(runtime: 'vm' | 'cf-container', taskStatus = 'failed') {
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
      .run(taskStatus, START.toISOString(), START.toISOString());
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
      failedTaskIncompleteSnapshotMessage('transcript-only'),
      null
    );
    expect(mocks.failSession).not.toHaveBeenCalled();
  });

  it('tears the runtime down and says so once preservation exhausts its retries', async () => {
    seedFailedTask('vm');
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
    expect(snapshotRow()).toMatchObject({ sleep_status: 'failed', sleep_after: null });
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskWorkLossMessage('snapshot_retry_exhausted'),
      null
    );
    expect(mocks.failSession).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'Agent prompt failed'
    );
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
    expect(order.slice(-3)).toEqual(['system-notice', 'project-data-fail', 'task-cleanup']);
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
