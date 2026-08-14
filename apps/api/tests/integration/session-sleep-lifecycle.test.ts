/**
 * Vertical-slice regression for terminal session sleep.
 *
 * D1 lifecycle state and the production service/scheduled-loop composition are
 * real. Only external control planes (ProjectData, VM agent, R2, and the node
 * lifecycle DO) are substituted so contract drift between queue, defer, claim,
 * final snapshot, and cleanup cannot hide behind unit mocks.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { cleanupTerminalTaskResources } from '../../src/services/task-terminal-cleanup';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(),
  getAcpSession: vi.fn(),
  getSession: vi.fn(),
  getSessionState: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  markIdle: vi.fn(),
  r2Head: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  sleepSession: vi.fn(),
  stopComputeTracking: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  transitionAcpSession: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: (...args: unknown[]) => mocks.hibernateAgentSessionOnNode(...args),
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  failSession: vi.fn(),
  getAcpSession: (...args: unknown[]) => mocks.getAcpSession(...args),
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  getSessionState: (...args: unknown[]) => mocks.getSessionState(...args),
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
  stopSession: vi.fn(),
  transitionAcpSession: (...args: unknown[]) => mocks.transitionAcpSession(...args),
}));

vi.mock('../../src/services/compute-usage', () => ({
  stopComputeTracking: (...args: unknown[]) => mocks.stopComputeTracking(...args),
}));

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

vi.mock('../../src/services/vm-agent-container', () => ({
  markVmAgentContainerActiveWorkStarted: vi.fn(),
  sleepVmAgentContainer: vi.fn(),
}));

const START = new Date('2026-08-14T05:00:00.000Z');
const RETRY_AT = new Date('2026-08-14T05:15:00.000Z');
const HOME_SHA256 = 'ab'.repeat(32);

function checksumBytes(hex: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
}

describe('terminal session sleep lifecycle integration', () => {
  let sqlite: Database.Database;
  let env: Env;
  let activity: { activity: 'prompting' | 'idle'; activityAt: number };
  let order: string[];

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
    ]);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    sqlite
      .prepare(`INSERT INTO projects (id, warm_node_timeout_ms) VALUES ('project-1', 2700000)`)
      .run();
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, runtime)
         VALUES ('node-1', 'user-1', 'running', 'workspace', 'vm')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, updated_at)
         VALUES
           ('workspace-1', 'node-1', 'project-1', 'user-1', 'chat-1', 'running', ?)`
      )
      .run(START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, workspace_id, status)
         VALUES
           ('task-1', 'project-1', 'user-1', 'workspace-1', 'completed')`
      )
      .run();
    // Task submission owns the session through the ProjectData summary. The
    // tasks.chat_session_id compatibility link is normally null on this path.
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, task_id, workspace_id,
            message_count, started_at, updated_at)
         VALUES
           ('chat-1', 'project-1', 'user-1', 'active', 'task-1', 'workspace-1',
            1, ?, ?)`
      )
      .run(START.getTime(), START.getTime());
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, status, agent_type, created_at)
         VALUES ('agent-1', 'workspace-1', 'running', 'openai-codex', ?)`
      )
      .run(START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id,
            agent_session_id, runtime, status, degradation, manifest_r2_key,
            expires_at, sleep_attempts, created_at, updated_at)
         VALUES
           ('snapshot-1', 'project-old', 'workspace-old', 'node-old', 'user-old', 'chat-1',
            'agent-old', 'cf-container', 'pending', 'none', 'old/manifest.json',
            '2026-08-21T05:00:00.000Z', 0, ?, ?)`
      )
      .run(START.toISOString(), START.toISOString());

    activity = { activity: 'prompting', activityAt: START.getTime() };
    order = [];
    mocks.getSessionState.mockImplementation(async () => activity);
    mocks.getSession.mockResolvedValue({ status: 'active' });
    mocks.sleepSession.mockResolvedValue(true);
    mocks.getAcpSession.mockResolvedValue(null);
    mocks.stopWorkspaceOnNode.mockImplementation(async () => {
      order.push('stop-workspace');
    });
    mocks.stopComputeTracking.mockImplementation(async () => {
      order.push('stop-compute-tracking');
      return 1;
    });
    mocks.cleanupTaskRun.mockImplementation(async () => {
      order.push('task-cleanup');
    });
    mocks.scheduleWorkspaceDeletion.mockImplementation(async () => {
      order.push('schedule-deletion');
    });
    mocks.markIdle.mockImplementation(async () => {
      order.push('mark-node-warm');
    });
    mocks.r2Head.mockImplementation(async (key: string) => {
      order.push(`r2-head:${key}`);
      return key.endsWith('/home.tar')
        ? { size: 4, checksums: { sha256: checksumBytes(HOME_SHA256) } }
        : { size: 128, checksums: {} };
    });
    mocks.hibernateAgentSessionOnNode.mockImplementation(async () => {
      const generation = 'generation-final';
      const prefix = `session-snapshots/chat-1/${generation}`;
      sqlite
        .prepare(
          `UPDATE session_snapshots
           SET status = 'available', degradation = 'none',
               snapshot_generation = ?, capture_generation = NULL,
               home_r2_key = ?, home_sha256 = ?, manifest_r2_key = ?,
               manifest_json = ?
           WHERE chat_session_id = 'chat-1'`
        )
        .run(
          generation,
          `${prefix}/home.tar`,
          HOME_SHA256,
          `${prefix}/manifest.json`,
          JSON.stringify({ artifacts: { home: { sizeBytes: 4 } } })
        );
      order.push('final-snapshot');
      return { status: 'pending', accepted: true };
    });

    env = {
      DATABASE: createSqliteD1(sqlite),
      R2: { head: mocks.r2Head },
      SESSION_SLEEP_AFTER_MS: '900000',
      SESSION_SLEEP_RETRY_DELAY_MS: '60000',
      SESSION_SLEEP_MAX_ATTEMPTS: '3',
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

  it('persists terminal intent, defers prompting without an attempt, then sleeps on idle', async () => {
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });

    expect(
      sqlite
        .prepare(
          `SELECT status, project_id, workspace_id, node_id, user_id, agent_session_id, runtime,
                  sleep_status, sleep_after, sleep_attempts
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      status: 'pending',
      project_id: 'project-1',
      workspace_id: 'workspace-1',
      node_id: 'node-1',
      user_id: 'user-1',
      agent_session_id: 'agent-1',
      runtime: 'vm',
      sleep_status: 'scheduled',
      sleep_after: START.toISOString(),
      sleep_attempts: 0,
    });
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();

    // Model a crashed sweep owner. The prompting eligibility result must
    // release exactly this stale claim instead of leaving it hot-selected.
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_after = NULL,
             sleep_claim_id = 'stale-owner', sleep_claimed_at = '2026-08-14T04:00:00.000Z'
         WHERE chat_session_id = 'chat-1'`
      )
      .run();

    const promptingSweep = await runSessionSleepSweep(env, START);
    expect(promptingSweep).toMatchObject({ selected: 1, deferred: 1, claimed: 0, slept: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleep_after, sleep_attempts, sleep_claim_id, sleep_claimed_at
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'scheduled',
      sleep_after: RETRY_AT.toISOString(),
      sleep_attempts: 0,
      sleep_claim_id: null,
      sleep_claimed_at: null,
    });

    activity = { activity: 'idle', activityAt: START.getTime() + 30_000 };
    vi.setSystemTime(RETRY_AT);
    sqlite
      .prepare(`UPDATE nodes SET last_heartbeat_at = ? WHERE id = 'node-1'`)
      .run(RETRY_AT.toISOString());
    const idleSweep = await runSessionSleepSweep(env, RETRY_AT);

    expect(idleSweep).toMatchObject({ selected: 1, deferred: 0, claimed: 1, slept: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT status, sleep_status, sleeping_at, sleep_attempts, sleep_after,
                  sleep_claim_id, sleep_claimed_at
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      status: 'available',
      sleep_status: 'sleeping',
      sleeping_at: RETRY_AT.toISOString(),
      sleep_attempts: 1,
      sleep_after: null,
      sleep_claim_id: null,
      sleep_claimed_at: null,
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(sqlite.prepare(`SELECT status FROM agent_sessions WHERE id = 'agent-1'`).get()).toEqual({
      status: 'sleeping',
    });

    expect(order.indexOf('final-snapshot')).toBeLessThan(
      order.findIndex((event) => event.startsWith('r2-head:'))
    );
    expect(order.findIndex((event) => event.startsWith('r2-head:'))).toBeLessThan(
      order.indexOf('stop-workspace')
    );
    expect(order.indexOf('stop-workspace')).toBeLessThan(order.indexOf('schedule-deletion'));
    expect(order.indexOf('schedule-deletion')).toBeLessThan(order.indexOf('task-cleanup'));
    expect(order.indexOf('task-cleanup')).toBeLessThan(order.indexOf('mark-node-warm'));
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env, 2_700_000);
    expect(mocks.markIdle).toHaveBeenCalledWith('node-1', 'user-1', 2_700_000);
  });
});
