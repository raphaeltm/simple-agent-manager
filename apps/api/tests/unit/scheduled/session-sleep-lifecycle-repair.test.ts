import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runSessionSleepLifecycleRepair } from '../../../src/scheduled/session-sleep-lifecycle-repair';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(async () => {}),
  getSession: vi.fn(async () => ({ status: 'active' })),
  markIdle: vi.fn(async () => {}),
  sleepSession: vi.fn(async () => true),
}));

vi.mock('../../../src/services/project-data', () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
}));

vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

describe('session sleep lifecycle repair', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.projects,
      schema.nodes,
      schema.workspaces,
      schema.tasks,
      schema.agentSessions,
      schema.computeUsage,
      schema.sessionSummaries,
      schema.sessionSnapshots,
    ]);
    env = {
      DATABASE: createSqliteD1(sqlite),
      SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS: '1800000',
      NODE_LIFECYCLE: {
        idFromName: (id: string) => id,
        get: () => ({ markIdle: mocks.markIdle }),
      },
      TASK_RUN_CLEANUP_DELAY_MS: '0',
    } as unknown as Env;

    sqlite
      .prepare(
        `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project-1', 'p', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, status, node_role, runtime, created_at, updated_at)
         VALUES ('node-1', 'user-1', 'stopped', 'workspace', 'vm', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, created_at, updated_at)
         VALUES ('workspace-1', 'node-1', 'project-1', 'user-1', 'chat-1', 'running', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, task_id, workspace_id, status, created_at, updated_at)
         VALUES ('chat-1', 'project-1', 'user-1', 'task-1', 'workspace-1', 'active', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, workspace_id, chat_session_id, title, status, priority, task_mode, created_by, created_at, updated_at)
         VALUES ('task-1', 'project-1', 'user-1', 'workspace-1', 'chat-1', 'task', 'in_progress', 0, 'conversation', 'user-1', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO agent_sessions
           (id, workspace_id, user_id, status, created_at, updated_at)
         VALUES ('agent-1', 'workspace-1', 'user-1', 'running', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO compute_usage
           (id, user_id, workspace_id, node_id, server_type, vcpu_count, credential_source,
            started_at, created_at)
         VALUES ('usage-1', 'user-1', 'workspace-1', 'node-1', 'medium', 4, 'platform', ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
  });

  afterEach(() => sqlite.close());

  it('completes a stale post-capture stopping row without replaying workspace sleep', async () => {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'dead-owner',
            '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({ selected: 1, repaired: 1, skipped: 0, errors: 0 });
    expect(mocks.sleepSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleeping_at, sleep_claim_id, sleep_claimed_at
             FROM session_snapshots WHERE id = 'snapshot-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'sleeping',
      sleeping_at: '2026-08-12T01:00:00.000Z',
      sleep_claim_id: null,
      sleep_claimed_at: null,
    });
    expect(
      sqlite.prepare(`SELECT ended_at FROM compute_usage WHERE id = 'usage-1'`).pluck().get()
    ).toEqual(expect.any(String));
  });

  it('repairs a stopping row from its stable stopping age even when the claim was refreshed recently', async () => {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_stopping_since, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'reclaimed-owner',
            '2026-08-12T00:55:00.000Z', '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:55:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({ selected: 1, repaired: 1, skipped: 0, errors: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleeping_at, sleep_claim_id, sleep_claimed_at, sleep_stopping_since
             FROM session_snapshots WHERE id = 'snapshot-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'sleeping',
      sleeping_at: '2026-08-12T01:00:00.000Z',
      sleep_claim_id: null,
      sleep_claimed_at: null,
      sleep_stopping_since: '2026-08-12T00:00:00.000Z',
    });
  });

  it('does not repair a stopping row before the stable stopping age exceeds the in-flight ceiling', async () => {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_stopping_since, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'owner',
            '2026-08-12T00:59:00.000Z', '2026-08-12T00:45:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:59:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({ selected: 0, repaired: 0, skipped: 0, errors: 0 });
    expect(mocks.sleepSession).not.toHaveBeenCalled();
    expect(
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).pluck().get()
    ).toBe('running');
  });

  it('keeps a stale post-capture row retryable when ProjectData sleep fails', async () => {
    mocks.sleepSession.mockResolvedValueOnce(false);
    mocks.getSession.mockResolvedValueOnce({ status: 'active' });
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'dead-owner',
            '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({
      selected: 1,
      repaired: 0,
      skipped: 0,
      projectDataErrors: 1,
      errors: 0,
    });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleeping_at, sleep_claim_id, sleep_claimed_at
             FROM session_snapshots WHERE id = 'snapshot-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'stopping',
      sleeping_at: null,
      sleep_claim_id: 'dead-owner',
      sleep_claimed_at: '2026-08-12T00:00:00.000Z',
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'running',
    });
    expect(
      sqlite.prepare(`SELECT status FROM agent_sessions WHERE id = 'agent-1'`).pluck().get()
    ).toBe('running');
    expect(
      sqlite.prepare(`SELECT ended_at FROM compute_usage WHERE id = 'usage-1'`).pluck().get()
    ).toBeNull();
  });

  it('repairs a stale stopping row when ProjectData was already stopped by terminal reconciliation', async () => {
    mocks.sleepSession.mockResolvedValueOnce(false);
    mocks.getSession.mockResolvedValueOnce({ status: 'stopped' });
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_stopping_since, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'dead-owner',
            '2026-08-12T00:55:00.000Z', '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:55:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({
      selected: 1,
      repaired: 1,
      skipped: 0,
      projectDataErrors: 0,
      errors: 0,
    });
    expect(mocks.sleepSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
    expect(mocks.getSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleeping_at, sleep_claim_id, sleep_claimed_at
             FROM session_snapshots WHERE id = 'snapshot-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'sleeping',
      sleeping_at: '2026-08-12T01:00:00.000Z',
      sleep_claim_id: null,
      sleep_claimed_at: null,
    });
    expect(
      sqlite.prepare(`SELECT ended_at FROM compute_usage WHERE id = 'usage-1'`).pluck().get()
    ).toEqual(expect.any(String));
  });

  it('repairs a stale stopping row idempotently when ProjectData is already sleeping', async () => {
    mocks.sleepSession.mockResolvedValueOnce(false);
    mocks.getSession.mockResolvedValueOnce({ status: 'sleeping' });
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_stopping_since, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'dead-owner',
            '2026-08-12T00:55:00.000Z', '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:55:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({
      selected: 1,
      repaired: 1,
      skipped: 0,
      projectDataErrors: 0,
      errors: 0,
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(
      sqlite.prepare(`SELECT status FROM agent_sessions WHERE id = 'agent-1'`).pluck().get()
    ).toBe('sleeping');
  });

  it('does not repair a stale stopping row when ProjectData status is missing after sleep fails', async () => {
    mocks.sleepSession.mockResolvedValueOnce(false);
    mocks.getSession.mockResolvedValueOnce(null);
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_stopping_since, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'dead-owner',
            '2026-08-12T00:55:00.000Z', '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:55:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({
      selected: 1,
      repaired: 0,
      skipped: 0,
      projectDataErrors: 1,
      errors: 0,
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'running',
    });
    expect(
      sqlite.prepare(`SELECT sleep_status FROM session_snapshots WHERE id = 'snapshot-1'`).pluck().get()
    ).toBe('stopping');
  });

  it('does not repair a stale stopping row when ProjectData status is unsupported after sleep fails', async () => {
    mocks.sleepSession.mockResolvedValueOnce(false);
    mocks.getSession.mockResolvedValueOnce({ status: 'failed' });
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
            degradation, manifest_r2_key, home_r2_key, expires_at, sleep_status,
            sleep_claim_id, sleep_claimed_at, sleep_stopping_since, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1', 'vm',
            'available', 'none', 'snapshots/chat-1/manifest.json', 'snapshots/chat-1/home.tar.zst',
            '2026-08-20T00:00:00.000Z', 'stopping', 'dead-owner',
            '2026-08-12T00:55:00.000Z', '2026-08-12T00:00:00.000Z', 2, ?, ?)`
      )
      .run('2026-08-12T00:00:00.000Z', '2026-08-12T00:55:00.000Z');

    const result = await runSessionSleepLifecycleRepair(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({
      selected: 1,
      repaired: 0,
      skipped: 0,
      projectDataErrors: 1,
      errors: 0,
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'running',
    });
    expect(
      sqlite.prepare(`SELECT sleep_status FROM session_snapshots WHERE id = 'snapshot-1'`).pluck().get()
    ).toBe('stopping');
  });
});
