import { readFileSync } from 'node:fs';

import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { hmacToken } from '../../../src/routes/api-tokens';
import { connectorMcpRoutes, createConnectorServer } from '../../../src/routes/connector-mcp';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const oauthActor = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../src/services/connector-oauth', () => ({
  authenticateConnectorOAuth: async () => oauthActor.value,
}));
const token = 'sam_pat_connector-test-canary';
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  recordActivityEvent: vi.fn(async () => 'activity'),
}));
let sqlite: Database.Database;
let env: Env;
const app = new Hono<{ Bindings: Env }>();
app.route('/connect/mcp', connectorMcpRoutes);
app.onError((error, c) =>
  c.json(
    { error: error instanceof AppError ? error.code : 'internal' },
    error instanceof AppError ? (error.statusCode as 403) : 500
  )
);
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const fetcher: typeof fetch = (input, init) => app.fetch(new Request(input, init), env, execution);
async function rpc(method: string, params: unknown = {}, bearer = token) {
  const res = await fetcher('https://api.test.example.com/connect/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith('event:')
    ? JSON.parse(text.split('\ndata: ')[1]!.trim())
    : text
      ? JSON.parse(text)
      : null;
  return { res, json };
}
beforeEach(async () => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectMembers,
    schema.tasks,
    schema.sessionSummaries,
    schema.platformSettings,
    schema.apiTokens,
  ]);
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0191_connector_execution.sql', import.meta.url),
      'utf8'
    )
  );
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0189_cli_operation_receipts.sql', import.meta.url),
      'utf8'
    )
  );
  sqlite.exec(
    "INSERT INTO users(id,status) VALUES ('owner','active'),('other','active'); INSERT INTO projects(id,name) VALUES ('mine','My Project'),('theirs','Hidden Project'); INSERT INTO project_members(project_id,user_id,role,status) VALUES ('mine','owner','owner','active'),('theirs','other','owner','active');"
  );
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'test.example.com',
    ENCRYPTION_KEY: 'test-only-encryption-key',
  } as Env;
  sqlite
    .prepare('INSERT INTO smoke_test_tokens(id,user_id,token_hash,name) VALUES (?,?,?,?)')
    .run('pat', 'owner', await hmacToken(token, env.ENCRYPTION_KEY), 'Test');
  oauthActor.value = null;
});
afterEach(() => sqlite.close());
describe('Connector real MCP protocol and PAT authorization', () => {
  it('constructs every operation schema', () => {
    expect(() =>
      createConnectorServer(
        {
          env,
          actor: { userId: 'owner', via: 'pat', scopes: new Set(['sam.read', 'sam.write']) },
          requestId: 'test',
        },
        true
      )
    ).not.toThrow();
  });
  it('real SDK client initializes, lists all 18 annotated tools and reads only current memberships', async () => {
    const client = new Client({ name: 'conformance', version: '1' });
    const transport = new StreamableHTTPClientTransport(
      new URL('https://api.test.example.com/connect/mcp'),
      { fetch: fetcher, requestInit: { headers: { Authorization: `Bearer ${token}` } } }
    );
    await client.connect(transport);
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(18);
    for (const tool of catalog.tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    expect(
      catalog.tools.find((t) => t.name === 'sam_agent_answer')?.annotations?.destructiveHint
    ).toBe(true);
    const result = await client.callTool({ name: 'sam_projects_list', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('My Project');
    expect(JSON.stringify(result)).not.toContain('Hidden Project');
    sqlite.exec("DELETE FROM project_members WHERE user_id='owner'");
    const revoked = await client.callTool({ name: 'sam_projects_list', arguments: {} });
    expect(JSON.stringify(revoked)).not.toContain('My Project');
    await client.close();
  });
  it('bounds errors containing oversized caller-controlled values', async () => {
    const { json } = await rpc('tools/call', {
      name: 'sam_chat_read',
      arguments: {
        projectId: 'mine',
        sessionId: 'chat',
        roles: ['x'.repeat(160000)],
      },
    });
    expect(json.result.isError).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(json.result)).length).toBeLessThan(120000);
    expect(JSON.stringify(json.result)).not.toContain('x'.repeat(1000));
  });
  it('requestKey reaches the shared operation and retry cannot create two ideas', async () => {
    const params = {
      name: 'sam_idea_create',
      arguments: { projectId: 'mine', title: 'New idea', requestKey: 'retry-1' },
    };
    const first = await rpc('tools/call', params);
    expect(first.json.result.isError).not.toBe(true);
    const second = await rpc('tools/call', params);
    expect(JSON.parse(first.json.result.content[0].text)).toEqual(
      first.json.result.structuredContent
    );
    expect(second.json.result.structuredContent.data.ideaId).toBe(
      first.json.result.structuredContent.data.ideaId
    );
    expect(sqlite.prepare("SELECT count(*) AS n FROM tasks WHERE title='New idea'").get()).toEqual({
      n: 1,
    });
    sqlite.exec("DELETE FROM project_members WHERE user_id='owner'");
    const revoked = await rpc('tools/call', params);
    expect(revoked.json.result.isError).toBe(true);
  });
  it('real modern SDK uses the pinned 2026 stateless protocol', async () => {
    const client = new ModernClient(
      { name: 'modern-conformance', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const transport = new ModernTransport(new URL('https://api.test.example.com/connect/mcp'), {
      fetch: fetcher,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(18);
    const result = await client.callTool({ name: 'sam_projects_list', arguments: {} });
    expect(JSON.stringify(result)).toContain('My Project');
    await client.close();
  });
  it('PAT revocation and user suspension affect the next request', async () => {
    expect((await rpc('tools/list')).res.status).toBe(200);
    sqlite.exec("UPDATE users SET status='suspended' WHERE id='owner'");
    expect((await rpc('tools/list')).res.status).toBe(401);
    sqlite.exec(
      "UPDATE users SET status='active' WHERE id='owner'; UPDATE smoke_test_tokens SET revoked_at=1 WHERE id='pat'"
    );
    const { res } = await rpc('tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource/connect/mcp'
    );
  });
  it('catalog is stable across scopes and scope failure is an HTTP challenge', async () => {
    const full = await rpc('tools/list');
    oauthActor.value = { userId: 'owner', via: 'connector', scopes: new Set(['sam.read']) };
    expect((await rpc('tools/list', {}, 'oauth-test')).json.result.tools).toEqual(
      full.json.result.tools
    );
    const denied = await rpc(
      'tools/call',
      { name: 'sam_idea_create', arguments: { projectId: 'mine', title: 'Idea' } },
      'oauth-test'
    );
    expect(denied.res.status).toBe(403);
    expect(denied.res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });
  it('disabled installation rejects tokens; write switch hides writes installation-wide', async () => {
    sqlite.exec(
      `INSERT INTO platform_settings(key,value) VALUES ('connector.writeEnabled','false')`
    );
    const { json } = await rpc('tools/list');
    expect(json.result.tools).toHaveLength(12);
    const disabled = await rpc('tools/call', {
      name: 'sam_idea_create',
      arguments: { projectId: 'mine', title: 'Not created' },
    });
    expect(disabled.res.status).toBe(200);
    expect(disabled.res.headers.get('www-authenticate')).toBeNull();
    expect(disabled.json.result).toMatchObject({ isError: true });
    expect(disabled.json.result.content[0].text).toContain('disabled by the administrator');
    sqlite.exec(`INSERT INTO platform_settings(key,value) VALUES ('connector.enabled','false')`);
    expect((await rpc('tools/list')).res.status).toBe(403);
  });
});
