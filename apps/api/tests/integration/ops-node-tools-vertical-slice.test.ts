/**
 * Vertical slice for the Operations node reach-in tools (`.claude/rules/35`, `.claude/rules/62`):
 * real `POST /mcp` route → real `requireOperationsAccess` gate over real SQL → shared node
 * access service → node-agent HTTP boundary. Only the network hop is faked, and the fake node
 * enforces the VM agent's management-token contract (`ValidateNodeManagementToken`: RS256,
 * audience `node-management`, `node` claim equal to the node being called).
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { exportPKCS8, jwtVerify } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ fetch: vi.fn() }));
// The network hop itself: everything above it (management-token signing, URL building,
// response handling) runs for real.
vi.mock('../../src/services/fetch-timeout', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/fetch-timeout')>(
    '../../src/services/fetch-timeout'
  )),
  fetchWithTimeout: boundary.fetch,
}));

import { platformErrors } from '../../src/db/observability-schema';
import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  callMcpTool,
  createJsonKv,
  createMcpApp,
  postMcp,
  storeMcpToken,
} from '../helpers/mcp-route';
import { createAllSchemaTables, createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const OPS_PROJECT = 'proj-ops';
const NODE = 'NODE01OPSSLICE';

let main: Database.Database;
let env: Env;
let publicKey: CryptoKey;
let nodeCalls: Array<{ path: string; query: URLSearchParams }>;
let app: Awaited<ReturnType<typeof createMcpApp>>;

// The MCP route graph is large; import it once, outside any single test's timeout.
beforeAll(async () => {
  app = await createMcpApp();
}, 60_000);

/**
 * A node agent at `<nodeId>.vm.<BASE_DOMAIN>` that accepts only a valid management JWT for
 * itself, as `ValidateNodeManagementToken` does.
 */
async function fakeNode(url: string, init: RequestInit, selfNodeId?: string) {
  const parsed = new URL(url);
  const nodeId = selfNodeId ?? parsed.hostname.split('.')[0]?.toUpperCase();
  const auth = new Headers(init.headers).get('Authorization') ?? '';
  try {
    const { payload } = await jwtVerify(auth.replace(/^Bearer /, ''), publicKey, {
      audience: 'node-management',
    });
    if (payload.node !== nodeId) throw new Error('node claim mismatch');
  } catch {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  nodeCalls.push({ path: parsed.pathname, query: parsed.searchParams });
  if (parsed.pathname === '/logs') {
    return Response.json({
      entries: [
        {
          timestamp: '2026-11-03T11:59:00Z',
          level: 'error',
          source: 'agent',
          message: 'snapshot upload failed: 412',
        },
        {
          timestamp: '2026-11-03T11:58:00Z',
          level: 'info',
          source: 'agent',
          message: 'heartbeat ok',
        },
        {
          timestamp: '2026-11-03T11:57:00Z',
          level: 'warn',
          source: 'docker',
          message: 'Snapshot retry scheduled',
        },
      ],
      nextCursor: 'cursor-2',
      hasMore: true,
    });
  }
  return Response.json({ cpu: { cores: 2 } });
}

function seed() {
  main = new Database(':memory:');
  createAllSchemaTables(main, schema);
  main.exec(
    readFileSync(
      new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    main
      .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row));
  };
  insert('platform_settings', {
    key: 'operations.debuggerTools',
    value: 'read',
    updated_at: '2026-11-03T00:00:00Z',
  });
  for (const [id, role] of [
    ['admin', 'superadmin'],
    ['member', 'user'],
    ['owner', 'user'],
  ] as const) {
    insert('users', { id, email: `${id}@example.test`, name: id, role, status: 'active' });
  }
  insert('tasks', {
    id: 'task-admin',
    project_id: OPS_PROJECT,
    user_id: 'admin',
    title: 't',
    status: 'in_progress',
  });
  insert('tasks', {
    id: 'task-member',
    project_id: OPS_PROJECT,
    user_id: 'member',
    title: 't',
    status: 'in_progress',
  });
  insert('tasks', {
    id: 'task-elsewhere',
    project_id: 'proj-other',
    user_id: 'admin',
    title: 't',
    status: 'in_progress',
  });
  // The node belongs to a different user than the operator: the tools are installation-wide.
  insert('nodes', {
    id: NODE,
    user_id: 'owner',
    name: 'n',
    status: 'running',
    runtime: 'vm',
    health_status: 'healthy',
  });
  return main;
}

