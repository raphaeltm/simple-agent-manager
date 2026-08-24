/**
 * CRUD + resolution tests for bring-your-own MCP servers.
 *
 * Every scoping guard here is a SQL predicate, so these run against a real in-memory SQLite
 * engine rather than a `.where()`-ignoring mock — a chainable stub would pass identically with
 * the predicate deleted (rule 28).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  createMcpConnection,
  deleteMcpConnection,
  listMcpConnections,
  updateMcpConnection,
} from '../../../src/services/mcp-connections';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

// 32 random bytes, base64 — the shape getCredentialEncryptionKey returns.
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const LIMITS = { maxPerScope: 25, urlMaxBytes: 2048, tokenMaxBytes: 8192 };

type Db = ReturnType<typeof drizzle<typeof schema>>;

let sqlite: Database.Database;
let db: Db;

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.mcpConnections]);
  db = drizzle(createSqliteD1(sqlite), { schema });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    projectId: null as string | null,
    name: 'zapier',
    url: 'https://mcp.zapier.com/api/mcp/s/abc123',
    authType: 'bearer' as const,
    token: 'secret-token',
    enabled: true,
    limits: LIMITS,
    encryptionKey: ENCRYPTION_KEY,
    ...overrides,
  };
}

describe('createMcpConnection', () => {
  it('never returns the url or the token', async () => {
    const created = await createMcpConnection(db, baseInput());

    // Pre-signed MCP URLs embed the credential in the path/query, so the full URL is a
    // secret; only scheme+host may be echoed back.
    expect(created).not.toHaveProperty('url');
    expect(created).not.toHaveProperty('token');
    expect(created.urlHost).toBe('https://mcp.zapier.com');
    expect(JSON.stringify(created)).not.toContain('abc123');
    expect(JSON.stringify(created)).not.toContain('secret-token');
    expect(created.hasToken).toBe(true);
  });

  it('encrypts both the url and the token at rest', async () => {
    await createMcpConnection(db, baseInput());

    const row = sqlite.prepare('SELECT * FROM mcp_connections').get() as Record<string, string>;
    expect(row.encrypted_url).not.toContain('zapier.com');
    expect(row.encrypted_url).not.toContain('abc123');
    expect(row.encrypted_token).not.toContain('secret-token');
    expect(row.url_iv).toBeTruthy();
    expect(row.token_iv).toBeTruthy();
    // The display host is deliberately plaintext — it is not a credential.
    expect(row.url_host).toBe('https://mcp.zapier.com');
  });

  it('rejects the reserved sam-mcp name', async () => {
    await expect(createMcpConnection(db, baseInput({ name: 'sam-mcp' }))).rejects.toThrow(
      /reserved/i
    );
  });

  it.each([
    ['uppercase is normalized', 'Zapier', 'zapier'],
    ['whitespace is trimmed', '  zapier  ', 'zapier'],
  ])('%s', async (_label, input, expected) => {
    const created = await createMcpConnection(db, baseInput({ name: input }));
    expect(created.name).toBe(expected);
  });

  it.each([
    'has space',
    'has.dot',
    'has/slash',
    '-leading',
    'trailing-',
    'a'.repeat(33),
    '',
  ])('rejects unsafe name %j', async (name) => {
    await expect(createMcpConnection(db, baseInput({ name }))).rejects.toThrow();
  });

  it.each([
    ['plain http on a public host', 'http://evil.example.com/mcp'],
    ['not a url', 'not-a-url'],
    ['newline injection', 'https://a.example/mcp\nurl = "https://evil"'],
  ])('rejects %s', async (_label, url) => {
    await expect(createMcpConnection(db, baseInput({ url }))).rejects.toThrow();
  });

  it('allows http only for loopback (self-hosted gateway on the same box)', async () => {
    const created = await createMcpConnection(
      db,
      baseInput({ url: 'http://localhost:4788/mcp', name: 'executor' })
    );
    expect(created.urlHost).toBe('http://localhost:4788');
  });

  it('requires a token when authType is bearer', async () => {
    await expect(createMcpConnection(db, baseInput({ token: null }))).rejects.toThrow(/token/i);
  });

  it('stores no token when authType is none', async () => {
    const created = await createMcpConnection(
      db,
      baseInput({ authType: 'none', token: null, name: 'composio' })
    );
    expect(created.hasToken).toBe(false);

    const row = sqlite.prepare('SELECT * FROM mcp_connections').get() as Record<string, unknown>;
    expect(row.encrypted_token).toBeNull();
    expect(row.token_iv).toBeNull();
  });

  it('enforces the per-scope limit', async () => {
    const limits = { ...LIMITS, maxPerScope: 2 };
    await createMcpConnection(db, baseInput({ name: 'one', limits }));
    await createMcpConnection(db, baseInput({ name: 'two', limits }));
    await expect(createMcpConnection(db, baseInput({ name: 'three', limits }))).rejects.toThrow(
      /Maximum 2/
    );
  });

  it('rejects a duplicate name within a scope but allows it across scopes', async () => {
    await createMcpConnection(db, baseInput());
    await expect(createMcpConnection(db, baseInput())).rejects.toThrow(/already exists/i);

    // Same name is fine in a different scope: personal vs project, and per-project.
    await expect(
      createMcpConnection(db, baseInput({ projectId: 'proj-1' }))
    ).resolves.toBeDefined();
    await expect(
      createMcpConnection(db, baseInput({ projectId: 'proj-2' }))
    ).resolves.toBeDefined();
    // A different user's personal scope is also independent.
    await expect(
      createMcpConnection(db, baseInput({ userId: 'user-2' }))
    ).resolves.toBeDefined();
  });
});

describe('scope isolation', () => {
  it('never lists another tenant rows', async () => {
    await createMcpConnection(db, baseInput({ userId: 'user-1', name: 'mine' }));
    await createMcpConnection(db, baseInput({ userId: 'user-2', name: 'theirs' }));
    await createMcpConnection(db, baseInput({ projectId: 'proj-1', name: 'proj-one' }));
    await createMcpConnection(db, baseInput({ projectId: 'proj-2', name: 'proj-two' }));

    const personal = await listMcpConnections(db, { userId: 'user-1', projectId: null });
    expect(personal.map((c) => c.name)).toEqual(['mine']);

    const projectOne = await listMcpConnections(db, { userId: 'user-1', projectId: 'proj-1' });
    expect(projectOne.map((c) => c.name)).toEqual(['proj-one']);
  });

  it('rejects cross-scope update by id, and mutates nothing', async () => {
    const victim = await createMcpConnection(
      db,
      baseInput({ projectId: 'proj-victim', name: 'victim' })
    );

    // A real id from scope A, addressed through scope B.
    await expect(
      updateMcpConnection(db, {
        userId: 'attacker',
        projectId: 'proj-attacker',
        connectionId: victim.id,
        enabled: false,
        limits: LIMITS,
        encryptionKey: ENCRYPTION_KEY,
      })
    ).rejects.toThrow();

    const row = sqlite
      .prepare('SELECT enabled FROM mcp_connections WHERE id = ?')
      .get(victim.id) as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('rejects cross-scope delete by id, and deletes nothing', async () => {
    const victim = await createMcpConnection(
      db,
      baseInput({ projectId: 'proj-victim', name: 'victim' })
    );

    await expect(
      deleteMcpConnection(db, { userId: 'attacker', projectId: 'proj-attacker' }, victim.id)
    ).rejects.toThrow();

    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('rejects addressing a project row through personal scope', async () => {
    const projectRow = await createMcpConnection(
      db,
      baseInput({ projectId: 'proj-1', name: 'shared' })
    );

    await expect(
      deleteMcpConnection(db, { userId: 'user-1', projectId: null }, projectRow.id)
    ).rejects.toThrow();
  });

  // Owner-path control. Without this, every rejection above is also satisfied by the
  // endpoints being broken outright (rule 28).
  it('the legitimate owner CAN update and delete', async () => {
    const mine = await createMcpConnection(db, baseInput({ projectId: 'proj-1', name: 'mine' }));

    const updated = await updateMcpConnection(db, {
      userId: 'user-1',
      projectId: 'proj-1',
      connectionId: mine.id,
      enabled: false,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });
    expect(updated.enabled).toBe(false);

    await deleteMcpConnection(db, { userId: 'user-1', projectId: 'proj-1' }, mine.id);
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get() as { n: number };
    expect(count.n).toBe(0);
  });

  // Project rows are shared project resources: any member's session must see them, not only
  // the member who created them.
  it('a project row created by one member is visible to another member', async () => {
    await createMcpConnection(db, baseInput({ userId: 'creator', projectId: 'proj-1', name: 'shared' }));

    const asOtherMember = await listMcpConnections(db, {
      userId: 'other-member',
      projectId: 'proj-1',
    });
    expect(asOtherMember.map((c) => c.name)).toEqual(['shared']);
  });
});

describe('updateMcpConnection', () => {
  it('toggles enabled without requiring the secret to be re-sent', async () => {
    const created = await createMcpConnection(db, baseInput());
    const before = sqlite
      .prepare('SELECT encrypted_token FROM mcp_connections WHERE id = ?')
      .get(created.id) as { encrypted_token: string };

    const updated = await updateMcpConnection(db, {
      userId: 'user-1',
      projectId: null,
      connectionId: created.id,
      enabled: false,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(updated.enabled).toBe(false);
    expect(updated.hasToken).toBe(true);
    const after = sqlite
      .prepare('SELECT encrypted_token FROM mcp_connections WHERE id = ?')
      .get(created.id) as { encrypted_token: string };
    expect(after.encrypted_token).toBe(before.encrypted_token);
  });

  it('drops the stored secret when switching to authType none', async () => {
    const created = await createMcpConnection(db, baseInput());

    const updated = await updateMcpConnection(db, {
      userId: 'user-1',
      projectId: null,
      connectionId: created.id,
      authType: 'none',
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(updated.hasToken).toBe(false);
    const row = sqlite
      .prepare('SELECT encrypted_token, token_iv FROM mcp_connections WHERE id = ?')
      .get(created.id) as Record<string, unknown>;
    expect(row.encrypted_token).toBeNull();
    expect(row.token_iv).toBeNull();
  });

  it('refuses to switch none -> bearer without a token, leaving an unusable row', async () => {
    const created = await createMcpConnection(
      db,
      baseInput({ authType: 'none', token: null, name: 'composio' })
    );

    await expect(
      updateMcpConnection(db, {
        userId: 'user-1',
        projectId: null,
        connectionId: created.id,
        authType: 'bearer',
        limits: LIMITS,
        encryptionKey: ENCRYPTION_KEY,
      })
    ).rejects.toThrow(/token/i);
  });

  it('rejects renaming onto an existing name in the same scope', async () => {
    await createMcpConnection(db, baseInput({ name: 'first' }));
    const second = await createMcpConnection(db, baseInput({ name: 'second' }));

    await expect(
      updateMcpConnection(db, {
        userId: 'user-1',
        projectId: null,
        connectionId: second.id,
        name: 'first',
        limits: LIMITS,
        encryptionKey: ENCRYPTION_KEY,
      })
    ).rejects.toThrow(/already exists/i);
  });
});
