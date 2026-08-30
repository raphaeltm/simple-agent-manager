import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runTerminalSessionLedgerReconciliation } from '../../src/scheduled/terminal-session-ledger-reconciliation';
import * as projectData from '../../src/services/project-data';
import {
  seedInstallation,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import { type ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'terminal-ledger-owner';
const INSTALLATION = 'terminal-ledger-installation';
const RUN_ID = crypto.randomUUID().slice(0, 8);

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

async function withReconcileEnv<T>(fn: () => Promise<T>): Promise<T> {
  const mutableEnv = testEnv as WorkerEnv & {
    TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE?: string;
    TERMINAL_SESSION_RECONCILE_BATCH_SIZE?: string;
    TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE?: string;
    TERMINAL_SESSION_RECONCILE_DEFER_MS?: string;
  };
  const previous = {
    projectBatch: mutableEnv.TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE,
    sessionBatch: mutableEnv.TERMINAL_SESSION_RECONCILE_BATCH_SIZE,
    summaryBatch: mutableEnv.TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE,
    deferMs: mutableEnv.TERMINAL_SESSION_RECONCILE_DEFER_MS,
  };
  mutableEnv.TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE = '5';
  mutableEnv.TERMINAL_SESSION_RECONCILE_BATCH_SIZE = '10';
  mutableEnv.TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE = '10';
  mutableEnv.TERMINAL_SESSION_RECONCILE_DEFER_MS = String(60 * 60 * 1000);
  try {
    return await fn();
  } finally {
    mutableEnv.TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE = previous.projectBatch;
    mutableEnv.TERMINAL_SESSION_RECONCILE_BATCH_SIZE = previous.sessionBatch;
    mutableEnv.TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE = previous.summaryBatch;
    mutableEnv.TERMINAL_SESSION_RECONCILE_DEFER_MS = previous.deferMs;
  }
}

async function seedBase(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION);
}

async function cleanupProject(projectId: string): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM session_snapshots WHERE project_id = ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM session_summaries WHERE project_id = ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM session_index_coverage WHERE project_id = ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM tasks WHERE project_id = ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM workspaces WHERE project_id = ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM project_members WHERE project_id = ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM projects WHERE id = ?').bind(projectId),
  ]);
}

async function createTaskBackedSession(
  projectId: string,
  suffix: string,
  status: 'completed' | 'failed' | 'cancelled' | 'in_progress',
  opts: {
    chatSessionId?: string | null;
    taskChatSessionId?: string | null;
    taskId?: string;
    errorMessage?: string | null;
  } = {}
): Promise<{ sessionId: string; taskId: string; workspaceId: string }> {
  const workspaceId = `${projectId}-${suffix}-workspace`;
  const taskId = opts.taskId ?? `${projectId}-${suffix}-task`;
  await seedWorkspace(workspaceId, null, OWNER, { projectId, status: 'running' });
  const sessionId =
    opts.chatSessionId ??
    (await projectData.createSession(testEnv, projectId, workspaceId, suffix, taskId, OWNER));
  await seedTask(taskId, projectId, OWNER, {
    status,
    chatSessionId: Object.hasOwn(opts, 'taskChatSessionId')
      ? (opts.taskChatSessionId ?? null)
      : sessionId,
    workspaceId,
    startedAt: '2026-08-30T00:00:00.000Z',
    completedAt: status === 'in_progress' ? null : '2026-08-30T00:05:00.000Z',
    errorMessage: opts.errorMessage ?? (status === 'failed' ? 'boom' : null),
    updatedAt: status === 'in_progress' ? '2026-08-30T00:10:00.000Z' : '2026-08-30T00:05:00.000Z',
  });
  return { sessionId, taskId, workspaceId };
}

