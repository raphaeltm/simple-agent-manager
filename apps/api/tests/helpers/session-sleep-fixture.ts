/** Shared real-D1 sleep state and external control-plane boundaries. */
import Database from 'better-sqlite3';
import { vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createSchemaTables, createSqliteD1 } from './sqlite-d1';

const sleepBoundaryMocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(),
  acceptPromptDelivery: vi.fn(),
  stopSession: vi.fn(),
  sendPrompt: vi.fn(),
  stopAgent: vi.fn(),
  getAcpSession: vi.fn(),
  getSession: vi.fn(),
  getSessionState: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  sleepVmAgentContainer: vi.fn(),
  markIdle: vi.fn(),
  r2Head: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  sleepSession: vi.fn(),
  stopComputeTracking: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  transitionAcpSession: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: (...args: unknown[]) => sleepBoundaryMocks.sendPrompt(...args),
  stopAgentSessionOnNode: (...args: unknown[]) => sleepBoundaryMocks.stopAgent(...args),
  hibernateAgentSessionOnNode: (...args: unknown[]) =>
    sleepBoundaryMocks.hibernateAgentSessionOnNode(...args),
  stopWorkspaceOnNode: (...args: unknown[]) => sleepBoundaryMocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  failSession: vi.fn(),
  getAcpSession: (...args: unknown[]) => sleepBoundaryMocks.getAcpSession(...args),
  getSession: (...args: unknown[]) => sleepBoundaryMocks.getSession(...args),
  getSessionState: (...args: unknown[]) => sleepBoundaryMocks.getSessionState(...args),
  sleepSession: (...args: unknown[]) => sleepBoundaryMocks.sleepSession(...args),
  stopSession: (...args: unknown[]) => sleepBoundaryMocks.stopSession(...args),
  acceptPromptDelivery: (...args: unknown[]) => sleepBoundaryMocks.acceptPromptDelivery(...args),
  transitionAcpSession: (...args: unknown[]) => sleepBoundaryMocks.transitionAcpSession(...args),
}));

vi.mock('../../src/services/compute-usage', () => ({
  stopComputeTracking: (...args: unknown[]) => sleepBoundaryMocks.stopComputeTracking(...args),
}));

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => sleepBoundaryMocks.cleanupTaskRun(...args),
}));

vi.mock('../../src/services/vm-agent-container', () => ({
  markVmAgentContainerActiveWorkStarted: vi.fn(),
  sleepVmAgentContainer: (...args: unknown[]) => sleepBoundaryMocks.sleepVmAgentContainer(...args),
}));

export const SLEEP_START = new Date('2026-08-14T05:00:00.000Z');
const HOME_SHA256 = 'ab'.repeat(32);

function checksumBytes(hex: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
}

export interface SleepActivity {
  activity: 'prompting' | 'idle';
  activityAt: number;
  runtimeWorkState?: 'inactive' | 'active' | 'settling';
  runtimeWorkCount?: number;
  runtimeWorkSource?: string;
  runtimeWorkUpdatedAt?: number;
  runtimeWorkProgressAt?: number;
}

