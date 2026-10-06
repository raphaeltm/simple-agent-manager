/**
 * Vertical slice for custom MCP headers: a connection saved through the real write path,
 * resolved through the real session-start composition, then used against a real HTTP MCP
 * server that — like Composio — authenticates with an `x-api-key` header and no bearer token.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { McpServerEntry } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { log } from '../../../src/lib/logger';
import {
  buildSessionMcpServers,
  resolveMcpServersForSession,
} from '../../../src/services/mcp-connection-resolution';
import { createMcpConnection } from '../../../src/services/mcp-connections';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
const LIMITS = {
  maxPerScope: 25,
  urlMaxBytes: 2048,
  tokenMaxBytes: 8192,
  maxHeaders: 10,
  headerValueMaxBytes: 8192,
};
const API_KEY = 'ak_live_composio_secret';

type Db = ReturnType<typeof drizzle<typeof schema>>;

interface ApiKeyMcpServer {
  url: string;
  seen: IncomingHttpHeaders[];
  close: () => Promise<void>;
}

/** Answers MCP JSON-RPC only when `x-api-key` matches, the way Composio's endpoint does. */
async function startApiKeyMcpServer(apiKey: string): Promise<ApiKeyMcpServer> {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid x-api-key' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body || '{}') as { id?: number; method?: string };
      const result =
        request.method === 'tools/list'
          ? { tools: [{ name: 'GMAIL_SEND_EMAIL', inputSchema: { type: 'object' } }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'composio-mock' },
            };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? 1, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

/** Sends one JSON-RPC call exactly the way a harness would, using only what SAM injected. */
async function callAsHarness(entry: McpServerEntry, method: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (entry.token) {
    headers.Authorization = `Bearer ${entry.token}`;
  }
  for (const header of entry.headers ?? []) {
    headers[header.name] = header.value;
  }
  const response = await fetch(entry.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { result?: { tools?: Array<{ name: string }> } },
  };
}

let sqlite: Database.Database;
let db: Db;
let mcpServer: ApiKeyMcpServer;

beforeAll(async () => {
  mcpServer = await startApiKeyMcpServer(API_KEY);
});

afterAll(async () => {
  await mcpServer.close();
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.mcpConnections]);
  db = drizzle(createSqliteD1(sqlite), { schema });
});

function saveComposio(overrides: Record<string, unknown> = {}) {
  return createMcpConnection(db, {
    userId: 'user-1',
    projectId: 'proj-1',
    name: 'composio',
    url: mcpServer.url,
    authType: 'none',
    token: null,
    headers: [{ name: 'x-api-key', value: API_KEY }],
    enabled: true,
    limits: LIMITS,
    encryptionKey: ENCRYPTION_KEY,
    ...overrides,
  });
}

describe('custom headers, end to end', () => {
  it('the headers SAM injects authorize against an x-api-key MCP endpoint', async () => {
    await saveComposio();

    const servers = await buildSessionMcpServers(
      db,
      { baseDomain: 'example.com', encryptionKey: ENCRYPTION_KEY },
      { userId: 'member-2', projectId: 'proj-1' },
      'sam-session-token'
    );

    expect(servers.map((server) => server.name)).toEqual(['sam-mcp', 'composio']);
    const composio = servers[1];
    expect(composio.token).toBe('');
    expect(composio.headers).toEqual([{ name: 'x-api-key', value: API_KEY }]);
    // SAM's own entry never picks up another server's headers.
    expect(servers[0].headers).toBeUndefined();

    const initialize = await callAsHarness(composio, 'initialize');
    expect(initialize.status).toBe(200);
    const tools = await callAsHarness(composio, 'tools/list');
    expect(tools.body.result?.tools?.map((tool) => tool.name)).toEqual(['GMAIL_SEND_EMAIL']);
    expect(mcpServer.seen.at(-1)?.['x-api-key']).toBe(API_KEY);
  });

  it('the endpoint really rejects a request without the header (the check is not a formality)', async () => {
    const response = await callAsHarness(
      { url: mcpServer.url, token: '', name: 'composio' },
      'initialize'
    );
    expect(response.status).toBe(401);
  });

  it('a connection without headers resolves with no headers key, as before this feature', async () => {
    await saveComposio({ headers: undefined });

    const [entry] = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: 'proj-1' },
      ENCRYPTION_KEY
    );

    expect(entry).toEqual({ url: mcpServer.url, token: '', name: 'composio' });
  });
});

describe('header fault isolation on the session-start path', () => {
  it('skips a row whose headers cannot be decrypted, keeps the rest, and logs no secret', async () => {
    const broken = await saveComposio({ name: 'broken' });
    await saveComposio({ name: 'healthy' });
    sqlite
      .prepare('UPDATE mcp_connections SET encrypted_headers = ? WHERE id = ?')
      .run('garbage', broken.id);
    const warn = vi.spyOn(log, 'warn');

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: 'proj-1' },
      ENCRYPTION_KEY
    );

    expect(resolved.map((entry) => entry.name)).toEqual(['healthy']);
    const skipLog = warn.mock.calls.find(([event]) => event === 'mcp_connections.row_skipped');
    expect(skipLog?.[1]).toMatchObject({ connectionId: broken.id, action: 'skipped' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
    warn.mockRestore();
  });

  it('skips a row that pairs a bearer token with a custom Authorization header', async () => {
    // Writes forbid this pair, so it is built by hand: a stored Authorization header, then the
    // row flipped to bearer underneath it.
    const broken = await saveComposio({
      name: 'broken',
      headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }],
    });
    await saveComposio({ name: 'healthy' });
    const { encrypt } = await import('../../../src/services/encryption');
    const token = await encrypt('bearer-token', ENCRYPTION_KEY);
    sqlite
      .prepare(
        "UPDATE mcp_connections SET auth_type = 'bearer', encrypted_token = ?, token_iv = ? WHERE id = ?"
      )
      .run(token.ciphertext, token.iv, broken.id);

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: 'proj-1' },
      ENCRYPTION_KEY
    );

    expect(resolved.map((entry) => entry.name)).toEqual(['healthy']);
  });

  it('skips a row whose stored header would make the vm-agent reject the whole session', async () => {
    // Constructed through the real write path, then corrupted into a shape the write path
    // refuses: the resolver must hold the same line, because the vm-agent fails the entire
    // create-agent-session request over one malformed header.
    const broken = await saveComposio({ name: 'broken' });
    await saveComposio({ name: 'healthy' });
    const { encrypt } = await import('../../../src/services/encryption');
    const sealed = await encrypt(
      JSON.stringify([{ name: 'x api key', value: API_KEY }]),
      ENCRYPTION_KEY
    );
    sqlite
      .prepare('UPDATE mcp_connections SET encrypted_headers = ?, headers_iv = ? WHERE id = ?')
      .run(sealed.ciphertext, sealed.iv, broken.id);

    const resolved = await resolveMcpServersForSession(
      db,
      { userId: 'user-1', projectId: 'proj-1' },
      ENCRYPTION_KEY
    );

    expect(resolved.map((entry) => entry.name)).toEqual(['healthy']);
  });
});
