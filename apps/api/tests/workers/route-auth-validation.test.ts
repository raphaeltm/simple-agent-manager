/**
 * Worker integration tests for route authentication and validation.
 *
 * Replaces source-contract tests in tests/unit/routes/ that verified
 * route existence and auth requirements by reading source code as strings.
 * These tests exercise the actual Hono routes in the workerd runtime
 * with real Miniflare bindings.
 *
 * Message validation tests are NOT duplicated here — see
 * tests/workers/workspace-messages.test.ts for that coverage.
 *
 * === Coverage gaps (require user-auth session setup in Miniflare) ===
 *
 * The following invariants from deleted source-contract tests cannot be
 * verified as worker integration tests without setting up better-auth
 * sessions in Miniflare. They are documented here for future coverage:
 *
 * - C1: agentSessionId lookup does NOT filter by status='running'
 *   (chat.ts:180-192). The query uses workspaceId + orderBy(createdAt desc)
 *   without a status filter. Filtering by status caused UI to lose
 *   conversation history. Verified by code inspection; a behavioral test
 *   would require authenticated GET /api/projects/:id/chat/sessions/:id.
 *
 * - H1: stopNodeResources sets status='deleted' (not 'stopped') and calls
 *   deleteVM (not powerOff). This is an integration concern requiring real
 *   provider APIs; covered by staging verification.
 *
 * - H2: deriveHealthStatus is not exported from nodes.ts, so it cannot be
 *   tested directly. Its behavior is exercised through GET /api/nodes
 *   responses in authenticated contexts.
 *
 * - H3: Project idle timeout bounds validation on PATCH requires user auth.
 *
 * - H4: Workspace count filter (excludes 'deleted'/'error') requires user auth.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { importPKCS8, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';

// Unique IDs per test run to avoid cross-test contamination (shared D1, no isolatedStorage)
const TEST_PREFIX = `auth-val-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;
const PROJECT_ID = `${TEST_PREFIX}-proj`;
const NODE_ID = `${TEST_PREFIX}-node`;
const DELETED_NODE_ID = `${TEST_PREFIX}-deleted-node`;
const STOPPED_NODE_ID = `${TEST_PREFIX}-stopped-node`;
const WORKSPACE_ID = `${TEST_PREFIX}-ws`;
const INACTIVE_WORKSPACE_ID = `${TEST_PREFIX}-inactive-ws`;
const SESSION_ID = `${TEST_PREFIX}-sess`;
const DELETED_NODE_LAST_HEARTBEAT = '2026-08-25T00:00:00.000Z';
const STOPPED_NODE_LAST_HEARTBEAT = '2026-08-25T01:00:00.000Z';
const CALLBACK_AUDIENCE = 'workspace-callback';

let workspaceCallbackToken: string;
let nodeCallbackToken: string;
let deletedNodeCallbackToken: string;
let stoppedNodeCallbackToken: string;
let expiredNodeCallbackToken: string;

async function signExpiredNodeCallbackToken(nodeId: string): Promise<string> {
  const privateKey = await importPKCS8((env as any).JWT_PRIVATE_KEY, 'RS256');
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    workspace: nodeId,
    type: 'callback',
    scope: 'node',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://api.${(env as any).BASE_DOMAIN}`)
    .setSubject(nodeId)
    .setAudience(CALLBACK_AUDIENCE)
    .setIssuedAt(nowSeconds - 7200)
    .setExpirationTime(nowSeconds - 3600)
    .sign(privateKey);
}

async function countPlatformErrorsForNode(nodeId: string): Promise<number> {
  const row = await env.OBSERVABILITY_DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM platform_errors WHERE node_id = ?'
  )
    .bind(nodeId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

beforeAll(async () => {
  // Seed test user
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, email, github_id, name, avatar_url, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', 'active', cast(unixepoch() * 1000 as integer), cast(unixepoch() * 1000 as integer))`
  )
    .bind(
      USER_ID,
      'test-user-auth' + '@example.test',
      '888888',
      'Auth Test User',
      'https://example.com/a.png'
    )
    .run();

  // Seed test project
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_installation_accounts
       (installation_id, account_type, account_name, normalized_account_name, created_at, updated_at)
     VALUES (?, 'personal', ?, lower(?), datetime('now'), datetime('now'))`
  )
    .bind(PROJECT_ID + '-inst', 'test-owner', 'test-owner')
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_installations
       (id, user_id, installation_id, external_installation_id, account_type, account_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, datetime('now'), datetime('now'))`
  )
    .bind(PROJECT_ID + '-inst', USER_ID, PROJECT_ID + '-inst', PROJECT_ID + '-inst', 'test-owner')
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects
       (id, user_id, name, normalized_name, installation_id, repository, created_by, created_at, updated_at)
     VALUES (?, ?, ?, lower(?), ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      PROJECT_ID,
      USER_ID,
      'auth-test-project',
      'auth-test-project',
      PROJECT_ID + '-inst',
      'test-owner/test-repo',
      USER_ID
    )
    .run();

  // Seed test node (cloud_provider and vm_size are the correct column names)
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes (id, user_id, name, status, cloud_provider, vm_location, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'hetzner', 'fsn1', 'cx22', datetime('now'), datetime('now'))`
  )
    .bind(NODE_ID, USER_ID, 'auth-test-node')
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes
       (id, user_id, name, status, health_status, last_heartbeat_at, cloud_provider, vm_location, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'deleted', 'unhealthy', ?, 'hetzner', 'fsn1', 'cx22', datetime('now'), datetime('now'))`
  )
    .bind(DELETED_NODE_ID, USER_ID, 'deleted-auth-test-node', DELETED_NODE_LAST_HEARTBEAT)
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes
       (id, user_id, name, status, health_status, last_heartbeat_at, cloud_provider, vm_location, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'stopped', 'unhealthy', ?, 'hetzner', 'fsn1', 'cx22', datetime('now'), datetime('now'))`
  )
    .bind(STOPPED_NODE_ID, USER_ID, 'stopped-auth-test-node', STOPPED_NODE_LAST_HEARTBEAT)
    .run();

  // Seed an inactive historical workspace before the active workspace. This makes
  // node-scoped ACP heartbeat coverage discriminate against arbitrary LIMIT 1
  // selection when a reused node has mixed workspace statuses for the project.
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO workspaces (id, user_id, node_id, project_id, name, repository, branch, status, vm_size, vm_location, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', 'cx22', 'fsn1', datetime('now'), datetime('now'))`
  )
    .bind(
      INACTIVE_WORKSPACE_ID,
      USER_ID,
      NODE_ID,
      PROJECT_ID,
      'auth-test-inactive-ws',
      'test-repo',
      'main'
    )
    .run();

  // Seed test workspace
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO workspaces (id, user_id, node_id, project_id, chat_session_id, name, repository, branch, status, vm_size, vm_location, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'cx22', 'fsn1', datetime('now'), datetime('now'))`
  )
    .bind(
      WORKSPACE_ID,
      USER_ID,
      NODE_ID,
      PROJECT_ID,
      SESSION_ID,
      'auth-test-ws',
      'test-repo',
      'main'
    )
    .run();

  // Sign all tokens after seeding is complete (follows workspace-messages.test.ts pattern)
  workspaceCallbackToken = await signCallbackToken(WORKSPACE_ID, env as any);
  nodeCallbackToken = await signNodeCallbackToken(NODE_ID, env as any);
  deletedNodeCallbackToken = await signNodeCallbackToken(DELETED_NODE_ID, env as any);
  stoppedNodeCallbackToken = await signNodeCallbackToken(STOPPED_NODE_ID, env as any);
  expiredNodeCallbackToken = await signExpiredNodeCallbackToken(NODE_ID);

  const projectData = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(PROJECT_ID));
  await runInDurableObject(projectData, async (instance) => {
    instance.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO chat_sessions
         (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, 'Route auth validation', 'active', 0, ?, ?, ?)`,
      SESSION_ID,
      WORKSPACE_ID,
      Date.now(),
      Date.now(),
      Date.now()
    );
  });
});

// =============================================================================
// User-authenticated routes require auth (401 without session)
// =============================================================================

describe('user-authenticated routes require auth', () => {
  const userAuthRoutes = [
    { method: 'GET', path: '/api/projects' },
    { method: 'GET', path: '/api/workspaces' },
    { method: 'GET', path: '/api/nodes' },
    { method: 'POST', path: '/api/terminal/token' },
  ];

  for (const { method, path } of userAuthRoutes) {
    it(`${method} ${path} returns 401 without auth`, async () => {
      const response = await SELF.fetch(`https://api.test.example.com${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      expect(response.status).toBe(401);
    });
  }
});

// =============================================================================
// Workspace callback-authenticated routes
// =============================================================================

describe('workspace callback auth', () => {
  it('returns 401 for message endpoint without token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      }
    );
    expect(response.status).toBe(401);
  });

  it('accepts callback token for workspace-scoped endpoints', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workspaceCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              messageId: `${TEST_PREFIX}-msg-${Math.random().toString(36).slice(2)}`,
              sessionId: SESSION_ID,
              role: 'assistant',
              content: 'test message',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }
    );
    // Should succeed (200) since workspace, project, and session are linked
    expect(response.status).toBe(200);
  });
});

// =============================================================================
// Node callback-authenticated routes
// =============================================================================

describe('node callback auth', () => {
  it('accepts node callback token for heartbeat endpoint and updates live node health', async () => {
    const before = await env.DATABASE.prepare(
      'SELECT health_status, last_heartbeat_at FROM nodes WHERE id = ?'
    )
      .bind(NODE_ID)
      .first<{ health_status: string | null; last_heartbeat_at: string | null }>();

    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cpuPercent: 50,
          memoryPercent: 60,
          diskPercent: 30,
          uptimeSeconds: 3600,
        }),
      }
    );
    expect(response.status).toBe(200);
    const after = await env.DATABASE.prepare(
      'SELECT status, health_status, last_heartbeat_at FROM nodes WHERE id = ?'
    )
      .bind(NODE_ID)
      .first<{ status: string; health_status: string | null; last_heartbeat_at: string | null }>();
    expect(after).toMatchObject({ status: 'running', health_status: 'healthy' });
    expect(after?.last_heartbeat_at).toEqual(expect.any(String));
    expect(after?.last_heartbeat_at).not.toBe(before?.last_heartbeat_at ?? null);
  });

  it('returns 401 for heartbeat without token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cpuPercent: 50,
          memoryPercent: 60,
          diskPercent: 30,
          uptimeSeconds: 3600,
        }),
      }
    );
    expect(response.status).toBe(401);
  });

  it('returns 401, not 500, when heartbeat callback token is expired', async () => {
    const beforeErrors = await countPlatformErrorsForNode(NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${expiredNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cpuPercent: 50,
          memoryPercent: 60,
          diskPercent: 30,
          uptimeSeconds: 3600,
        }),
      }
    );

    expect(response.status).toBe(401);
    expect(response.status).not.toBe(500);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
    expect(await countPlatformErrorsForNode(NODE_ID)).toBe(beforeErrors);
  });

  it('returns 410 for deleted node heartbeat and does not mark the node healthy', async () => {
    const beforeErrors = await countPlatformErrorsForNode(DELETED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${DELETED_NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deletedNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cpuPercent: 50,
          memoryPercent: 60,
          diskPercent: 30,
          uptimeSeconds: 3600,
        }),
      }
    );

    expect(response.status).toBe(410);
    expect(await countPlatformErrorsForNode(DELETED_NODE_ID)).toBe(beforeErrors);
    const node = await env.DATABASE.prepare(
      'SELECT status, health_status, last_heartbeat_at FROM nodes WHERE id = ?'
    )
      .bind(DELETED_NODE_ID)
      .first<{ status: string; health_status: string; last_heartbeat_at: string | null }>();
    expect(node).toEqual({
      status: 'deleted',
      health_status: 'unhealthy',
      last_heartbeat_at: DELETED_NODE_LAST_HEARTBEAT,
    });
  });

  it('returns 410 for stopped node heartbeat and does not mark the node healthy', async () => {
    const beforeErrors = await countPlatformErrorsForNode(STOPPED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${STOPPED_NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stoppedNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cpuPercent: 50,
          memoryPercent: 60,
          diskPercent: 30,
          uptimeSeconds: 3600,
        }),
      }
    );

    expect(response.status).toBe(410);
    expect(await countPlatformErrorsForNode(STOPPED_NODE_ID)).toBe(beforeErrors);
    const node = await env.DATABASE.prepare(
      'SELECT status, health_status, last_heartbeat_at FROM nodes WHERE id = ?'
    )
      .bind(STOPPED_NODE_ID)
      .first<{ status: string; health_status: string; last_heartbeat_at: string | null }>();
    expect(node).toEqual({
      status: 'stopped',
      health_status: 'unhealthy',
      last_heartbeat_at: STOPPED_NODE_LAST_HEARTBEAT,
    });
  });
});

// =============================================================================
// Workspace resolution
// =============================================================================

describe('workspace resolution', () => {
  it('returns 204 for non-existent workspace messages to stop old-agent outbox retries', async () => {
    const fakeToken = await signCallbackToken('nonexistent-ws', env as any);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/nonexistent-ws/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fakeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              messageId: 'test-msg',
              sessionId: 'test-sess',
              role: 'assistant',
              content: 'test',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }
    );
    expect(response.status).toBe(204);
  });
});

// =============================================================================
// Node ready endpoint
// =============================================================================

describe('node ready callback', () => {
  it('accepts ready callback with node token', async () => {
    const response = await SELF.fetch(`https://api.test.example.com/api/nodes/${NODE_ID}/ready`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${nodeCallbackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ip: '1.2.3.4',
      }),
    });
    // Node is already 'running', so ready callback may return 200 or
    // a status-based error — but should NOT return 401 (auth) or 500 (crash)
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
  });

  it('returns 410 for deleted node ready callback and leaves node tombstoned', async () => {
    const beforeErrors = await countPlatformErrorsForNode(DELETED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${DELETED_NODE_ID}/ready`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deletedNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ip: '1.2.3.4' }),
      }
    );

    expect(response.status).toBe(410);
    expect(await countPlatformErrorsForNode(DELETED_NODE_ID)).toBe(beforeErrors);
    const node = await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
      .bind(DELETED_NODE_ID)
      .first<{ status: string }>();
    expect(node?.status).toBe('deleted');
  });

  it('returns 410 for deleted node origin CA callback before certificate issuance', async () => {
    const beforeErrors = await countPlatformErrorsForNode(DELETED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${DELETED_NODE_ID}/origin-ca-certificate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deletedNodeCallbackToken}`,
          'Content-Type': 'text/plain',
        },
        body: '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----',
      }
    );

    expect(response.status).toBe(410);
    expect(await countPlatformErrorsForNode(DELETED_NODE_ID)).toBe(beforeErrors);
  });

  it('returns 410 for deleted node diagnostic error callback without persisting platform errors', async () => {
    const beforeErrors = await countPlatformErrorsForNode(DELETED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${DELETED_NODE_ID}/errors`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deletedNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          errors: [
            {
              level: 'error',
              message: 'late error after node deletion',
              source: 'vm-agent',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }
    );

    expect(response.status).toBe(410);
    expect(await countPlatformErrorsForNode(DELETED_NODE_ID)).toBe(beforeErrors);
  });
});

// =============================================================================
// Node-level ACP heartbeat (callback JWT auth, NOT BetterAuth session)
// =============================================================================

describe('node-level ACP heartbeat auth', () => {
  it('accepts workspace-scoped callback token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workspaceCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    // 204 = success (heartbeat accepted). The DO may not find active sessions
    // but the auth + routing should succeed.
    expect(response.status).toBe(204);
  });

  it('accepts node-scoped callback token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    expect(response.status).toBe(204);
  });

  it('accepts node-scoped callback token when the project has mixed active and inactive workspaces on the node', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    expect(response.status).toBe(204);
  });

  it('returns 401 without any token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    expect(response.status).toBe(401);
  });

  it('returns 401, not a server fault, with a malformed callback token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer invalid-token-value',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'UNAUTHORIZED', message: 'Invalid or expired callback token' });
    expect(body.requestId).toBeUndefined();
  });

  it('returns 401, not 500, when node-level ACP heartbeat token is expired', async () => {
    const beforeErrors = await countPlatformErrorsForNode(NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${expiredNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );

    expect(response.status).toBe(401);
    expect(response.status).not.toBe(500);
    expect(await countPlatformErrorsForNode(NODE_ID)).toBe(beforeErrors);
  });

  it('returns 410 for node-level ACP heartbeat from a deleted node', async () => {
    const beforeErrors = await countPlatformErrorsForNode(DELETED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deletedNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: DELETED_NODE_ID }),
      }
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: 'GONE' });
    expect(await countPlatformErrorsForNode(DELETED_NODE_ID)).toBe(beforeErrors);
  });

  it('returns 410 for node-level ACP heartbeat from a stopped node', async () => {
    const beforeErrors = await countPlatformErrorsForNode(STOPPED_NODE_ID);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stoppedNodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: STOPPED_NODE_ID }),
      }
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: 'GONE' });
    expect(await countPlatformErrorsForNode(STOPPED_NODE_ID)).toBe(beforeErrors);
  });

  it('does NOT require BetterAuth session cookie', async () => {
    // This is the critical regression test: the old endpoint was behind requireAuth()
    // which only validates BetterAuth session cookies. The VM agent sends callback JWTs,
    // not session cookies — so every heartbeat got 401'd silently.
    // This test proves the fix works: a valid callback JWT is sufficient.
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workspaceCallbackToken}`,
          'Content-Type': 'application/json',
          // No Cookie header — no BetterAuth session
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    expect(response.status).toBe(204);
  });
});

// =============================================================================
// Contract test: VM agent heartbeat request format matches API expectations
// =============================================================================

describe('ACP heartbeat contract', () => {
  it('accepts the exact request format the VM agent sends', async () => {
    // This mirrors the request format in acp_heartbeat.go:sendAcpHeartbeatForProject()
    // which sends: POST /api/projects/:id/node-acp-heartbeat
    // with body: {"nodeId": "<nodeId>"}
    // and header: Authorization: Bearer <callback-token>
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: NODE_ID }),
      }
    );
    expect(response.status).toBe(204);
  });

  it('rejects request missing nodeId field', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${PROJECT_ID}/node-acp-heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );
    // Schema validation should reject missing nodeId
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
