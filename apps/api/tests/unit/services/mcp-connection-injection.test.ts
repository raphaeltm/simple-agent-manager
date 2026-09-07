/**
 * Vertical slice for bring-your-own MCP server injection.
 *
 * Third-party credentials are not available in CI, so the "real" endpoint here is a mock MCP
 * server: a genuine HTTP server speaking JSON-RPC (initialize / tools/list / tools/call) with
 * bearer auth. The test seeds a connection pointing at its real URL, drives the real
 * resolution + composition path, and then proves the resolved credential actually authorizes
 * against that server. That closes the loop the way a live provider would, minus the provider.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { encrypt } from '../../../src/services/encryption';
import {
  buildSessionMcpServers,
  resolveMcpServersForSession,
} from '../../../src/services/mcp-connection-resolution';
import { createMcpConnection } from '../../../src/services/mcp-connections';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
const LIMITS = { maxPerScope: 25, urlMaxBytes: 2048, tokenMaxBytes: 8192 };
const BASE_DOMAIN = 'example.com';

type Db = ReturnType<typeof drizzle<typeof schema>>;

// ---------------------------------------------------------------------------
// Mock MCP server — a real HTTP server, not a fetch stub.
// ---------------------------------------------------------------------------

interface MockMcpServer {
  url: string;
  token: string;
  /** Every Authorization header the server saw, in order. */
  seenAuthHeaders: string[];
  close: () => Promise<void>;
}

async function startMockMcpServer(token: string): Promise<MockMcpServer> {
  const seenAuthHeaders: string[] = [];

  const server: Server = createServer((req, res) => {
    seenAuthHeaders.push(req.headers.authorization ?? '');

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body || '{}') as { id?: number; method?: string };
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-mcp', version: '1.0.0' },
            }
          : request.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'create_post',
                    description: 'Publish a post',
                    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                  },
                ],
              }
            : request.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'posted' }] }
              : {};

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? 1, result }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    // Loopback http is the one non-HTTPS form the URL validator accepts, which is exactly
    // what a self-hosted gateway (executor.sh runs on 127.0.0.1:4788) looks like.
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    seenAuthHeaders,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

async function callMockServer(
  url: string,
  token: string,
  method: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------

let sqlite: Database.Database;
let db: Db;
let mockServer: MockMcpServer;

beforeAll(async () => {
  mockServer = await startMockMcpServer('zapier-secret-token');
});

afterAll(async () => {
  await mockServer.close();
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.mcpConnections]);
  db = drizzle(createSqliteD1(sqlite), { schema });
});

function seed(overrides: Record<string, unknown> = {}) {
  return createMcpConnection(db, {
    userId: 'user-1',
    projectId: null,
    name: 'zapier',
    url: mockServer.url,
    authType: 'bearer' as const,
    token: mockServer.token,
    enabled: true,
    limits: LIMITS,
    encryptionKey: ENCRYPTION_KEY,
    ...overrides,
  });
}

describe('end-to-end injection against a live mock MCP server', () => {
  it('the credential SAM injects actually authorizes against the endpoint', async () => {
    await seed();

    const servers = await buildSessionMcpServers(
      db,
      { baseDomain: BASE_DOMAIN, encryptionKey: ENCRYPTION_KEY },
      { userId: 'user-1', projectId: 'proj-1' },
      'sam-session-token'
    );

    const zapier = servers.find((s) => s.name === 'zapier');
    expect(zapier).toBeDefined();

    // The decrypted URL and token are exactly what the agent would be handed. Drive a real
    // MCP handshake with them.
    const initialize = await callMockServer(zapier!.url, zapier!.token, 'initialize');
    expect(initialize.status).toBe(200);
    expect((initialize.body.result as Record<string, unknown>).serverInfo).toMatchObject({
      name: 'mock-mcp',
    });

    const tools = await callMockServer(zapier!.url, zapier!.token, 'tools/list');
    const toolList = (tools.body.result as { tools: Array<{ name: string }> }).tools;
    expect(toolList.map((t) => t.name)).toContain('create_post');

    const call = await callMockServer(zapier!.url, zapier!.token, 'tools/call');
    expect(call.status).toBe(200);

    expect(mockServer.seenAuthHeaders).toContain('Bearer zapier-secret-token');
  });

  it('a wrong token is rejected by the endpoint (the auth check is real)', async () => {
    const bad = await callMockServer(mockServer.url, 'not-the-token', 'initialize');
    expect(bad.status).toBe(401);
  });
});

