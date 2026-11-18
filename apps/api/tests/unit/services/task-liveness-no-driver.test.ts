import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import { readTaskAcpLivenessSignals } from '@simple-agent-manager/project-data/internal/do/task-acp-liveness-signals';
import type { Env as ProjectDataEnv } from '@simple-agent-manager/project-data/internal/do/types';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { getTaskRuntimeLiveness } from '../../../src/scheduled/stuck-tasks';
import { nodeTransportExtension } from '../../../src/services/node-transport-extension';
import * as liveness from '../../../src/services/task-runtime-liveness';
import { getLocalTaskRuntimeLiveness } from '../../../src/services/task-runtime-liveness-local';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from '../durable-objects/sql-storage-test-utils';

const { fetchWithTimeoutMock, hostListingMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(),
  hostListingMock: vi.fn(),
}));
vi.mock('../../../src/services/fetch-timeout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/fetch-timeout')>()),
  fetchWithTimeout: fetchWithTimeoutMock,
}));
vi.mock('../../../src/services/node-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/node-agent')>()),
  listAgentSessionsOnNode: hostListingMock,
}));

/** The Cloudflare build installs no reverse-tunnel driver: neither adapter may probe DNS. */
const classifier = vi.spyOn(liveness, 'classifyTaskRuntimeLiveness');
const PROJECT_ID = 'project-1';
const WORKSPACE_ID = '01M7L17BWORKSPACE000000000';
const NODE_ID = '01M7L17BNODE00000000000000';
const TASK_ID = '01M7L17BTASK00000000000000';
const CHAT_SESSION_ID = 'chat-1';

let sqlite: Database.Database;
let env: Env;
let projectSqlite: Database.Database;
let projectSql: SqlStorage;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.workspaces,
    schema.nodes,
    schema.sessionSnapshots,
    schema.tasks,
  ]);
  projectSqlite = new Database(':memory:');
  projectSql = createSqlStorage(projectSqlite);
  runMigrations(projectSql);
  const now = Date.now();
  projectSql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count,
                               started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Task', 'active', 0, ?, ?, ?)`,
    CHAT_SESSION_ID,
    WORKSPACE_ID,
    TASK_ID,
    now,
    now,
    now
  );
  projectSql.exec(
    `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status, agent_type,
                              last_heartbeat_at, created_at, updated_at, started_at)
     VALUES ('acp-live', ?, ?, ?, 'running', 'claude-code', ?, ?, ?, ?)`,
    CHAT_SESSION_ID,
    WORKSPACE_ID,
    NODE_ID,
    now,
    now,
    now,
    now
  );
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    PROJECT_DATA: {
      idFromName: () => ({ toString: () => PROJECT_ID }),
      get: () => ({
        ensureProjectId: async () => undefined,
        getTaskAcpLivenessSignals: async (opts: Parameters<typeof readTaskAcpLivenessSignals>[2]) =>
          readTaskAcpLivenessSignals(projectSql, env as unknown as ProjectDataEnv, opts),
      }),
    },
  } as unknown as Env;
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 200 }));
  hostListingMock.mockImplementation(async (_nodeId: string, workspaceId: string) => ({
    sessions: [{ id: 'acp-live', workspaceId, status: 'running', hostStatus: 'ready' }],
  }));
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at, vm_size,
                          vm_location, cloud_provider, created_at, updated_at)
       VALUES (?, 'user-1', 'node', 'running', 'healthy', ?, 'cpx21', 'nbg1', 'hetzner', ?, ?)`
    )
    .run(NODE_ID, iso(-10 * 60 * 1000), iso(-3_600_000), iso(0));
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size, vm_location,
                               project_id, chat_session_id, node_id, created_at, updated_at)
       VALUES (?, 'user-1', 'ws', 'org/repo', 'main', 'running', 'cpx21', 'nbg1', ?, ?, ?, ?, ?)`
    )
    .run(WORKSPACE_ID, PROJECT_ID, CHAT_SESSION_ID, NODE_ID, iso(-3_600_000), iso(0));
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                          triggered_by, chat_session_id, created_by, created_at, updated_at)
       VALUES (?, ?, 'user-1', ?, 'task', 'in_progress', 0, 'user', ?, 'user-1', ?, ?)`
    )
    .run(TASK_ID, PROJECT_ID, WORKSPACE_ID, CHAT_SESSION_ID, iso(-3_600_000), iso(0));
});

afterEach(() => {
  sqlite.close();
  projectSqlite.close();
});

const setTransport = (transport: string | null) =>
  sqlite.prepare('UPDATE nodes SET transport = ? WHERE id = ?').run(transport, NODE_ID);
const probedUrls = () => fetchWithTimeoutMock.mock.calls.map((call) => String(call[0]));

const adapters = [
  [
    'cron (stuck-tasks)',
    () =>
      getTaskRuntimeLiveness(env, {
        id: TASK_ID,
        project_id: PROJECT_ID,
        workspace_id: WORKSPACE_ID,
      }),
  ],
  [
    'ProjectData (local)',
    () =>
      getLocalTaskRuntimeLiveness(projectSql, env as unknown as ProjectDataEnv, {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        chatSessionId: CHAT_SESSION_ID,
      }),
  ],
] as const;

describe.each(adapters)('%s without a reverse-tunnel driver', (_name, classify) => {
  it('preserves inconclusive liveness without probing the public hostname', async () => {
    expect(nodeTransportExtension()).toBeUndefined();
    setTransport('reverse-tunnel');
    const result = await classify();
    expect(classifier).toHaveBeenCalled();
    expect(classifier.mock.lastCall?.[0].nodeHealthProbeOutcome).toBe('error');
    expect(result.conclusive).toBe(false);
    expect(classifier.mock.lastCall?.[0].acpProbeOutcome).toBe('not_run');
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([null, 'vm-public-dns', 'cloudflare-tunnel'])(
    'control: transport %j still probes the public hostname successfully',
    async (transport) => {
      setTransport(transport);
      await classify();
      expect(classifier.mock.lastCall?.[0].nodeHealthProbeOutcome).toBe('ok');
      expect(classifier.mock.lastCall?.[0].acpProbeOutcome).toBe('ok');
      expect(hostListingMock).toHaveBeenCalled();
      expect(probedUrls()).toEqual([
        `https://${NODE_ID.toLowerCase()}.vm.example.test:8443/health`,
      ]);
    }
  );
});