async function seedSleepingSnapshot(input: {
  projectId: string;
  sessionId: string;
  workspaceId: string;
  expiresAt: string;
  recoveryAttempts?: number;
}): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR REPLACE INTO session_snapshots
       (id, project_id, workspace_id, user_id, chat_session_id, agent_session_id, runtime,
        status, degradation, manifest_r2_key, expires_at, sleeping_at, recovery_attempts,
        sleep_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'vm', 'available', 'none', ?, ?, ?, ?, 'sleeping', ?, ?)`
  )
    .bind(
      `${input.sessionId}-snapshot`,
      input.projectId,
      input.workspaceId,
      OWNER,
      input.sessionId,
      `snapshots/${input.sessionId}/manifest.json`,
      input.expiresAt,
      '2026-08-30T00:01:00.000Z',
      input.recoveryAttempts ?? 0,
      '2026-08-30T00:01:00.000Z',
      '2026-08-30T00:01:00.000Z'
    )
    .run();
}

async function readSessionStatus(projectId: string, sessionId: string): Promise<string | null> {
  const session = await projectData.getSession(testEnv, projectId, sessionId);
  return typeof session?.status === 'string' ? session.status : null;
}

async function readProjectActiveCount(projectId: string): Promise<number> {
  const row = await env.DATABASE.prepare('SELECT active_session_count FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ active_session_count: number }>();
  return row?.active_session_count ?? -1;
}

async function readActiveSummaryCount(projectId: string): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count FROM session_summaries
      WHERE project_id = ?
        AND status = 'active'`
  )
    .bind(projectId)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function readSummaryStatus(projectId: string, sessionId: string): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    'SELECT status FROM session_summaries WHERE project_id = ? AND id = ?'
  )
    .bind(projectId, sessionId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function readSummaryDeferReason(
  projectId: string,
  sessionId: string
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    `SELECT terminal_reconcile_defer_reason
       FROM session_summaries
      WHERE project_id = ?
        AND id = ?`
  )
    .bind(projectId, sessionId)
    .first<{ terminal_reconcile_defer_reason: string | null }>();
  return row?.terminal_reconcile_defer_reason ?? null;
}

