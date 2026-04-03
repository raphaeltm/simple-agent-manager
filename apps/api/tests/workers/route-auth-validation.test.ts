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
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';

// Unique IDs per test run to avoid cross-test contamination (shared D1, no isolatedStorage)
const TEST_PREFIX = `auth-val-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;
const PROJECT_ID = `${TEST_PREFIX}-proj`;
const NODE_ID = `${TEST_PREFIX}-node`;
const WORKSPACE_ID = `${TEST_PREFIX}-ws`;
const SESSION_ID = `${TEST_PREFIX}-sess`;

let workspaceCallbackToken: string;
let nodeCallbackToken: string;

beforeAll(async () => {
  // Seed test user
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, github_username, display_name, avatar_url, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', 'approved', datetime('now'), datetime('now'))`,
  )
    .bind(USER_ID, '888888', 'test-user-auth', 'Auth Test User', 'https://example.com/a.png')
    .run();

  // Seed test project
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, github_repo, github_owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(PROJECT_ID, USER_ID, 'auth-test-project', 'test-repo', 'test-owner')
    .run();

  // Seed test node (cloud_provider and vm_size are the correct column names)
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes (id, user_id, name, status, cloud_provider, vm_location, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'hetzner', 'fsn1', 'cx22', datetime('now'), datetime('now'))`,
  )
    .bind(NODE_ID, USER_ID, 'auth-test-node')
    .run();

  // Seed test workspace
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO workspaces (id, user_id, node_id, project_id, chat_session_id, name, repository, branch, status, vm_size, vm_location, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'cx22', 'fsn1', datetime('now'), datetime('now'))`,
  )
    .bind(
      WORKSPACE_ID,
      USER_ID,
      NODE_ID,
      PROJECT_ID,
      SESSION_ID,
      'auth-test-ws',
      'test-repo',
      'main',
    )
    .run();

  // Sign all tokens after seeding is complete (follows workspace-messages.test.ts pattern)
  workspaceCallbackToken = await signCallbackToken(WORKSPACE_ID, env as any);
  nodeCallbackToken = await signNodeCallbackToken(NODE_ID, env as any);
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
      },
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
      },
    );
    // Should succeed (200) since workspace, project, and session are linked
    expect(response.status).toBe(200);
  });
});

// =============================================================================
// Node callback-authenticated routes
// =============================================================================

describe('node callback auth', () => {
  it('accepts node callback token for heartbeat endpoint', async () => {
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
      },
    );
    expect(response.status).toBe(200);
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
      },
    );
    expect(response.status).toBe(401);
  });
});

// =============================================================================
// Workspace resolution
// =============================================================================

describe('workspace resolution', () => {
  it('returns 404 for non-existent workspace messages', async () => {
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
      },
    );
    expect(response.status).toBe(404);
  });
});

// =============================================================================
// Node ready endpoint
// =============================================================================

describe('node ready callback', () => {
  it('accepts ready callback with node token', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/ready`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ip: '1.2.3.4',
        }),
      },
    );
    // Node is already 'running', so ready callback may return 200 or
    // a status-based error — but should NOT return 401 (auth) or 500 (crash)
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
  });
});
