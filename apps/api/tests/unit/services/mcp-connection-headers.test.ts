/**
 * Custom HTTP headers on bring-your-own MCP servers.
 *
 * Runs against a real in-memory SQLite engine so every read-back is the stored bytes, not a
 * mock's echo of what was written (rule 28). Values are secrets: several tests assert they never
 * appear in a response, a plaintext column or an error message.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { openMcpConnectionHeaders } from '../../../src/services/mcp-connection-headers';
import {
  createMcpConnection,
  listMcpConnections,
  updateMcpConnection,
} from '../../../src/services/mcp-connections';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const LIMITS = {
  maxPerScope: 25,
  urlMaxBytes: 2048,
  tokenMaxBytes: 8192,
  maxHeaders: 4,
  headerValueMaxBytes: 64,
};
const API_KEY = 'ak_live_composio_secret';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let sqlite: Database.Database;
let db: Db;

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.mcpConnections]);
  db = drizzle(createSqliteD1(sqlite), { schema });
});

function createComposio(overrides: Record<string, unknown> = {}) {
  return createMcpConnection(db, {
    userId: 'user-1',
    projectId: null,
    name: 'composio',
    url: 'https://backend.composio.dev/v3/mcp/server-1',
    authType: 'none',
    token: null,
    headers: [{ name: 'x-api-key', value: API_KEY }],
    enabled: true,
    limits: LIMITS,
    encryptionKey: ENCRYPTION_KEY,
    ...overrides,
  });
}

function update(connectionId: string, changes: Record<string, unknown>) {
  return updateMcpConnection(db, {
    userId: 'user-1',
    projectId: null,
    connectionId,
    limits: LIMITS,
    encryptionKey: ENCRYPTION_KEY,
    ...changes,
  });
}

function storedRow(id: string) {
  return sqlite.prepare('SELECT * FROM mcp_connections WHERE id = ?').get(id) as Record<
    string,
    string | null
  >;
}

async function storedHeaders(id: string) {
  const row = storedRow(id);
  return openMcpConnectionHeaders(
    { encryptedHeaders: row.encrypted_headers, headersIv: row.headers_iv },
    ENCRYPTION_KEY
  );
}

describe('creating a connection with custom headers', () => {
  it('returns header names but never values, and encrypts the values at rest', async () => {
    const created = await createComposio({
      headers: [
        { name: ' x-api-key ', value: `  ${API_KEY}  ` },
        { name: 'X-Org_Id', value: 'org-42' },
      ],
    });

    expect(created.headerNames).toEqual(['x-api-key', 'X-Org_Id']);
    expect(JSON.stringify(created)).not.toContain(API_KEY);
    expect(JSON.stringify(created)).not.toContain('org-42');

    const row = storedRow(created.id);
    expect(row.header_names).toBe('["x-api-key","X-Org_Id"]');
    expect(row.encrypted_headers).not.toContain(API_KEY);
    expect(row.headers_iv).toBeTruthy();
    // Names and values are trimmed before they are sealed.
    expect(await storedHeaders(created.id)).toEqual([
      { name: 'x-api-key', value: API_KEY },
      { name: 'X-Org_Id', value: 'org-42' },
    ]);
  });

  it('stores nothing when no headers are given, exactly like a pre-headers row', async () => {
    const created = await createComposio({ headers: undefined });

    expect(created.headerNames).toEqual([]);
    const row = storedRow(created.id);
    expect(row.header_names).toBe('[]');
    expect(row.encrypted_headers).toBeNull();
    expect(row.headers_iv).toBeNull();
  });

  it('allows a custom Authorization header when authType is none (non-Bearer schemes)', async () => {
    const created = await createComposio({
      headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }],
    });
    expect(created.headerNames).toEqual(['Authorization']);
  });

  it.each([
    [
      'a name mcp-remote cannot parse',
      [{ name: 'x:api-key', value: API_KEY }],
      /Invalid header name/,
    ],
    ['a name with a dot', [{ name: 'x.api.key', value: API_KEY }], /Invalid header name/],
    [
      'a name over 64 characters',
      [{ name: 'x'.repeat(65), value: API_KEY }],
      /Invalid header name/,
    ],
    [
      'a transport-managed header',
      [{ name: 'Content-Type', value: 'text/plain' }],
      /set by the MCP transport/,
    ],
    [
      'a reserved header in any case',
      [{ name: 'MCP-SESSION-ID', value: 'abc' }],
      /set by the MCP transport/,
    ],
    [
      'a duplicate name differing only in case',
      [
        { name: 'x-api-key', value: API_KEY },
        { name: 'X-API-KEY', value: API_KEY },
      ],
      /more than once/,
    ],
    ['an empty value', [{ name: 'x-api-key', value: '   ' }], /needs a value/],
    [
      'a value with a line break',
      [{ name: 'x-api-key', value: `${API_KEY}\nX-Evil: 1` }],
      /control characters/,
    ],
    [
      'a value with a tab',
      [{ name: 'x-api-key', value: `${API_KEY}\t` + 'x' }],
      /control characters/,
    ],
    [
      'a value over the byte limit',
      [{ name: 'x-api-key', value: 'v'.repeat(65) }],
      /exceeds max size of 64 bytes/,
    ],
    [
      'more headers than the limit',
      ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, value: 'v' })),
      /Maximum 4 headers/,
    ],
  ])('rejects %s, without echoing any value', async (_label, headers, message) => {
    const attempt = createComposio({ headers });
    await expect(attempt).rejects.toThrow(message);
    await expect(attempt).rejects.not.toThrow(new RegExp(API_KEY));
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get()).toEqual({ n: 0 });
  });

  it('rejects an Authorization header alongside a bearer token', async () => {
    await expect(
      createComposio({
        authType: 'bearer',
        token: 'bearer-token',
        headers: [{ name: 'authorization', value: 'Bearer other' }],
      })
    ).rejects.toThrow(/conflicts with the bearer token/);
  });
});

describe('updating headers', () => {
  it('keeps a stored value when an entry omits it, while adding a new header', async () => {
    const created = await createComposio();

    const updated = await update(created.id, {
      headers: [{ name: 'x-api-key' }, { name: 'x-org-id', value: 'org-42' }],
    });

    expect(updated.headerNames).toEqual(['x-api-key', 'x-org-id']);
    expect(await storedHeaders(created.id)).toEqual([
      { name: 'x-api-key', value: API_KEY },
      { name: 'x-org-id', value: 'org-42' },
    ]);
  });

  it('matches kept headers case-insensitively and adopts the new spelling', async () => {
    const created = await createComposio();

    const updated = await update(created.id, { headers: [{ name: 'X-API-Key' }] });

    expect(updated.headerNames).toEqual(['X-API-Key']);
    expect(await storedHeaders(created.id)).toEqual([{ name: 'X-API-Key', value: API_KEY }]);
  });

  it('rotates a value, removes an omitted header, and clears all with an empty list', async () => {
    const created = await createComposio({
      headers: [
        { name: 'x-api-key', value: API_KEY },
        { name: 'x-org-id', value: 'org-42' },
      ],
    });

    await update(created.id, { headers: [{ name: 'x-api-key', value: 'ak_rotated' }] });
    expect(await storedHeaders(created.id)).toEqual([{ name: 'x-api-key', value: 'ak_rotated' }]);

    const cleared = await update(created.id, { headers: [] });
    expect(cleared.headerNames).toEqual([]);
    const row = storedRow(created.id);
    expect(row.header_names).toBe('[]');
    expect(row.encrypted_headers).toBeNull();
    expect(row.headers_iv).toBeNull();
  });

  it('refuses to keep a value that was never stored', async () => {
    const created = await createComposio();

    await expect(update(created.id, { headers: [{ name: 'x-new-header' }] })).rejects.toThrow(
      /"x-new-header" needs a value/
    );
    expect(await storedHeaders(created.id)).toEqual([{ name: 'x-api-key', value: API_KEY }]);
  });

  it('leaves headers byte-for-byte untouched when an update does not mention them', async () => {
    const created = await createComposio();
    const before = storedRow(created.id);

    const updated = await update(created.id, { enabled: false });

    expect(updated.enabled).toBe(false);
    expect(updated.headerNames).toEqual(['x-api-key']);
    const after = storedRow(created.id);
    expect(after.encrypted_headers).toBe(before.encrypted_headers);
    expect(after.headers_iv).toBe(before.headers_iv);
  });

  it('refuses to switch to bearer while an Authorization header is stored', async () => {
    const created = await createComposio({
      headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }],
    });

    await expect(update(created.id, { authType: 'bearer', token: 'bearer-token' })).rejects.toThrow(
      /conflicts with the bearer token/
    );
    expect(storedRow(created.id).auth_type).toBe('none');

    // Control: the same switch succeeds once the request drops the conflicting header.
    const switched = await update(created.id, {
      authType: 'bearer',
      token: 'bearer-token',
      headers: [],
    });
    expect(switched.authType).toBe('bearer');
    expect(switched.headerNames).toEqual([]);
  });

  it('asks for every value when the stored headers cannot be decrypted, and accepts a full replacement', async () => {
    const created = await createComposio();
    sqlite
      .prepare('UPDATE mcp_connections SET encrypted_headers = ? WHERE id = ?')
      .run('garbage', created.id);

    await expect(update(created.id, { headers: [{ name: 'x-api-key' }] })).rejects.toThrow(
      /cannot be read; send every header with its value/
    );

    await update(created.id, { headers: [{ name: 'x-api-key', value: 'ak_replacement' }] });
    expect(await storedHeaders(created.id)).toEqual([
      { name: 'x-api-key', value: 'ak_replacement' },
    ]);
  });
});

describe('listing connections with headers', () => {
  // Rule 50: one malformed display column must not take down the whole list.
  it('shows a row with an unreadable header_names column as having no names', async () => {
    const broken = await createComposio({ name: 'broken' });
    await createComposio({ name: 'healthy' });
    sqlite
      .prepare('UPDATE mcp_connections SET header_names = ? WHERE id = ?')
      .run('not json', broken.id);

    const listed = await listMcpConnections(db, { userId: 'user-1', projectId: null });

    expect(listed.map((c) => [c.name, c.headerNames])).toEqual([
      ['broken', []],
      ['healthy', ['x-api-key']],
    ]);
  });
});