async function readDeferReason(projectId: string, sessionId: string): Promise<string | null> {
  const stub = getStub(projectId);
  await stub.ensureProjectId(projectId);
  const row = await runInDurableObject(
    stub,
    async (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT terminal_reconcile_defer_reason
           FROM chat_sessions
          WHERE id = ?`,
          sessionId
        )
        .toArray()[0]
  );
  return typeof row?.terminal_reconcile_defer_reason === 'string'
    ? row.terminal_reconcile_defer_reason
    : null;
}

async function readSnapshotFixture(sessionId: string): Promise<{
  project_id: string | null;
  sleep_status: string | null;
  sleeping_at: string | null;
  expires_at: string | null;
  recovery_attempts: number | null;
} | null> {
  return env.DATABASE.prepare(
    `SELECT project_id, sleep_status, sleeping_at, expires_at, recovery_attempts
       FROM session_snapshots
      WHERE chat_session_id = ?`
  )
    .bind(sessionId)
    .first<{
      project_id: string | null;
      sleep_status: string | null;
      sleeping_at: string | null;
      expires_at: string | null;
      recovery_attempts: number | null;
    }>();
}

async function readBoundTaskStatuses(projectId: string, sessionId: string): Promise<string[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT status
       FROM tasks
      WHERE project_id = ?
        AND chat_session_id = ?
      ORDER BY updated_at DESC, id DESC`
  )
    .bind(projectId, sessionId)
    .all<{ status: string }>();
  return (rows.results ?? []).map((row) => row.status);
}

async function readTaskFixture(
  projectId: string,
  taskId: string
): Promise<{ status: string; chat_session_id: string | null } | null> {
  return env.DATABASE.prepare(
    `SELECT status, chat_session_id
       FROM tasks
      WHERE project_id = ?
        AND id = ?`
  )
    .bind(projectId, taskId)
    .first<{ status: string; chat_session_id: string | null }>();
}

describe('terminal session ledger reconciliation', () => {
  let counter = 0;
  let projectId: string;

  beforeEach(async () => {
    counter += 1;
    projectId = `terminal-ledger-${RUN_ID}-${counter}`;
    await seedBase(projectId);
  });

  afterEach(async () => {
    await cleanupProject(projectId);
  });

  it('repairs terminal sessions while preserving live-head and snapshot-protected controls', async () => {
    const now = new Date('2026-08-30T01:00:00.000Z');
    const completed = await createTaskBackedSession(projectId, 'completed', 'completed');
    const failed = await createTaskBackedSession(projectId, 'failed', 'failed');
    const expiredSnapshot = await createTaskBackedSession(
      projectId,
      'expired-snapshot',
      'completed'
    );
    const liveHead = await createTaskBackedSession(projectId, 'live-head-old', 'completed', {
      taskChatSessionId: null,
    });
    const liveCurrent = await createTaskBackedSession(
      projectId,
      'live-head-current',
      'in_progress',
      {
        chatSessionId: liveHead.sessionId,
      }
    );
    const protectedSnapshot = await createTaskBackedSession(
      projectId,
      'protected-snapshot',
      'completed'
    );
    await seedSleepingSnapshot({
      projectId,
      sessionId: protectedSnapshot.sessionId,
      workspaceId: protectedSnapshot.workspaceId,
      expiresAt: '2026-08-30T03:00:00.000Z',
    });
    await seedSleepingSnapshot({
      projectId,
      sessionId: expiredSnapshot.sessionId,
      workspaceId: expiredSnapshot.workspaceId,
      expiresAt: '2026-08-30T00:30:00.000Z',
    });
    expect(await readSnapshotFixture(protectedSnapshot.sessionId)).toMatchObject({
      project_id: projectId,
      sleep_status: 'sleeping',
      expires_at: '2026-08-30T03:00:00.000Z',
      recovery_attempts: 0,
    });
    expect(await readTaskFixture(projectId, liveCurrent.taskId)).toEqual({
      status: 'in_progress',
      chat_session_id: liveHead.sessionId,
    });
    expect(await readBoundTaskStatuses(projectId, liveHead.sessionId)).toEqual(['in_progress']);

    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.runSummarySyncForTest();
    expect(await readProjectActiveCount(projectId)).toBe(5);
    expect(await readActiveSummaryCount(projectId)).toBe(5);

    const first = await withReconcileEnv(() =>
      runTerminalSessionLedgerReconciliation(testEnv, now)
    );

    expect(await readSessionStatus(projectId, completed.sessionId)).toBe('stopped');
    expect(await readSessionStatus(projectId, failed.sessionId)).toBe('failed');
    expect(await readSessionStatus(projectId, expiredSnapshot.sessionId)).toBe('stopped');
    expect(await readSessionStatus(projectId, liveHead.sessionId)).toBe('active');
    expect(await readSessionStatus(projectId, protectedSnapshot.sessionId)).toBe('active');
    expect(await readDeferReason(projectId, liveHead.sessionId)).toBe('live_task_head');
    expect(await readDeferReason(projectId, protectedSnapshot.sessionId)).toBe(
      'restorable_sleeping_snapshot'
    );
    expect(first).toMatchObject({
      projectsScanned: 1,
      selected: 5,
      stopped: 2,
      failed: 1,
      deferred: 2,
      skipped: 0,
      errors: 0,
      summarySelected: 5,
      summaryStopped: 2,
      summaryFailed: 1,
      summaryDeferred: 2,
      summarySkipped: 0,
      summaryErrors: 0,
    });
    expect(await readSummaryStatus(projectId, completed.sessionId)).toBe('stopped');
    expect(await readSummaryStatus(projectId, failed.sessionId)).toBe('failed');
    expect(await readSummaryStatus(projectId, expiredSnapshot.sessionId)).toBe('stopped');
    expect(await readSummaryStatus(projectId, liveHead.sessionId)).toBe('active');
    expect(await readSummaryStatus(projectId, protectedSnapshot.sessionId)).toBe('active');
    expect(await readSummaryDeferReason(projectId, liveHead.sessionId)).toBe('live_task_head');
    expect(await readSummaryDeferReason(projectId, protectedSnapshot.sessionId)).toBe(
      'restorable_sleeping_snapshot'
    );

    const second = await withReconcileEnv(() =>
      runTerminalSessionLedgerReconciliation(testEnv, now)
    );
    expect(second).toMatchObject({
      projectsScanned: 0,
      selected: 0,
      stopped: 0,
      failed: 0,
      deferred: 0,
      skipped: 0,
      errors: 0,
      summarySelected: 0,
      summaryStopped: 0,
      summaryFailed: 0,
      summaryDeferred: 0,
      summarySkipped: 0,
      summaryErrors: 0,
    });

    await stub.runSummarySyncForTest();
    expect(await readProjectActiveCount(projectId)).toBe(2);
    expect(await readActiveSummaryCount(projectId)).toBe(2);
    expect(await readSummaryStatus(projectId, completed.sessionId)).toBe('stopped');
    expect(await readSummaryStatus(projectId, failed.sessionId)).toBe('failed');
    expect(await readSummaryStatus(projectId, expiredSnapshot.sessionId)).toBe('stopped');
    expect(await readSummaryStatus(projectId, liveHead.sessionId)).toBe('active');
    expect(await readSummaryStatus(projectId, protectedSnapshot.sessionId)).toBe('active');
  });

  it('repairs stale active session_summaries when over-cap DO sync skips row updates', async () => {
    const now = new Date('2026-08-30T03:00:00.000Z');
    const terminal = await createTaskBackedSession(projectId, 'overcap-terminal', 'completed');
    const active = await createTaskBackedSession(projectId, 'overcap-active', 'in_progress');
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.runSummarySyncForTest();

    expect(await readProjectActiveCount(projectId)).toBe(2);
    expect(await readActiveSummaryCount(projectId)).toBe(2);

    const doRepair = await withReconcileEnv(() =>
      projectData.reconcileTerminalTaskSessions(testEnv, projectId, { nowIso: now.toISOString() })
    );
    expect(doRepair).toMatchObject({ selected: 2, stopped: 1, deferred: 1, errors: 0 });
    expect(await readSessionStatus(projectId, terminal.sessionId)).toBe('stopped');
    expect(await readSessionStatus(projectId, active.sessionId)).toBe('active');

    await stub.runSummarySyncWithEnvForTest({ SESSION_INDEX_MAX_ROWS: '1' });
    expect(await readProjectActiveCount(projectId)).toBe(1);
    expect(await readActiveSummaryCount(projectId)).toBe(2);
    expect(await readSummaryStatus(projectId, terminal.sessionId)).toBe('active');

    const first = await withReconcileEnv(() =>
      runTerminalSessionLedgerReconciliation(testEnv, now)
    );
    expect(first).toMatchObject({
      summarySelected: 1,
      summaryStopped: 1,
      summaryFailed: 0,
      summaryDeferred: 0,
      summarySkipped: 0,
      summaryErrors: 0,
    });
    expect(await readProjectActiveCount(projectId)).toBe(1);
    expect(await readActiveSummaryCount(projectId)).toBe(1);
    expect(await readSummaryStatus(projectId, terminal.sessionId)).toBe('stopped');
    expect(await readSummaryStatus(projectId, active.sessionId)).toBe('active');

    const second = await withReconcileEnv(() =>
      runTerminalSessionLedgerReconciliation(testEnv, now)
    );
    expect(second).toMatchObject({
      projectsScanned: 0,
      selected: 0,
      summarySelected: 0,
      summaryStopped: 0,
      summaryFailed: 0,
      summaryDeferred: 0,
      summarySkipped: 0,
      summaryErrors: 0,
    });
  });

  it('lets existing summary sync converge D1 counts after a DO ledger repair', async () => {
    const now = new Date('2026-08-30T02:00:00.000Z');
    const terminal = await createTaskBackedSession(projectId, 'summary-converges', 'completed');
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.runSummarySyncForTest();

    expect(await readSessionStatus(projectId, terminal.sessionId)).toBe('active');
    expect(await readProjectActiveCount(projectId)).toBe(1);
    expect(await readActiveSummaryCount(projectId)).toBe(1);

    const stats = await withReconcileEnv(() =>
      projectData.reconcileTerminalTaskSessions(testEnv, projectId, { nowIso: now.toISOString() })
    );
    expect(stats).toMatchObject({ selected: 1, stopped: 1, failed: 0, errors: 0 });
    expect(await readSessionStatus(projectId, terminal.sessionId)).toBe('stopped');

    await stub.runSummarySyncForTest();
    expect(await readProjectActiveCount(projectId)).toBe(0);
    expect(await readActiveSummaryCount(projectId)).toBe(0);
    expect(await readSummaryStatus(projectId, terminal.sessionId)).toBe('stopped');
  });
});
