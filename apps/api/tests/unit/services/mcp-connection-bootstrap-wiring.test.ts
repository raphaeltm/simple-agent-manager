/**
 * The last hop: a connection row in D1 must survive all the way into the outbound vm-agent
 * request body.
 *
 * This test exists because review proved the rest of the suite could not see that hop. Making
 * `agent-session-bootstrap.ts` silently drop every bring-your-own entry — keeping only
 * `sam-mcp` — left all 124 MCP-related tests green. `mcp-connection-injection.test.ts` calls
 * `buildSessionMcpServers` directly, and every test that drives the real bootstrap mocks
 * `drizzle-orm/d1` with a stub whose `.where()` returns nothing, so resolution always
 * degraded to `[]` and the `sam-mcp`-only path was the only one ever asserted.
 *
 * So this drives the REAL `startSamAwareAgentSession` against a REAL SQLite engine holding a
 * REAL encrypted connection row, and asserts the decrypted entry reaches the arguments handed
 * to `createAgentSessionOnNode` / `startAgentSessionOnNode` (rule 62: enter through the real
 * trigger, never hand-feed the value under test).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const { createAgentSessionOnNodeMock, startAgentSessionOnNodeMock } = vi.hoisted(() => ({
  createAgentSessionOnNodeMock: vi.fn(async () => undefined),
  startAgentSessionOnNodeMock: vi.fn(async () => undefined),
}));

// Mock ONLY the outermost system boundary (the HTTP call to the VM). Everything between the
// entry point and that boundary — resolution, decryption, merge, composition — runs for real.
vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: createAgentSessionOnNodeMock,
  startAgentSessionOnNode: startAgentSessionOnNodeMock,
  restoreAgentSessionOnNode: vi.fn(async () => ({ status: 'restored' })),
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'sam-session-token',
  revokeMcpToken: vi.fn(async () => undefined),
  storeMcpToken: vi.fn(async () => undefined),
}));

vi.mock('../../../src/services/project-data', () => ({
  ensureAcpSession: vi.fn(async () => ({ id: 'acp-1' })),
  createAcpSession: vi.fn(async () => ({ id: 'acp-1' })),
  getAcpSession: vi.fn(async () => null),
  transitionAcpSession: vi.fn(async () => undefined),
  prepareAcpSessionForFreshStart: vi.fn(async () => ({ id: 'acp-1' })),
}));

const { startSamAwareAgentSession } = await import(
  '../../../src/services/agent-session-bootstrap'
);
const { createMcpConnection } = await import('../../../src/services/mcp-connections');

const ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
const LIMITS = { maxPerScope: 25, urlMaxBytes: 2048, tokenMaxBytes: 8192 };

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function makeEnv() {
  return {
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY,
    KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  } as unknown as Parameters<typeof startSamAwareAgentSession>[1];
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: 'node-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    label: 'Session',
    agentType: 'claude-code',
    visibleInitialPrompt: 'do the thing',
    promptKind: 'conversation' as const,
    actor: { type: 'system' as const, id: 'user-1', reasonPrefix: 'test' },
    ...overrides,
  } as Parameters<typeof startSamAwareAgentSession>[2];
}

/** The mcpServers argument is positional in both node-agent calls. */
function capturedCreateServers() {
  return createAgentSessionOnNodeMock.mock.calls[0]?.[8] as
    | Array<{ url: string; token: string; name: string }>
    | undefined;
}
function capturedStartServers() {
  return startAgentSessionOnNodeMock.mock.calls[0]?.[7] as
    | Array<{ url: string; token: string; name: string }>
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.mcpConnections, schema.agentSessions]);
  db = drizzle(createSqliteD1(sqlite), { schema });
});

describe('bring-your-own MCP servers reach the vm-agent request', () => {
  it('sends a personal connection alongside sam-mcp on BOTH the create and start calls', async () => {
    await createMcpConnection(db, {
      userId: 'user-1',
      projectId: null,
      name: 'zapier',
      url: 'https://mcp.zapier.com/api/mcp/s/abc123',
      authType: 'bearer',
      token: 'zapier-secret',
      enabled: true,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });

    await startSamAwareAgentSession(db, makeEnv(), startInput());

    for (const captured of [capturedCreateServers(), capturedStartServers()]) {
      expect(captured).toBeDefined();
      expect(captured).toEqual([
        { url: 'https://api.example.com/mcp', token: 'sam-session-token', name: 'sam-mcp' },
        {
          url: 'https://mcp.zapier.com/api/mcp/s/abc123',
          token: 'zapier-secret',
          name: 'zapier',
        },
      ]);
    }
  });

  it('sends a project-scoped connection created by a DIFFERENT member', async () => {
    // Project connections are shared project resources: the session user is not the creator.
    await createMcpConnection(db, {
      userId: 'other-member',
      projectId: 'proj-1',
      name: 'executor',
      url: 'https://executor.example/mcp',
      authType: 'bearer',
      token: 'executor-secret',
      enabled: true,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });

    await startSamAwareAgentSession(db, makeEnv(), startInput());

    expect(capturedStartServers()).toEqual([
      expect.objectContaining({ name: 'sam-mcp' }),
      expect.objectContaining({ name: 'executor', token: 'executor-secret' }),
    ]);
  });

  it('never sends another tenant connections', async () => {
    await createMcpConnection(db, {
      userId: 'victim',
      projectId: null,
      name: 'victim-personal',
      url: 'https://victim.example/mcp',
      authType: 'bearer',
      token: 'victim-secret',
      enabled: true,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });
    await createMcpConnection(db, {
      userId: 'other',
      projectId: 'proj-other',
      name: 'other-project',
      url: 'https://other.example/mcp',
      authType: 'bearer',
      token: 'other-secret',
      enabled: true,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });

    await startSamAwareAgentSession(db, makeEnv(), startInput());

    const captured = capturedStartServers();
    expect(captured?.map((s) => s.name)).toEqual(['sam-mcp']);
    expect(JSON.stringify(captured)).not.toContain('victim-secret');
    expect(JSON.stringify(captured)).not.toContain('other-secret');
  });

  it('omits a disabled connection', async () => {
    await createMcpConnection(db, {
      userId: 'user-1',
      projectId: null,
      name: 'turned-off',
      url: 'https://off.example/mcp',
      authType: 'bearer',
      token: 'off-secret',
      enabled: false,
      limits: LIMITS,
      encryptionKey: ENCRYPTION_KEY,
    });

    await startSamAwareAgentSession(db, makeEnv(), startInput());

    expect(capturedStartServers()?.map((s) => s.name)).toEqual(['sam-mcp']);
  });

  // Liveness control beside the absence assertions above (rule 62): "only sam-mcp was sent" is
  // also satisfied by the whole call never happening.
  it('always sends sam-mcp even when the user has no connections at all', async () => {
    await startSamAwareAgentSession(db, makeEnv(), startInput({ userId: 'nobody' }));

    expect(capturedStartServers()).toEqual([
      { url: 'https://api.example.com/mcp', token: 'sam-session-token', name: 'sam-mcp' },
    ]);
  });
});
