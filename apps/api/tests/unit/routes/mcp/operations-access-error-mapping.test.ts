/**
 * A gated Operations tool that lets `requireOperationsAccess` throw must reach the agent as a
 * JSON-RPC INVALID_PARAMS error carrying the denial reason, not as INTERNAL_ERROR. PR2/PR3
 * tools rely on this mapping in the MCP dispatcher (`routes/mcp/index.ts`).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../../src/env';
import { mcpRoutes } from '../../../../src/routes/mcp';
import { seedActiveMcpWorkspace } from '../../../helpers/mcp-route';
import { createMemoryKv, createSqliteD1 } from '../../../helpers/sqlite-d1';

vi.mock('../../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stand-in for a sibling read tool: gate first, exactly as every gated handler must.
vi.mock('../../../../src/routes/mcp/operations-tools', async () => {
  const { requireOperationsAccess } = await import('../../../../src/services/operations-access');
  return {
    handleOpsGetAccessStatus: async (
      requestId: string | number | null,
      _args: unknown,
      tokenData: { projectId: string; taskId: string; userId: string },
      env: Env
    ) => {
      await requireOperationsAccess(env, tokenData, { capability: 'read' });
      return { jsonrpc: '2.0', id: requestId, result: { content: [] } };
    },
  };
});

describe('MCP dispatcher OperationsAccessError mapping', () => {
  it('returns INVALID_PARAMS with the denial reason for a non-Operations project', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(
      'CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)'
    );
    const env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      PLATFORM_FEEDBACK_PROJECT_ID: 'ops-project',
    } as Env;
    await env.KV.put(
      'mcp:t',
      JSON.stringify({
        projectId: 'other-project',
        taskId: 'task-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt: new Date().toISOString(),
      })
    );
    seedActiveMcpWorkspace(sqlite, {
      workspaceId: 'ws-1',
      userId: 'user-1',
      projectId: 'other-project',
    });

    const res = await mcpRoutes.request(
      '/',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'ops_get_access_status', arguments: {} },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32602,
        message: 'Operations tools are available only inside the Operations project',
        data: { reason: 'not_operations_project', capability: 'read' },
      },
    });
    sqlite.close();
  });
});
