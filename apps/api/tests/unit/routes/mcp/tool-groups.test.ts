/**
 * Domain tool groups (tool-groups.ts) through the real MCP route: a real KV token, real
 * SQLite D1 and the real handlers behind each group method.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../../src/db/schema';
import type { Env } from '../../../../src/env';
import { mcpRoutes } from '../../../../src/routes/mcp';
import { MCP_SERVER_INSTRUCTIONS } from '../../../../src/routes/mcp/server-instructions';
import { LISTED_MCP_TOOLS, TASK_REQUIRED_TOOLS } from '../../../../src/routes/mcp/tool-catalog';
import { MCP_TOOLS } from '../../../../src/routes/mcp/tool-definitions';
import { resolveGroupedToolCall } from '../../../../src/routes/mcp/tool-group-dispatch';
import {
  buildGroupDefinition,
  indexGroupMembers,
} from '../../../../src/routes/mcp/tool-group-schema';
import { MCP_TOOL_GROUPS } from '../../../../src/routes/mcp/tool-groups';
import { __resetAdminSettingsCacheForTest } from '../../../../src/services/admin-settings';
import { __resetPlatformConfigCacheForTest } from '../../../../src/services/platform-config';
import { createAdminSettingsEnv } from '../../../helpers/admin-settings-env';
import { createSchemaTables } from '../../../helpers/sqlite-d1';

vi.mock('../../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PROJECT = 'proj-groups';
const MEMBER_NAMES = MCP_TOOL_GROUPS.flatMap((group) =>
  Object.values(group.methods).map((method) => method.tool)
);

let sqlite: Database.Database;
let env: Env;

type RpcBody = {
  result?: {
    tools?: Array<{ name: string; annotations?: Record<string, boolean> }>;
    content?: { text: string }[];
    instructions?: string;
  };
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

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
  return (await res.json()) as RpcBody;
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  return rpc(token, 'tools/call', { name, arguments: args });
}

function resultJson(body: RpcBody): Record<string, unknown> {
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return JSON.parse(body.result?.content?.[0]?.text ?? 'null') as Record<string, unknown>;
}

async function listed(token: string) {
  const body = await rpc(token, 'tools/list');
  const tools = body.result?.tools ?? [];
  // Liveness: the ordinary catalogue is always present, so an empty list cannot pass.
  expect(tools.map((tool) => tool.name)).toContain('get_instructions');
  return tools;
}

beforeEach(async () => {
  __resetAdminSettingsCacheForTest();
  __resetPlatformConfigCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv({ PLATFORM_FEEDBACK_PROJECT_ID: 'ops-project' }));
  createSchemaTables(sqlite, [schema.users, schema.projects, schema.projectMembers, schema.tasks]);
  sqlite
    .prepare('INSERT INTO users (id, email, role, status) VALUES (?, ?, ?, ?)')
    .run('owner', 'owner@example.com', 'user', 'active');
  sqlite
    .prepare(
      'INSERT INTO projects (id, user_id, name, normalized_name, repository, installation_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(PROJECT, 'owner', 'Groups', 'groups', 'owner/groups', 'inst-1');
  sqlite
    .prepare('INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, ?, ?)')
    .run(PROJECT, 'owner', 'owner', 'active');
  const task = sqlite.prepare(
    'INSERT INTO tasks (id, project_id, user_id, title, description, status, is_idea, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  task.run(
    'task-self',
    PROJECT,
    'owner',
    'Current task',
    '',
    'in_progress',
    0,
    '2026-11-06T10:00:00Z'
  );
  task.run(
    'idea-cache',
    PROJECT,
    'owner',
    'Cache warm nodes',
    'Keep nodes warm',
    'draft',
    1,
    '2026-11-06T09:00:00Z'
  );
  task.run(
    'idea-docs',
    PROJECT,
    'owner',
    'Rewrite docs',
    'Docs plan',
    'draft',
    1,
    '2026-11-06T08:00:00Z'
  );
  await mintToken('task', { projectId: PROJECT, taskId: 'task-self', userId: 'owner' });
  await mintToken('no-task', { projectId: PROJECT, taskId: '', userId: 'owner' });
});

afterEach(() => {
  sqlite.close();
});

describe('tools/list catalogue', () => {
  it('lists every group and no group member, each tool annotated', async () => {
    const tools = await listed('task');
    const names = tools.map((tool) => tool.name);
    for (const group of MCP_TOOL_GROUPS) expect(names).toContain(group.name);
    for (const member of MEMBER_NAMES) expect(names).not.toContain(member);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const group of MCP_TOOL_GROUPS) {
      expect(byName.get(group.name)?.annotations?.readOnlyHint).toBe(group.kind === 'read');
    }
    expect(byName.get('delete_skill')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get('list_triggers')?.annotations?.readOnlyHint).toBe(true);
  });

  it('cuts the ordinary catalogue to at most 85 tools', async () => {
    const tools = await listed('task');
    expect(tools.length).toBeLessThanOrEqual(85);
    expect(tools.length).toBeGreaterThan(70);
  });

  it('hides tools that always reject a task-less token, and lists them with a task', async () => {
    const hidden = [...TASK_REQUIRED_TOOLS, 'schedules_read', 'schedules_write'];
    const withoutTask = (await listed('no-task')).map((tool) => tool.name);
    const withTask = (await listed('task')).map((tool) => tool.name);
    for (const name of hidden) {
      expect(withoutTask, name).not.toContain(name);
      expect(withTask, name).toContain(name);
    }
    // Control: a task-less token still sees ordinary domain tools.
    expect(withoutTask).toContain('ideas_read');
  });
});

describe('every hidden task-only tool rejects a task-less token', () => {
  // Minimal well-formed arguments so each handler reaches its task check.
  const ARGS: Record<string, Record<string, unknown>> = {
    ack_event_delivery: { deliveryId: 'd-1' },
    associate_pull_request: {
      prUrl: 'https://github.com/owner/groups/pull/1',
      prHeadBranch: 'sam/groups',
      disposition: 'owned',
      reason: 'test',
    },
    cancel_project_event_subscription: { subscriptionId: 's-1' },
    catch_up_event_channel: { subscriptionId: 's-1' },
    create_project_event_subscription: {
      source: 'github',
      subjectType: 'pull_request',
      subjectId: '1',
      eventTypes: ['issue_comment.created'],
      idempotencyKey: 'k-1',
    },
    follow_event_channel: { channel: 'feature.groups' },
    get_channel_history: { channel: 'feature.groups' },
    get_event: { eventId: 'e-1' },
    get_project_event_subscription: { subscriptionId: 's-1' },
    list_channel_subscribers: { channel: 'feature.groups' },
    list_event_channels: {},
    list_project_event_subscriptions: {},
    list_pull_request_associations: {},
    list_subscription_events: { subscriptionId: 's-1' },
    override_task_state: {
      missionId: 'm-1',
      taskId: 'task-self',
      newState: 'schedulable',
      reason: 'test',
    },
    publish_channel_event: { channel: 'feature.groups', message: 'hello', idempotencyKey: 'k-2' },
    reply_to_email: { body: 'hello' },
    send_durable_message: { targetTaskId: 'task-self', message: 'hello' },
    send_message_to_subtask: { taskId: 'task-self', message: 'hello' },
    stop_subtask: { taskId: 'task-self' },
    wait_for_subtasks: { taskIds: ['task-self'], waitKey: 'w-1' },
  };

  it('covers every task-required tool', () => {
    expect(Object.keys(ARGS).sort()).toEqual([...TASK_REQUIRED_TOOLS].sort());
  });

  it.each(Object.entries(ARGS))('%s', async (name, args) => {
    const body = await call('no-task', name, args);
    const error = body.error?.message ?? JSON.stringify(body.result);
    // ProjectEventCallerIdentityError is the event tools' task-token guard.
    expect(error).toMatch(/task|caller identity is not valid/i);
    expect(body.error ?? (body.result as { isError?: boolean })?.isError).toBeTruthy();
  });

  it.each([
    ['schedules_read', { method: 'list' }],
    ['schedules_write', { method: 'cancel', scheduleId: 's-1', expectedVersion: 1 }],
  ])('%s through its group', async (name, args) => {
    const body = await call('no-task', name, args);
    expect(body.error?.message ?? JSON.stringify(body.result)).toMatch(/task/i);
  });
});

describe('group calls reach the member tool', () => {
  it('ideas_read search returns exactly what search_ideas returns', async () => {
    const viaGroup = resultJson(
      await call('task', 'ideas_read', { method: 'search', query: 'warm' })
    );
    const viaMember = resultJson(await call('task', 'search_ideas', { query: 'warm' }));
    expect(viaGroup).toEqual(viaMember);
    expect(JSON.stringify(viaGroup)).toContain('idea-cache');
    expect(JSON.stringify(viaGroup)).not.toContain('idea-docs');
  });

  it('ideas_write create persists an idea that ideas_read list returns', async () => {
    const created = resultJson(
      await call('task', 'ideas_write', { method: 'create', title: 'Grouped tools idea' })
    );
    const ideaId = created.ideaId as string;
    expect(ideaId).toEqual(expect.any(String));
    const row = sqlite.prepare('SELECT title, status FROM tasks WHERE id = ?').get(ideaId);
    expect(row).toEqual({ title: 'Grouped tools idea', status: 'draft' });
    const read = resultJson(await call('task', 'ideas_read', { method: 'list' }));
    expect(JSON.stringify(read)).toContain(ideaId);
  });

  it('tasks_read list matches list_tasks', async () => {
    const viaGroup = resultJson(
      await call('task', 'tasks_read', { method: 'list', include_own: true })
    );
    const viaMember = resultJson(await call('task', 'list_tasks', { include_own: true }));
    expect(viaGroup).toEqual(viaMember);
    expect(JSON.stringify(viaGroup)).toContain('task-self');
  });

  it('rejects an unknown method with the valid ones', async () => {
    const body = await call('task', 'ideas_read', { method: 'delete', ideaId: 'idea-cache' });
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.data?.validMethods).toEqual(Object.keys(MCP_TOOL_GROUPS[0].methods));
  });

  it('rejects a missing method', async () => {
    const body = await call('task', 'ideas_read', { query: 'warm' });
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain('method must be one of');
  });

  it('rejects an argument the chosen method does not accept', async () => {
    const body = await call('task', 'ideas_read', { method: 'list', query: 'warm' });
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.data?.unsupported).toEqual(['query']);
  });
});

describe('group argument translation', () => {
  it('passes null where the member accepts it and rejects it where it does not', () => {
    const update = resolveGroupedToolCall(1, 'policies_write', {
      method: 'update',
      policyId: 'p-1',
      expiresAt: null,
    });
    expect(update).toEqual({
      toolName: 'update_policy',
      toolArgs: { policyId: 'p-1', expiresAt: null },
      via: { group: 'policies_write', method: 'update' },
    });
    const add = resolveGroupedToolCall(1, 'policies_write', {
      method: 'add',
      category: 'rule',
      title: 't',
      content: 'c',
      expiresAt: null,
    });
    expect(add).toMatchObject({ error: { code: -32602, data: { nullRejected: ['expiresAt'] } } });
  });

  it('rejects inherited object keys as methods', () => {
    for (const method of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolveGroupedToolCall(1, 'ideas_read', { method })).toMatchObject({
        error: { code: -32602 },
      });
    }
  });

  it('rejects a call without a tool name', () => {
    expect(resolveGroupedToolCall(1, undefined, {})).toMatchObject({
      error: { code: -32602, message: 'tools/call requires a tool name' },
    });
  });

  it('leaves ungrouped tool calls untouched', () => {
    expect(resolveGroupedToolCall(1, 'dispatch_task', { description: 'x' })).toEqual({
      toolName: 'dispatch_task',
      toolArgs: { description: 'x' },
    });
  });
});

describe('group schema generation', () => {
  const toolsByName = new Map(
    (MCP_TOOLS as unknown as Array<{ name: string }>).map((tool) => [tool.name, tool])
  ) as Parameters<typeof buildGroupDefinition>[1];

  it('refuses members that disagree on a property', () => {
    const fake = new Map(toolsByName);
    fake.set('fake_a', {
      name: 'fake_a',
      description: '',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    });
    fake.set('fake_b', {
      name: 'fake_b',
      description: '',
      inputSchema: { type: 'object', properties: { limit: { type: 'string' } } },
    });
    expect(() =>
      buildGroupDefinition(
        {
          name: 'fake_read',
          kind: 'read',
          summary: 'x',
          methods: { a: { tool: 'fake_a', summary: 'a' }, b: { tool: 'fake_b', summary: 'b' } },
        },
        fake
      )
    ).toThrow(/property 'limit' differs/);
  });

  it('refuses a member tool claimed by two groups', () => {
    const group = (name: string) => ({
      name,
      kind: 'read' as const,
      summary: 'x',
      methods: { get: { tool: 'get_idea', summary: 'x' } },
    });
    expect(() => indexGroupMembers([group('one_read'), group('two_read')])).toThrow(
      /get_idea is in both one_read and two_read/
    );
  });

  it('marks which methods use and require each property', () => {
    const ideasRead = LISTED_MCP_TOOLS.find((tool) => tool.name === 'ideas_read')!;
    const query = ideasRead.inputSchema.properties?.query as { description: string };
    expect(query.description).toContain('(Methods: search, related.)');
    expect(query.description).toContain('Required for: search, related.');
    expect(ideasRead.inputSchema.required).toEqual(['method']);
    expect(ideasRead.description).toContain('search_ideas');
  });
});

describe('initialize', () => {
  it('returns a short category map naming every group', async () => {
    const body = await rpc('task', 'initialize');
    const instructions = body.result?.instructions ?? '';
    expect(instructions).toBe(MCP_SERVER_INSTRUCTIONS);
    expect(new TextEncoder().encode(instructions).length).toBeLessThan(2048);
    for (const group of MCP_TOOL_GROUPS) expect(instructions).toContain(group.name);
  });
});
