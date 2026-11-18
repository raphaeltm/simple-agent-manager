import type { Env as ProjectDataEnv } from '@simple-agent-manager/project-data/internal/do/types';
import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { getTaskRuntimeLiveness } from '../../../src/scheduled/stuck-tasks';
import { installNodeTransportExtension } from '../../../src/services/node-transport-extension';
import { getLocalTaskRuntimeLiveness } from '../../../src/services/task-runtime-liveness-local';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from '../durable-objects/sql-storage-test-utils';

const { fetchWithTimeoutMock, hostListingMock, resolveAgentOrigin } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(),
  hostListingMock: vi.fn(),
  resolveAgentOrigin: vi.fn(),
}));
vi.mock('../../../src/services/fetch-timeout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/fetch-timeout')>()),
  fetchWithTimeout: fetchWithTimeoutMock,
}));
vi.mock('../../../src/services/node-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/node-agent')>()),
  listAgentSessionsOnNode: hostListingMock,
}));

/**
 * Both task-liveness adapters (`.claude/rules/61`) must probe a stale node through the route its
 * stored transport selects, reading `nodes.transport` from the real snapshot loader. A tunnel-only
 * node probed on the public hostname would fail and read as an unhealthy node.
 */
const PROJECT_ID = 'project-1';
const WORKSPACE_ID = '01M7L17BWORKSPACE000000000';
const NODE_ID = '01M7L17BNODE00000000000000';
const TASK_ID = '01M7L17BTASK00000000000000';
const CHAT_SESSION_ID = 'chat-1';
const LEASE_ORIGIN = 'http://127.0.0.1:20007';

let sqlite: Database.Database;
let env: Env;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeAll(() => {
  // Stands in for the self-host driver: only the routing hook is exercised here.
  installNodeTransportExtension({
    transport: 'reverse-tunnel',
    select: () => null,
    prepare: async () => () => '',
    releaseUnallocated: async () => false,
    releaseNonLive: async () => 0,
    resolveAgentOrigin,
  });
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.workspaces,
    schema.nodes,
    schema.sessionSnapshots,
    schema.tasks,
  ]);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 200 }));
  resolveAgentOrigin.mockResolvedValue(LEASE_ORIGIN);
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
      getLocalTaskRuntimeLiveness(
        createSqlStorage(new Database(':memory:')),
        env as unknown as ProjectDataEnv,
        {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          workspaceId: WORKSPACE_ID,
          chatSessionId: CHAT_SESSION_ID,
        }
      ),
  ],
] as const;

describe.each(adapters)('%s node-health probe routing', (_name, classify) => {
  it('probes a reverse-tunnel node on its lease route, never the public hostname', async () => {
    setTransport('reverse-tunnel');
    await classify();
    expect(resolveAgentOrigin).toHaveBeenCalledWith(expect.anything(), NODE_ID);
    expect(probedUrls()).toContain(`${LEASE_ORIGIN}/health`);
    expect(probedUrls().some((url) => url.includes('.vm.example.test'))).toBe(false);
  });

  it.each([null, 'vm-public-dns', 'cloudflare-tunnel'])(
    'control: transport %j keeps the public hostname and resolves no lease',
    async (transport) => {
      setTransport(transport);
      await classify();
      expect(probedUrls()).toContain(
        `https://${NODE_ID.toLowerCase()}.vm.example.test:8443/health`
      );
      expect(resolveAgentOrigin).not.toHaveBeenCalled();
    }
  );
});