describe('buildSessionMcpServers', () => {
  it('always puts sam-mcp first and never lets a connection displace it', async () => {
    await seed();
    await seed({ name: 'executor' });

    const servers = await buildSessionMcpServers(
      db,
      { baseDomain: BASE_DOMAIN, encryptionKey: ENCRYPTION_KEY },
      { userId: 'user-1', projectId: 'proj-1' },
      'sam-session-token'
    );

    expect(servers[0]).toEqual({
      url: `https://api.${BASE_DOMAIN}/mcp`,
      token: 'sam-session-token',
      name: 'sam-mcp',
    });
    expect(servers).toHaveLength(3);
  });

  it('returns just sam-mcp when the user has no connections', async () => {
    const servers = await buildSessionMcpServers(
      db,
      { baseDomain: BASE_DOMAIN, encryptionKey: ENCRYPTION_KEY },
      { userId: 'user-with-nothing', projectId: 'proj-1' },
      'sam-session-token'
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('sam-mcp');
  });
});

describe('resolveMcpServersForSession', () => {
  it('project-scoped connections override personal ones with the same name', async () => {
    await seed({ name: 'zapier', token: 'personal-token' });
    await seed({ projectId: 'proj-1', name: 'zapier', token: 'project-token' });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: 'proj-1' },
      ENCRYPTION_KEY
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe('zapier');
    expect(resolved[0].token).toBe('project-token');
  });

  it('excludes disabled connections', async () => {
    await seed({ name: 'on', enabled: true });
    await seed({ name: 'off', enabled: false });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: null },
      ENCRYPTION_KEY
    );
    expect(resolved.map((s) => s.name)).toEqual(['on']);
  });

  it('never resolves another user personal connections', async () => {
    await seed({ userId: 'victim', name: 'victim-conn' });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'attacker', projectId: null },
      ENCRYPTION_KEY
    );
    expect(resolved).toEqual([]);
  });

  it('never resolves connections from another project', async () => {
    await seed({ projectId: 'proj-other', name: 'other-project' });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: 'proj-mine' },
      ENCRYPTION_KEY
    );
    expect(resolved).toEqual([]);
  });

  it('resolves personal connections in every project the user works in', async () => {
    await seed({ name: 'personal' });

    for (const projectId of ['proj-a', 'proj-b', null]) {
      const resolved = await resolveMcpServersForSession(
        db,
        { userId: 'user-1', projectId },
        ENCRYPTION_KEY
      );
      expect(resolved.map((s) => s.name)).toEqual(['personal']);
    }
  });

  it('carries an empty token through for no-auth connections', async () => {
    await seed({ name: 'composio', authType: 'none', token: null });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: null },
      ENCRYPTION_KEY
    );
    expect(resolved).toEqual([
      expect.objectContaining({ name: 'composio', token: '' }),
    ]);
  });
});

describe('row fault isolation', () => {
  /**
   * Resolution runs on the agent-session start path. A single unreadable row must not take
   * session start down for the whole tenant (rules 41, 50) — the blast radius of the
   * alternative is every session for that user or project.
   */
  async function seedRawRow(row: Partial<schema.McpConnectionRow> & { id: string; name: string }) {
    const url = await encrypt('https://good.example/mcp', ENCRYPTION_KEY);
    sqlite
      .prepare(
        `INSERT INTO mcp_connections
         (id, user_id, project_id, name, encrypted_url, url_iv, url_host, auth_type,
          encrypted_token, token_iv, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.userId ?? 'user-1',
        row.projectId ?? null,
        row.name,
        row.encryptedUrl ?? url.ciphertext,
        row.urlIv ?? url.iv,
        row.urlHost ?? 'https://good.example',
        row.authType ?? 'none',
        row.encryptedToken ?? null,
        row.tokenIv ?? null,
        row.enabled === false ? 0 : 1,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
  }

  it('skips an undecryptable row and still returns the good ones', async () => {
    await seedRawRow({ id: 'a', name: 'good-first' });
    await seedRawRow({ id: 'b', name: 'corrupt', encryptedUrl: 'not-valid-base64-ciphertext' });
    await seedRawRow({ id: 'c', name: 'good-last' });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: null },
      ENCRYPTION_KEY
    );

    expect(resolved.map((s) => s.name)).toEqual(['good-first', 'good-last']);
  });

  it('skips a bearer row whose token is missing rather than injecting an unauthenticated server', async () => {
    // Silently downgrading to no-auth would send the agent at a third-party endpoint with no
    // credential, which is a different (and worse) behaviour than omitting it.
    await seedRawRow({ id: 'a', name: 'good' });
    await seedRawRow({ id: 'b', name: 'broken-bearer', authType: 'bearer' });

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: null },
      ENCRYPTION_KEY
    );
    expect(resolved.map((s) => s.name)).toEqual(['good']);
  });

  it('returns an empty list rather than throwing when every row is unreadable', async () => {
    await seedRawRow({ id: 'a', name: 'bad-one', encryptedUrl: 'garbage' });
    await seedRawRow({ id: 'b', name: 'bad-two', encryptedUrl: 'garbage' });

    await expect(
      resolveMcpServersForSession(db, { userId: 'user-1', projectId: null }, ENCRYPTION_KEY)
    ).resolves.toEqual([]);
  });

  it('a broken connection still lets the session start with sam-mcp', async () => {
    await seedRawRow({ id: 'a', name: 'corrupt', encryptedUrl: 'garbage' });

    const servers = await buildSessionMcpServers(
      db,
      { baseDomain: BASE_DOMAIN, encryptionKey: ENCRYPTION_KEY },
      { userId: 'user-1', projectId: 'proj-1' },
      'sam-session-token'
    );
    expect(servers.map((s) => s.name)).toEqual(['sam-mcp']);
  });
});
