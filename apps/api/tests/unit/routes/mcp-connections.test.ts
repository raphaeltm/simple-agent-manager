/**
 * Route-level authorization matrix for MCP server endpoints.
 *
 * These routes store third-party credentials, so the capability split is the security
 * boundary. The sibling runtime-route suites mock `project-auth` wholesale, which only proves
 * the route *calls* an authorization function — it cannot catch a swapped capability
 * argument. Here the REAL `requireProjectAccess`/`requireProjectCapability` run against a REAL
 * SQLite engine holding real `projects` / `project_members` rows, so the predicate itself is
 * under test (rule 28: a guard that is a SQL predicate needs a real SQL engine).
 *
 * Every rejection case is paired with an owner-path control, because "the write was rejected"
 * is equally satisfied by the endpoint being broken outright.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { openMcpConnectionHeaders } from '../../../src/services/mcp-connection-headers';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let currentUserId = 'owner-user';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => currentUserId,
}));

const { projectMcpConnectionRoutes, userMcpConnectionRoutes } =
  await import('../../../src/routes/mcp-connections');
const { handleAppError } = await import('../../../src/middleware/app-error-handler');

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

let sqlite: Database.Database;

function makeApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route('/api/mcp-connections', userMcpConnectionRoutes);
  app.route('/api/projects/:projectId/mcp-connections', projectMcpConnectionRoutes);
  return app;
}

function env(overrides: Record<string, string> = {}) {
  return { DATABASE: createSqliteD1(sqlite), ENCRYPTION_KEY, ...overrides } as unknown as Record<
    string,
    unknown
  >;
}

function seedProject(projectId: string, ownerId: string) {
  sqlite
    .prepare('INSERT INTO projects (id, user_id, name, repository) VALUES (?, ?, ?, ?)')
    .run(projectId, ownerId, 'Test Project', 'org/repo');
}

function seedMember(projectId: string, userId: string, role: string, status = 'active') {
  // Composite (project_id, user_id) primary key — no surrogate id column.
  sqlite
    .prepare('INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, ?, ?)')
    .run(projectId, userId, role, status);
}

const VALID_BODY = {
  name: 'zapier',
  url: 'https://mcp.zapier.com/api/mcp/s/abc',
  authType: 'bearer',
  token: 'secret-token',
};

async function request(
  path: string,
  init?: { method?: string; body?: unknown; env?: Record<string, string> }
): Promise<Response> {
  return makeApp().request(
    path,
    {
      method: init?.method ?? 'GET',
      ...(init?.body
        ? { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } }
        : {}),
    },
    env(init?.env)
  );
}

beforeEach(() => {
  currentUserId = 'owner-user';
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.mcpConnections, schema.projects, schema.projectMembers]);
  seedProject('proj-1', 'owner-user');
  seedMember('proj-1', 'owner-user', 'owner');
  seedMember('proj-1', 'admin-user', 'admin');
  seedMember('proj-1', 'maintainer-user', 'maintainer');
  seedMember('proj-1', 'viewer-user', 'viewer');
});

describe('project-scoped routes — capability matrix', () => {
  // secret:write is owner/admin only. maintainer deliberately has secret:READ but not write,
  // because a connection stores a credential every member's agents will then use.
  it.each([
    ['owner', 'owner-user', 201],
    ['admin', 'admin-user', 201],
    ['maintainer', 'maintainer-user', 403],
    ['viewer', 'viewer-user', 403],
  ])('POST as %s → %i', async (_role, userId, expected) => {
    currentUserId = userId;
    const res = await request('/api/projects/proj-1/mcp-connections', {
      method: 'POST',
      body: VALID_BODY,
    });
    expect(res.status).toBe(expected);
  });

  it.each([
    ['owner', 'owner-user'],
    ['admin', 'admin-user'],
    ['maintainer', 'maintainer-user'],
    ['viewer', 'viewer-user'],
  ])('GET as %s → 200 (every active member may read the list)', async (_role, userId) => {
    currentUserId = userId;
    const res = await request('/api/projects/proj-1/mcp-connections');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('a non-member gets 404, and the project existence is not disclosed', async () => {
    currentUserId = 'stranger';
    const res = await request('/api/projects/proj-1/mcp-connections');
    expect(res.status).toBe(404);
  });

  it('an inactive member is treated as a non-member', async () => {
    seedMember('proj-1', 'removed-user', 'owner', 'removed');
    currentUserId = 'removed-user';
    const res = await request('/api/projects/proj-1/mcp-connections');
    expect(res.status).toBe(404);
  });

  it('a rejected write persists nothing', async () => {
    currentUserId = 'maintainer-user';
    await request('/api/projects/proj-1/mcp-connections', { method: 'POST', body: VALID_BODY });
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('PATCH and DELETE enforce the same capability split', async () => {
    currentUserId = 'owner-user';
    const created = await request('/api/projects/proj-1/mcp-connections', {
      method: 'POST',
      body: VALID_BODY,
    });
    const { id } = (await created.json()) as { id: string };

    currentUserId = 'maintainer-user';
    expect(
      (
        await request(`/api/projects/proj-1/mcp-connections/${id}`, {
          method: 'PATCH',
          body: { enabled: false },
        })
      ).status
    ).toBe(403);
    expect(
      (await request(`/api/projects/proj-1/mcp-connections/${id}`, { method: 'DELETE' })).status
    ).toBe(403);

    // Owner control: the endpoints work, so the 403s above are the guard and not breakage.
    currentUserId = 'owner-user';
    expect(
      (
        await request(`/api/projects/proj-1/mcp-connections/${id}`, {
          method: 'PATCH',
          body: { enabled: false },
        })
      ).status
    ).toBe(200);
    expect(
      (await request(`/api/projects/proj-1/mcp-connections/${id}`, { method: 'DELETE' })).status
    ).toBe(200);
  });
});

describe('cross-scope addressing over HTTP', () => {
  it('cannot reach a project row through the personal endpoint', async () => {
    currentUserId = 'owner-user';
    const created = await request('/api/projects/proj-1/mcp-connections', {
      method: 'POST',
      body: VALID_BODY,
    });
    const { id } = (await created.json()) as { id: string };

    const res = await request(`/api/mcp-connections/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);

    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('cannot reach another project row through a project the caller does belong to', async () => {
    seedProject('proj-2', 'other-owner');
    seedMember('proj-2', 'other-owner', 'owner');

    currentUserId = 'other-owner';
    const created = await request('/api/projects/proj-2/mcp-connections', {
      method: 'POST',
      body: VALID_BODY,
    });
    const { id } = (await created.json()) as { id: string };

    currentUserId = 'owner-user';
    const res = await request(`/api/projects/proj-1/mcp-connections/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);

    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});

describe('personal-scope routes', () => {
  it('binds to the caller and never exposes another user rows', async () => {
    currentUserId = 'user-a';
    await request('/api/mcp-connections', { method: 'POST', body: VALID_BODY });

    currentUserId = 'user-b';
    const res = await request('/api/mcp-connections');
    expect(await res.json()).toEqual({ items: [] });

    currentUserId = 'user-a';
    const mine = await request('/api/mcp-connections');
    expect(((await mine.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('never returns the url or the token over the wire', async () => {
    currentUserId = 'user-a';
    const created = await request('/api/mcp-connections', { method: 'POST', body: VALID_BODY });
    const raw = await created.text();

    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('/api/mcp/s/abc');
    expect(JSON.parse(raw)).toMatchObject({
      name: 'zapier',
      urlHost: 'https://mcp.zapier.com',
      hasToken: true,
    });
  });

  it('rejects a malformed body with 400, not a 500', async () => {
    currentUserId = 'user-a';
    const res = await request('/api/mcp-connections', {
      method: 'POST',
      body: { name: 123, url: [] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects the reserved sam-mcp name with 400', async () => {
    currentUserId = 'user-a';
    const res = await request('/api/mcp-connections', {
      method: 'POST',
      body: { ...VALID_BODY, name: 'sam-mcp' },
    });
    expect(res.status).toBe(400);
  });
});

describe('custom headers over HTTP', () => {
  const API_KEY = 'ak_route_secret';
  const COMPOSIO_BODY = {
    name: 'composio',
    url: 'https://backend.composio.dev/v3/mcp/server-1',
    authType: 'none',
    headers: [{ name: 'x-api-key', value: API_KEY }],
  };

  async function storedHeaders(id: string) {
    const row = sqlite
      .prepare(
        'SELECT encrypted_headers AS encryptedHeaders, headers_iv AS headersIv FROM mcp_connections WHERE id = ?'
      )
      .get(id) as { encryptedHeaders: string | null; headersIv: string | null };
    return openMcpConnectionHeaders(row, ENCRYPTION_KEY);
  }

  it('stores header values encrypted and returns only their names', async () => {
    currentUserId = 'user-a';
    const created = await request('/api/mcp-connections', { method: 'POST', body: COMPOSIO_BODY });
    const raw = await created.text();

    expect(created.status).toBe(201);
    expect(raw).not.toContain(API_KEY);
    const { id, headerNames } = JSON.parse(raw) as { id: string; headerNames: string[] };
    expect(headerNames).toEqual(['x-api-key']);

    const listed = await (await request('/api/mcp-connections')).text();
    expect(listed).not.toContain(API_KEY);
    expect(JSON.parse(listed)).toMatchObject({ items: [{ id, headerNames: ['x-api-key'] }] });

    expect(await storedHeaders(id)).toEqual([{ name: 'x-api-key', value: API_KEY }]);
    const ciphertext = sqlite
      .prepare('SELECT encrypted_headers FROM mcp_connections')
      .pluck()
      .get();
    expect(String(ciphertext)).not.toContain(API_KEY);
  });

  it('PATCH keeps a value sent without one and adds a new header', async () => {
    currentUserId = 'owner-user';
    const created = await request('/api/projects/proj-1/mcp-connections', {
      method: 'POST',
      body: COMPOSIO_BODY,
    });
    const { id } = (await created.json()) as { id: string };

    const patched = await request(`/api/projects/proj-1/mcp-connections/${id}`, {
      method: 'PATCH',
      body: { headers: [{ name: 'x-api-key' }, { name: 'x-org-id', value: 'org-42' }] },
    });

    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { headerNames: string[] }).headerNames).toEqual([
      'x-api-key',
      'x-org-id',
    ]);
    expect(await storedHeaders(id)).toEqual([
      { name: 'x-api-key', value: API_KEY },
      { name: 'x-org-id', value: 'org-42' },
    ]);
  });

  it('requires a value for every header on create', async () => {
    currentUserId = 'user-a';
    const res = await request('/api/mcp-connections', {
      method: 'POST',
      body: { ...COMPOSIO_BODY, headers: [{ name: 'x-api-key' }] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an Authorization header on a bearer server with 400', async () => {
    currentUserId = 'user-a';
    const res = await request('/api/mcp-connections', {
      method: 'POST',
      body: { ...VALID_BODY, headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }] },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/conflicts with the bearer token/);
  });

  it('applies MAX_MCP_CONNECTION_HEADERS from the environment on create and update', async () => {
    currentUserId = 'user-a';
    const limitEnv = { MAX_MCP_CONNECTION_HEADERS: '1' };
    const twoHeaders = [
      { name: 'x-api-key', value: API_KEY },
      { name: 'x-org-id', value: 'org-42' },
    ];

    const tooMany = await request('/api/mcp-connections', {
      method: 'POST',
      body: { ...COMPOSIO_BODY, headers: twoHeaders },
      env: limitEnv,
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.text()).toMatch(/Maximum 1 headers/);

    // Control: one header fits the same limit, so the 400 above is the limit and not breakage.
    const fits = await request('/api/mcp-connections', {
      method: 'POST',
      body: COMPOSIO_BODY,
      env: limitEnv,
    });
    expect(fits.status).toBe(201);
    const { id } = (await fits.json()) as { id: string };

    const grow = await request(`/api/mcp-connections/${id}`, {
      method: 'PATCH',
      body: { headers: [{ name: 'x-api-key' }, { name: 'x-org-id', value: 'org-42' }] },
      env: limitEnv,
    });
    expect(grow.status).toBe(400);
    expect(await storedHeaders(id)).toEqual([{ name: 'x-api-key', value: API_KEY }]);
  });

  it('applies MCP_CONNECTION_HEADER_VALUE_MAX_BYTES from the environment, in bytes', async () => {
    currentUserId = 'user-a';
    const limitEnv = { MCP_CONNECTION_HEADER_VALUE_MAX_BYTES: '8' };

    // Five characters, ten bytes.
    const tooBig = await request('/api/mcp-connections', {
      method: 'POST',
      body: { ...COMPOSIO_BODY, headers: [{ name: 'x-api-key', value: 'ééééé' }] },
      env: limitEnv,
    });
    expect(tooBig.status).toBe(400);
    const message = await tooBig.text();
    expect(message).toMatch(/exceeds max size of 8 bytes/);
    expect(message).not.toContain('ééééé');

    const fits = await request('/api/mcp-connections', {
      method: 'POST',
      body: { ...COMPOSIO_BODY, headers: [{ name: 'x-api-key', value: 'abcdefgh' }] },
      env: limitEnv,
    });
    expect(fits.status).toBe(201);
  });
});