export function createSessionSleepFixture(taskStatus: string, getActivity: () => SleepActivity) {
  vi.useFakeTimers();
  vi.setSystemTime(SLEEP_START);
  vi.resetAllMocks();
  const mocks = sleepBoundaryMocks;
  const START = SLEEP_START;
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.projects,
    schema.projectMembers,
    schema.taskStatusEvents,
    schema.triggerExecutions,
    schema.vmTaskAdmissions,
    schema.vmProvisioningLeases,
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
           ('task-1', 'project-1', 'user-1', 'workspace-1', ?)`
    )
    .run(taskStatus);
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
  // Recovery may replace workspace/node/runtime while retaining the same owner and project.
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
           (id, project_id, workspace_id, node_id, user_id, chat_session_id,
            agent_session_id, runtime, status, degradation, manifest_r2_key,
            expires_at, sleep_attempts, created_at, updated_at)
         VALUES
           ('snapshot-1', 'project-1', 'workspace-old', 'node-old', 'user-1', 'chat-1',
            'agent-old', 'cf-container', 'pending', 'none', 'old/manifest.json',
            '2026-08-21T05:00:00.000Z', 0, ?, ?)`
    )
    .run(START.toISOString(), START.toISOString());

  const order: string[] = [];
  mocks.getSessionState.mockImplementation(() => Promise.resolve(getActivity()));
  let sessionStatus = 'active';
  mocks.getSession.mockImplementation(() =>
    Promise.resolve({
      id: 'chat-1',
      status: sessionStatus,
      taskId: 'task-1',
      workspaceId: 'workspace-1',
    })
  );
  mocks.sleepSession.mockImplementation(() => {
    sessionStatus = 'sleeping';
    return Promise.resolve(true);
  });
  mocks.stopSession.mockImplementation(() => {
    sessionStatus = 'stopped';
    return Promise.resolve();
  });
  mocks.getAcpSession.mockResolvedValue(null);
  mocks.stopWorkspaceOnNode.mockImplementation(() => {
    order.push('stop-workspace');
    return Promise.resolve();
  });
  mocks.sleepVmAgentContainer.mockImplementation((_env: Env, nodeId: string) => {
    order.push(`sleep-container:${nodeId}`);
    return Promise.resolve();
  });
  mocks.stopComputeTracking.mockImplementation(() => {
    order.push('stop-compute-tracking');
    return Promise.resolve(1);
  });
  mocks.cleanupTaskRun.mockImplementation(() => {
    order.push('task-cleanup');
    return Promise.resolve();
  });
  mocks.scheduleWorkspaceDeletion.mockImplementation(() => {
    order.push('schedule-deletion');
    return Promise.resolve();
  });
  mocks.markIdle.mockImplementation(() => {
    order.push('mark-node-warm');
    return Promise.resolve();
  });
  mocks.r2Head.mockImplementation((key: string) => {
    order.push(`r2-head:${key}`);
    return Promise.resolve(
      key.endsWith('/home.tar')
        ? { size: 4, checksums: { sha256: checksumBytes(HOME_SHA256) } }
        : { size: 128, checksums: {} }
    );
  });
  mocks.hibernateAgentSessionOnNode.mockImplementation(
    (
      _nodeId: string,
      workspaceId: string,
      agentSessionId: string,
      _env: Env,
      _userId: string,
      options?: { chatSessionId?: string }
    ) => {
      const chatSessionId = options?.chatSessionId ?? 'chat-1';
      const generation = `generation-final-${chatSessionId}`;
      const prefix = `session-snapshots/${chatSessionId}/${generation}`;
      sqlite
        .prepare(
          `UPDATE session_snapshots
           SET status = 'available', degradation = 'none',
               snapshot_generation = ?, capture_generation = NULL,
               home_r2_key = ?, home_sha256 = ?, manifest_r2_key = ?,
               manifest_json = ?
           WHERE chat_session_id = ?`
        )
        .run(
          generation,
          `${prefix}/home.tar`,
          HOME_SHA256,
          `${prefix}/manifest.json`,
          JSON.stringify({
            version: 1,
            chatSessionId,
            workspaceId,
            agentSessionId,
            status: 'available',
            degradation: 'none',
            artifacts: { home: { sizeBytes: 4, sha256: HOME_SHA256 } },
          }),
          chatSessionId
        );
      order.push(`final-snapshot:${chatSessionId}`);
      return Promise.resolve({ status: 'pending', accepted: true });
    }
  );

  const env = {
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
  return {
    sqlite,
    env,
    order,
    get sessionStatus() {
      return sessionStatus;
    },
    dispose() {
      sqlite.close();
      vi.useRealTimers();
    },
  };
}

export { sleepBoundaryMocks };
