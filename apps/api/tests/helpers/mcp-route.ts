/**
 * Drive the real workspace MCP route (`POST /mcp`, JSON-RPC `tools/call`) in a test.
 * Pair with `createSqliteD1` so tool handlers run their real SQL.
 */
import type Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { expect } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createSchemaTables } from './sqlite-d1';

export interface McpToolResponse {
  result?: { content: Array<{ text: string }> };
  error?: { code: number; message: string };
}

/** In-memory KV that honours both read forms the route uses: `'json'` and `{ type: 'json' }`. */
export function createJsonKv(): KVNamespace {
  const values = new Map<string, string>();
  const wantsJson = (type: unknown) =>
    type === 'json' || (typeof type === 'object' && type !== null && 'type' in type);
  return {
    get: async (key: string, type?: unknown) => {
      const value = values.get(key) ?? null;
      return value !== null && wantsJson(type) ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}

/** Store a workspace MCP token the way token issuance does. */
export async function storeMcpToken(
  kv: KVNamespace,
  token: string,
  data: { taskId: string; projectId: string; userId: string; workspaceId: string }
): Promise<void> {
  await kv.put(`mcp:${token}`, JSON.stringify({ ...data, createdAt: new Date().toISOString() }));
}

export async function createMcpApp(): Promise<Hono> {
  const { mcpRoutes } = await import('../../src/routes/mcp');
  const app = new Hono();
  app.route('/mcp', mcpRoutes);
  return app;
}

export async function postMcp(
  app: Hono,
  env: Env,
  token: string,
  method: string,
  params?: Record<string, unknown>
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const res = await app.request(
    '/mcp',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    },
    env
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
}

export async function callMcpTool(
  app: Hono,
  env: Env,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResponse> {
  return (await postMcp(app, env, token, 'tools/call', {
    name,
    arguments: args,
  })) as McpToolResponse;
}

/** Parse a successful tool call's JSON text payload. */
export function toolResult<T>(response: McpToolResponse): T {
  expect(response.error).toBeUndefined();
  return JSON.parse(response.result?.content[0]?.text ?? '{}') as T;
}

/**
 * Make the workspace an MCP token names authorize it, the way a live agent session's
 * workspace does: present, owned by the token's user and project, and on a running node
 * (`validateActiveWorkspaceMcpToken`). Creates the `nodes`/`workspaces` tables when a
 * narrow fixture omitted them. A workspace row the test already seeded keeps its status,
 * so a test of an inactive workspace still sees that status; only a missing node is filled.
 * Pass `nodeId` to reuse a node the fixture already has (installation-wide listings).
 */
export function seedActiveMcpWorkspace(
  sqlite: Database.Database,
  data: { workspaceId: string; userId: string; projectId: string; nodeId?: string }
): void {
  const existing = new Set(
    (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name)
  );
  createSchemaTables(
    sqlite,
    [schema.nodes, schema.workspaces].filter((table) => !existing.has(getTableConfig(table).name))
  );
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, project_id, node_id, status)
       VALUES (?, ?, ?, ?, 'running')
       ON CONFLICT(id) DO UPDATE SET node_id = COALESCE(workspaces.node_id, excluded.node_id)`
    )
    .run(data.workspaceId, data.userId, data.projectId, data.nodeId ?? `${data.workspaceId}-node`);
  const { nodeId } = sqlite
    .prepare(`SELECT node_id AS nodeId FROM workspaces WHERE id = ?`)
    .get(data.workspaceId) as { nodeId: string };
  sqlite
    .prepare(`INSERT OR IGNORE INTO nodes (id, user_id, status) VALUES (?, ?, 'running')`)
    .run(nodeId, data.userId);
}
