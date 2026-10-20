/** Real cleanupTaskRun + SQLite; only external runtime removal is substituted. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { stopNodeResources } from '../../../src/services/nodes';
import { cleanupTaskRun } from '../../../src/services/task-runner';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/nodes', () => ({ stopNodeResources: vi.fn() }));

const NOW = '2026-10-20T00:00:00.000Z';
const FALLBACK = JSON.stringify({
  version: 1,
  outcome: 'slept',
  trigger: 'attempt_budget',
  blockedReason: null,
  decidedAt: NOW,
  episodeStartedAt: NOW,
  failedAttempts: 3,
  lastError: 'No exact Git recovery point',
  recoveryPoint: null,
});

describe('Instant task cleanup preserves confirmed transcript-only sleep', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.tasks,
      schema.nodes,
      schema.workspaces,
      schema.sessionSnapshots,
    ]);
    env = { DATABASE: createSqliteD1(sqlite), TASK_RUN_CLEANUP_DELAY_MS: '0' } as Env;
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, runtime)
      VALUES ('node-1', 'user-1', 'running', 'cf-container')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, user_id, project_id, chat_session_id, status)
      VALUES ('ws-1', 'node-1', 'user-1', 'project-1', 'chat-1', 'sleeping')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO tasks (id, user_id, project_id, workspace_id, status)
      VALUES ('task-1', 'user-1', 'project-1', 'ws-1', 'completed')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
      (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status, degradation,
       manifest_r2_key, expires_at, sleep_status, sleeping_at, sleep_fallback_json, created_at, updated_at)
      VALUES ('snapshot-1', 'project-1', 'ws-1', 'node-1', 'user-1', 'chat-1', 'cf-container',
      'degraded', 'transcript-only', 'retained/manifest.json', '2026-10-27T00:00:00.000Z',
      'sleeping', ?, ?, ?, ?)`
      )
      .run(NOW, FALLBACK, NOW, NOW);
    vi.mocked(stopNodeResources).mockImplementation(async () => {
      sqlite.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = 'ws-1'").run();
      sqlite.prepare("UPDATE nodes SET status = 'deleted' WHERE id = 'node-1'").run();
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  function statuses() {
    return sqlite
      .prepare(
        `SELECT w.status AS workspace, n.status AS node
      FROM workspaces w JOIN nodes n ON n.id = w.node_id WHERE w.id = 'ws-1'`
      )
      .get();
  }

  it('retains valid confirmed null-point fallback across repeated cleanup for a fresh wake', async () => {
    await cleanupTaskRun('task-1', env);
    await cleanupTaskRun('task-1', env);
    expect(stopNodeResources).not.toHaveBeenCalled();
    expect(statuses()).toEqual({ workspace: 'sleeping', node: 'running' });
    expect(
      sqlite.prepare('SELECT sleep_fallback_json, manifest_r2_key FROM session_snapshots').get()
    ).toEqual({ sleep_fallback_json: FALLBACK, manifest_r2_key: 'retained/manifest.json' });
  });

  it('retains a confirmed fallback with a recovery point matching its completed generation', async () => {
    const record = JSON.stringify({
      ...JSON.parse(FALLBACK),
      recoveryPoint: {
        generation: 'generation-1',
        commit: 'a'.repeat(40),
        branch: 'sam/feature',
        detached: false,
        upstream: 'origin/sam/feature',
        capturedAt: NOW,
        snapshotStatus: 'degraded',
        degradation: 'home-skipped',
        workingTreeSaved: true,
        homeSaved: false,
      },
    });
    sqlite
      .prepare(
        `UPDATE session_snapshots SET snapshot_generation = 'generation-1',
      sleep_fallback_json = ?`
      )
      .run(record);

    await cleanupTaskRun('task-1', env);

    expect(stopNodeResources).not.toHaveBeenCalled();
    expect(statuses()).toEqual({ workspace: 'sleeping', node: 'running' });
    expect(sqlite.prepare('SELECT sleep_fallback_json FROM session_snapshots').get()).toEqual({
      sleep_fallback_json: record,
    });
  });

  it.each([
    ['malformed record', "sleep_fallback_json = '{'"],
    ['incomplete record', `sleep_fallback_json = '{"version":1,"outcome":"slept"}'`],
    ['blocked outcome', `sleep_fallback_json = '${FALLBACK.replace('slept', 'blocked')}'`],
    ['stopping intent', "sleep_status = 'stopping'"],
    ['unconfirmed sleep', 'sleeping_at = NULL'],
    ['expired snapshot', `expires_at = '${NOW}'`],
    ['other workspace', "workspace_id = 'other-workspace'"],
    ['other node', "node_id = 'other-node'"],
    ['other user', "user_id = 'other-user'"],
    ['other project', "project_id = 'other-project'"],
  ])('destroys an Instant runtime with %s', async (_label, mutation) => {
    sqlite.exec(`UPDATE session_snapshots SET ${mutation}`);
    await cleanupTaskRun('task-1', env);
    expect(stopNodeResources).toHaveBeenCalledWith('node-1', 'user-1', env);
    expect(statuses()).toEqual({ workspace: 'deleted', node: 'deleted' });
  });

  it('retains an ordinary complete snapshot', async () => {
    sqlite.exec(
      "UPDATE session_snapshots SET status = 'available', degradation = 'none', sleep_fallback_json = NULL"
    );
    await cleanupTaskRun('task-1', env);
    expect(stopNodeResources).not.toHaveBeenCalled();
    expect(statuses()).toEqual({ workspace: 'sleeping', node: 'running' });
  });

  it('refuses cleanup requested by another user against the current runtime', async () => {
    sqlite.exec("UPDATE workspaces SET status = 'running'");
    await cleanupTaskRun('task-1', env, undefined, 'other-user');
    expect(stopNodeResources).not.toHaveBeenCalled();
    expect(statuses()).toEqual({ workspace: 'running', node: 'running' });
  });
});
