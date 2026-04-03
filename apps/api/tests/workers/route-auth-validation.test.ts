/**
 * Worker integration tests for route authentication and validation.
 *
 * Replaces source-contract tests in tests/unit/routes/ that verified
 * route existence and auth requirements by reading source code as strings.
 * These tests exercise the actual Hono routes in the workerd runtime
 * with real Miniflare bindings.
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';

const TEST_PREFIX = `auth-val-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;
const PROJECT_ID = `${TEST_PREFIX}-proj`;
const NODE_ID = `${TEST_PREFIX}-node`;
const WORKSPACE_ID = `${TEST_PREFIX}-ws`;
const SESSION_ID = `${TEST_PREFIX}-sess`;

beforeAll(async () => {
  // Seed test user
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, github_username, display_name, avatar_url, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', 'approved', datetime('now'), datetime('now'))`,
  )
    .bind(USER_ID, 888888, 'test-user-auth', 'Auth Test User', 'https://example.com/a.png')
    .run();

  // Seed test project
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, github_repo, github_owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(PROJECT_ID, USER_ID, 'auth-test-project', 'test-repo', 'test-owner')
    .run();

  // Seed test node
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes (id, user_id, name, status, provider, vm_location, vm_type, created_at, updated_at)
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
});

// =============================================================================
// User-authenticated routes require auth
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
    const token = await signCallbackToken(WORKSPACE_ID, env as any);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              messageId: `${TEST_PREFIX}-msg-1`,
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
    const token = await signNodeCallbackToken(NODE_ID, env as any);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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
    // Should succeed or at least not return auth error
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
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
// Message validation
// =============================================================================

describe('message validation', () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await signCallbackToken(WORKSPACE_ID, env as any);
  });

  it('rejects empty messages array', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: [] }),
      },
    );
    expect(response.status).toBe(400);
  });

  it('rejects invalid message role', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              messageId: `${TEST_PREFIX}-invalid-role`,
              sessionId: SESSION_ID,
              role: 'invalid-role',
              content: 'test',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(400);
  });

  it('rejects messages targeting different sessions', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              messageId: `${TEST_PREFIX}-msg-a`,
              sessionId: SESSION_ID,
              role: 'assistant',
              content: 'test',
              timestamp: new Date().toISOString(),
            },
            {
              messageId: `${TEST_PREFIX}-msg-b`,
              sessionId: 'different-session',
              role: 'assistant',
              content: 'test',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ message: string }>();
    expect(body.message).toContain('same sessionId');
  });

  it('rejects messages with mismatched session ID', async () => {
    const response = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WORKSPACE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              messageId: `${TEST_PREFIX}-mismatch`,
              sessionId: 'wrong-session-id',
              role: 'assistant',
              content: 'test',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ message: string }>();
    expect(body.message).toContain('Session mismatch');
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
    const token = await signNodeCallbackToken(NODE_ID, env as any);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/ready`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ip: '1.2.3.4',
        }),
      },
    );
    // The node is already 'running', so this may return 200 or a status-based error
    // but should NOT return 401 (auth) or 500 (crash)
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
  });
});