beforeEach(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  publicKey = keys.publicKey;
  nodeCalls = [];
  boundary.fetch.mockImplementation((url: string, init: RequestInit) => fakeNode(url, init));
  const obs = new Database(':memory:');
  createSchemaTables(obs, [platformErrors]);
  env = {
    DATABASE: createSqliteD1(seed()),
    OBSERVABILITY_DATABASE: createSqliteD1(obs),
    KV: createJsonKv(),
    BASE_DOMAIN: 'example.test',
    JWT_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
    PLATFORM_FEEDBACK_PROJECT_ID: OPS_PROJECT,
  } as unknown as Env;
  await storeMcpToken(env.KV, 'tok-admin', {
    taskId: 'task-admin',
    projectId: OPS_PROJECT,
    userId: 'admin',
    workspaceId: 'ws-a',
  });
  await storeMcpToken(env.KV, 'tok-member', {
    taskId: 'task-member',
    projectId: OPS_PROJECT,
    userId: 'member',
    workspaceId: 'ws-m',
  });
  await storeMcpToken(env.KV, 'tok-elsewhere', {
    taskId: 'task-elsewhere',
    projectId: 'proj-other',
    userId: 'admin',
    workspaceId: 'ws-o',
  });
});

afterEach(() => {
  main.close();
  vi.clearAllMocks();
});

function auditRows() {
  return main
    .prepare(
      'SELECT tool, outcome, target_id AS targetId, detail FROM operations_audit_log ORDER BY rowid'
    )
    .all() as Array<{
    tool: string;
    outcome: string;
    targetId: string | null;
    detail: string | null;
  }>;
}

describe('ops node tools — MCP → gate → node proxy', () => {
  it('reads another user’s node logs, filtered on the server, through the real management-token contract', async () => {
    const response = await callMcpTool(app, env, 'tok-admin', 'ops_node_logs', {
      nodeId: NODE,
      contains: 'snapshot',
      source: 'all',
    });

    expect(response.error).toBeUndefined();
    const body = JSON.parse(response.result?.content[0]?.text ?? '{}');
    expect(body.untrustedContent).toBe(true);
    expect(body.status, JSON.stringify(body)).toBe('ok');
    expect(body.matchedEntries).toBe(2);
    expect(body.log.text).toContain('BEGIN UNTRUSTED NODE LOG');
    expect(body.log.text).toContain('snapshot upload failed: 412');
    expect(body.log.text).toContain('Snapshot retry scheduled');
    expect(body.log.text).not.toContain('heartbeat ok');
    expect(body.nextCursor).toBe('cursor-2');
    // `contains` makes the API scan a full agent page and pass the filter down.
    expect(nodeCalls).toHaveLength(1);
    expect(nodeCalls[0]?.path).toBe('/logs');
    expect(nodeCalls[0]?.query.get('limit')).toBe('1000');
    expect(nodeCalls[0]?.query.get('search')).toBe('snapshot');

    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 'ops_node_logs', outcome: 'succeeded', targetId: NODE });
    expect(audit[0]?.detail).not.toContain('snapshot upload failed');
  });

  it('a forged token for another node is refused by the fake node (the contract is enforced)', async () => {
    boundary.fetch.mockImplementation((url: string, init: RequestInit) =>
      fakeNode(url, init, 'SOME-OTHER-NODE')
    );
    const response = await callMcpTool(app, env, 'tok-admin', 'ops_node_system_info', {
      nodeId: NODE,
    });

    const body = JSON.parse(response.result?.content[0]?.text ?? '{}');
    expect(body.status).toBe('unreachable');
    expect(nodeCalls).toHaveLength(0);
    // Liveness: the request reached the node and the node refused it.
    expect(boundary.fetch).toHaveBeenCalledTimes(1);
    expect(body.error.text).toContain('401');
  });

  it('denies an Operations-project member who is not a superadmin, without calling the node', async () => {
    const response = await callMcpTool(app, env, 'tok-member', 'ops_node_logs', { nodeId: NODE });

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('superadmin');
    expect(boundary.fetch).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([
      expect.objectContaining({ tool: 'ops_node_logs', outcome: 'denied' }),
    ]);
  });

  it('denies a superadmin task outside the Operations project, without calling the node', async () => {
    const response = await callMcpTool(app, env, 'tok-elsewhere', 'ops_node_logs', {
      nodeId: NODE,
    });

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('Operations project');
    expect(boundary.fetch).not.toHaveBeenCalled();
  });

  it('denies every call when the installation switch is off', async () => {
    main
      .prepare(`UPDATE platform_settings SET value = 'off' WHERE key = 'operations.debuggerTools'`)
      .run();
    const response = await callMcpTool(app, env, 'tok-admin', 'ops_find_anomalies', {});

    expect(response.error?.message).toContain('turned off');
  });

  it('lists ops tools only to the Operations project', async () => {
    const names = async (token: string) => {
      const listed = (await postMcp(app, env, token, 'tools/list')) as {
        result?: { tools: Array<{ name: string }> };
      };
      return (listed.result?.tools ?? []).map((t) => t.name);
    };

    const ops = await names('tok-admin');
    const other = await names('tok-elsewhere');

    for (const tool of [
      'ops_find_anomalies',
      'ops_get_session_story',
      'ops_node_logs',
      'ops_capture_debug_package',
    ]) {
      expect(ops).toContain(tool);
      expect(other).not.toContain(tool);
    }
    // Liveness: the other project still gets its ordinary tools.
    expect(other).toContain('get_instructions');
  });
});
