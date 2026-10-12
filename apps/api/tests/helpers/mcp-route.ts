/**
 * Drive the real workspace MCP route (`POST /mcp`, JSON-RPC `tools/call`) in a test.
 * Pair with `createSqliteD1` so tool handlers run their real SQL.
 */
import { Hono } from 'hono';
import { expect } from 'vitest';

import type { Env } from '../../src/env';

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
