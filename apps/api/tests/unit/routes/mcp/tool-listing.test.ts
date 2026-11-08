/**
 * tools/list and ops_get_access_status through the real MCP route: a real KV token, real
 * SQLite D1, the production settings resolver and the real feedback-project resolution.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../../src/db/schema';
import type { Env } from '../../../../src/env';
import { mcpRoutes } from '../../../../src/routes/mcp';
import { INCIDENT_TOOLS, OPERATIONS_TOOLS } from '../../../../src/routes/mcp/tool-definitions';
import { OPERATIONS_TOOL_HANDLERS } from '../../../../src/routes/mcp/tool-handler-table';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../../src/services/admin-settings';
import type { OperationsToolsMode } from '../../../../src/services/operations-access';
import { __resetPlatformConfigCacheForTest } from '../../../../src/services/platform-config';
import { createAdminSettingsEnv } from '../../../helpers/admin-settings-env';
import { applySqliteMigration, createSchemaTables } from '../../../helpers/sqlite-d1';

// These tool tests run on a mock D1 that has no workspace/node rows. MCP authentication's
// workspace-lifecycle gate is exercised against real SQL in
// tests/unit/services/mcp-token-lifecycle.test.ts; here it reduces to KV token validation.
vi.mock('../../../../src/services/mcp-token-lifecycle', async () => {
  const { validateMcpToken } = await import('../../../../src/services/mcp-token');
  return {
    validateActiveWorkspaceMcpToken: (env: { KV: KVNamespace }, token: string) =>
      validateMcpToken(env.KV, token, env),
  };
});

vi.mock('../../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OPS_PROJECT = 'ops-project';
const INCIDENT_NAMES = INCIDENT_TOOLS.map((tool) => tool.name);
const OPS_NAMES = OPERATIONS_TOOLS.map((tool) => tool.name);

let sqlite: Database.Database;
let env: Env;

async function mintToken(token: string, data: Record<string, string>) {
  await env.KV.put(
    `mcp:${token}`,
    JSON.stringify({ workspaceId: 'ws-1', createdAt: new Date().toISOString(), ...data })
  );
}

async function rpc(token: string, method: string, params?: Record<string, unknown>) {
  const res = await mcpRoutes.request(
    '/',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    env
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { tools?: { name: string }[]; content?: { text: string }[] };
    error?: { code: number; message: string; data?: unknown };
  };
}

async function listedNames(token: string) {
  const body = await rpc(token, 'tools/list');
  const names = (body.result?.tools ?? []).map((tool) => tool.name);
  // Liveness: the ordinary catalogue is always present, so an empty list cannot pass.
  expect(names).toContain('get_instructions');
  return names;
}

async function setMode(mode: OperationsToolsMode) {
  await updateAdminSettings(env, {
    actorUserId: 'superadmin',
    changes: [{ name: 'operations.debuggerTools', value: mode }],
  });
}

async function callAccessStatus(token: string) {
  const body = await rpc(token, 'tools/call', { name: 'ops_get_access_status', arguments: {} });
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
    operationsProject: boolean;
    mode?: string;
    capabilities: { read: boolean; act: boolean };
    denials: Record<string, { reason: string }>;
  };
}

beforeEach(async () => {
  __resetAdminSettingsCacheForTest();
  __resetPlatformConfigCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv({ PLATFORM_FEEDBACK_PROJECT_ID: OPS_PROJECT }));
  createSchemaTables(sqlite, [schema.users, schema.tasks]);
  applySqliteMigration(
    sqlite,
    new URL('../../../../src/db/migrations/0217_operations_audit_log.sql', import.meta.url)
  );
  const user = sqlite.prepare('INSERT INTO users (id, email, role, status) VALUES (?, ?, ?, ?)');
  user.run('superadmin', 'root@example.com', 'superadmin', 'active');
  user.run('member', 'member@example.com', 'user', 'active');
  const task = sqlite.prepare('INSERT INTO tasks (id, project_id, user_id) VALUES (?, ?, ?)');
  task.run('task-ops-admin', OPS_PROJECT, 'superadmin');
  task.run('task-ops-member', OPS_PROJECT, 'member');
  task.run('task-other', 'other-project', 'superadmin');
  await mintToken('ops-admin', {
    projectId: OPS_PROJECT,
    taskId: 'task-ops-admin',
    userId: 'superadmin',
  });
  await mintToken('ops-member', {
    projectId: OPS_PROJECT,
    taskId: 'task-ops-member',
    userId: 'member',
  });
  await mintToken('other', {
    projectId: 'other-project',
    taskId: 'task-other',
    userId: 'superadmin',
  });
});

afterEach(() => {
  sqlite.close();
});

describe('OPERATIONS_TOOLS registration', () => {
  it('has exactly one handler per definition', () => {
    expect([...OPERATIONS_TOOL_HANDLERS.keys()].sort()).toEqual([...OPS_NAMES].sort());
  });
});

describe('tools/list per project and mode', () => {
  it('hides incident and Operations tools from every other project in every mode', async () => {
    for (const mode of ['off', 'read', 'read_ask', 'read_auto_safe'] as const) {
      await setMode(mode);
      const names = await listedNames('other');
      for (const name of [...INCIDENT_NAMES, ...OPS_NAMES]) expect(names).not.toContain(name);
    }
  });

  it('lists incident tools but not Operations tools to the Operations project while off', async () => {
    const names = await listedNames('ops-admin');
    for (const name of INCIDENT_NAMES) expect(names).toContain(name);
    for (const name of OPS_NAMES) expect(names).not.toContain(name);
  });

  it('lists Operations tools to the Operations project once the mode is not off', async () => {
    for (const mode of ['read', 'read_ask', 'read_auto_safe'] as const) {
      await setMode(mode);
      const names = await listedNames('ops-admin');
      for (const name of [...INCIDENT_NAMES, ...OPS_NAMES]) expect(names).toContain(name);
    }
  });

  it('follows a runtime change of the Operations project', async () => {
    sqlite
      .prepare(
        "INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('feedback.projectId', ?, ?, 'superadmin')"
      )
      .run('other-project', new Date().toISOString());
    // A runtime save invalidates the cache through the platform-config writer; this direct
    // write stands in for another isolate, so model its cache expiring.
    __resetPlatformConfigCacheForTest();
    expect(await listedNames('ops-admin')).not.toContain(INCIDENT_NAMES[0]);
    expect(await listedNames('other')).toContain(INCIDENT_NAMES[0]);
  });

  it('keeps tools/list working, without Operations-only groups, when the setting read fails', async () => {
    // The env fallback still names ops-project, so only the failure path can hide the groups.
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    env = {
      ...env,
      DATABASE: {
        ...env.DATABASE,
        withSession: env.DATABASE.withSession.bind(env.DATABASE),
        prepare: (sql: string) => {
          // readSetting's query (configuredFeedbackProjectId), not the rate-limit activation read.
          if (sql.includes('updated_by AS updatedBy FROM platform_settings WHERE key = ?'))
            throw new Error('D1 unavailable');
          return prepare(sql);
        },
      } as D1Database,
    };
    const names = await listedNames('ops-admin');
    for (const name of [...INCIDENT_NAMES, ...OPS_NAMES]) expect(names).not.toContain(name);
  });
});

describe('ops_get_access_status through the route', () => {
  it('reports full access for a superadmin-owned Operations task and audits the call', async () => {
    await setMode('read_ask');
    expect(await callAccessStatus('ops-admin')).toEqual({
      operationsProject: true,
      mode: 'read_ask',
      capabilities: { read: true, act: true },
      denials: {},
    });
    expect(
      sqlite.prepare('SELECT actor_user_id, task_id, tool, outcome FROM operations_audit_log').all()
    ).toEqual([
      {
        actor_user_id: 'superadmin',
        task_id: 'task-ops-admin',
        tool: 'ops_get_access_status',
        outcome: 'allowed',
      },
    ]);
  });

  it('denies a non-superadmin Operations member and records the denied attempt', async () => {
    await setMode('read_ask');
    const status = await callAccessStatus('ops-member');
    expect(status.capabilities).toEqual({ read: false, act: false });
    expect(status.denials.read?.reason).toBe('not_superadmin');
    expect(sqlite.prepare('SELECT outcome FROM operations_audit_log').all()).toEqual([
      { outcome: 'denied' },
    ]);
  });

  it('still answers when the audit write fails', async () => {
    await setMode('read');
    sqlite.exec('DROP TABLE operations_audit_log');
    const status = await callAccessStatus('ops-admin');
    expect(status.capabilities).toEqual({ read: true, act: false });
  });

  it('denies another project without revealing the mode or writing an audit row', async () => {
    await setMode('read_ask');
    const status = await callAccessStatus('other');
    expect(status.operationsProject).toBe(false);
    expect(status.denials.read?.reason).toBe('not_operations_project');
    expect(status).not.toHaveProperty('mode');
    expect(sqlite.prepare('SELECT count(*) AS n FROM operations_audit_log').get()).toEqual({
      n: 0,
    });
  });
});
