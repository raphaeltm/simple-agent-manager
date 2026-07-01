import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { storeMcpToken } from '../../src/services/mcp-token';
import {
  seedInstallation,
  seedProject,
  seedTrigger,
  seedTriggerExecution,
  seedUser,
} from './helpers/seed-d1';

interface JsonRpcToolResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    content?: Array<{ type: string; text: string }>;
    tools?: Array<{ name: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

interface TriggerRow {
  id: string;
  project_id: string;
  name: string;
  status: string;
  cron_expression: string | null;
  cron_timezone: string | null;
  next_fire_at: string | null;
  prompt_template: string;
}

interface CountRow {
  count: number;
}

const TEST_PREFIX = `mcp-triggers-${Date.now()}`;

async function seedProjectGraph(suffix: string): Promise<{ userId: string; projectId: string }> {
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;

  await seedUser(userId, { githubId: `${TEST_PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${TEST_PREFIX}-${suffix}-external-installation`,
    accountName: `${TEST_PREFIX}-${suffix}-account`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `${TEST_PREFIX}-${suffix} Project`,
    repository: `${TEST_PREFIX}/${suffix}`,
  });

  return { userId, projectId };
}

async function storeToken(token: string, projectId: string, userId: string): Promise<void> {
  await storeMcpToken(env.KV, token, {
    taskId: `${token}-task`,
    projectId,
    userId,
    workspaceId: `${token}-workspace`,
    createdAt: new Date().toISOString(),
  });
}

async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcToolResponse> {
  const response = await SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-request`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  expect(response.status).toBe(200);
  return response.json<JsonRpcToolResponse>();
}

async function listTools(token: string): Promise<JsonRpcToolResponse> {
  const response = await SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'tools-list-request',
      method: 'tools/list',
    }),
  });

  expect(response.status).toBe(200);
  return response.json<JsonRpcToolResponse>();
}

function parseToolContent(response: JsonRpcToolResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  const content = response.result?.content;
  expect(content).toHaveLength(1);
  const text = content?.[0]?.text;
  expect(text).toBeDefined();
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
}

async function getTrigger(triggerId: string): Promise<TriggerRow | null> {
  return env.DATABASE.prepare(
    `SELECT id, project_id, name, status, cron_expression, cron_timezone, next_fire_at, prompt_template
     FROM triggers
     WHERE id = ?
     LIMIT 1`,
  ).bind(triggerId).first<TriggerRow>();
}

async function countRows(table: 'github_trigger_configs' | 'trigger_executions' | 'triggers', triggerId: string): Promise<number> {
  const column = table === 'triggers' ? 'id' : 'trigger_id';
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
  ).bind(triggerId).first<CountRow>();
  return row?.count ?? 0;
}

describe('MCP trigger management tools', () => {
  it('lists update_trigger and delete_trigger in tools/list', async () => {
    const { userId, projectId } = await seedProjectGraph('list');
    const token = `${TEST_PREFIX}-list-token`;
    await storeToken(token, projectId, userId);

    const response = await listTools(token);
    const toolNames = response.result?.tools?.map((tool) => tool.name) ?? [];

    expect(toolNames).toContain('create_trigger');
    expect(toolNames).toContain('update_trigger');
    expect(toolNames).toContain('delete_trigger');
  });

  it('updates a trigger and recomputes next_fire_at', async () => {
    const { userId, projectId } = await seedProjectGraph('update');
    const token = `${TEST_PREFIX}-update-token`;
    const triggerId = `${TEST_PREFIX}-update-trigger`;
    const oldNextFireAt = '2000-01-01T00:00:00.000Z';

    await storeToken(token, projectId, userId);
    await seedTrigger(triggerId, projectId, userId, {
      name: 'Old schedule',
      cronExpression: '0 9 * * *',
      cronTimezone: 'UTC',
      nextFireAt: oldNextFireAt,
      promptTemplate: 'Old prompt',
    });

    const response = await callMcpTool(token, 'update_trigger', {
      triggerId,
      name: 'Updated schedule',
      cronExpression: '30 14 * * 1-5',
      cronTimezone: 'America/New_York',
      promptTemplate: 'Updated prompt for {{trigger.name}}',
      maxConcurrent: 2,
    });
    const payload = parseToolContent(response);
    const row = await getTrigger(triggerId);

    expect(row).not.toBeNull();
    expect(row?.name).toBe('Updated schedule');
    expect(row?.cron_expression).toBe('30 14 * * 1-5');
    expect(row?.cron_timezone).toBe('America/New_York');
    expect(row?.prompt_template).toBe('Updated prompt for {{trigger.name}}');
    expect(row?.next_fire_at).toBeTruthy();
    expect(row?.next_fire_at).not.toBe(oldNextFireAt);
    expect(payload.nextFireAt).toBe(row?.next_fire_at);
    expect(payload.cronHumanReadable).toEqual(expect.any(String));
  });

  it('deletes a trigger and cascades executions and GitHub config', async () => {
    const { userId, projectId } = await seedProjectGraph('delete');
    const token = `${TEST_PREFIX}-delete-token`;
    const triggerId = `${TEST_PREFIX}-delete-trigger`;

    await storeToken(token, projectId, userId);
    await seedTrigger(triggerId, projectId, userId, {
      sourceType: 'github',
      name: 'Delete me',
    });
    await seedTriggerExecution(`${triggerId}-execution`, triggerId, projectId);
    await env.DATABASE.prepare(
      `INSERT INTO github_trigger_configs (id, trigger_id, event_type, filters_json, created_at, updated_at)
       VALUES (?, ?, 'issues', '{}', datetime('now'), datetime('now'))`,
    ).bind(`${triggerId}-github-config`, triggerId).run();

    const response = await callMcpTool(token, 'delete_trigger', { triggerId });
    const payload = parseToolContent(response);

    expect(payload).toMatchObject({ success: true, triggerId });
    expect(await countRows('github_trigger_configs', triggerId)).toBe(0);
    expect(await countRows('trigger_executions', triggerId)).toBe(0);
    expect(await countRows('triggers', triggerId)).toBe(0);
  });

  it('rejects cross-project trigger updates and leaves the trigger unchanged', async () => {
    const caller = await seedProjectGraph('caller-update');
    const owner = await seedProjectGraph('owner-update');
    const token = `${TEST_PREFIX}-cross-update-token`;
    const triggerId = `${TEST_PREFIX}-cross-update-trigger`;

    await storeToken(token, caller.projectId, caller.userId);
    await seedTrigger(triggerId, owner.projectId, owner.userId, {
      name: 'Owned by another project',
      cronExpression: '0 9 * * *',
      nextFireAt: '2000-01-01T00:00:00.000Z',
    });

    const response = await callMcpTool(token, 'update_trigger', {
      triggerId,
      name: 'Unauthorized rename',
      cronExpression: '0 10 * * *',
    });
    const row = await getTrigger(triggerId);

    expect(response.error?.message).toContain('Trigger not found in this project');
    expect(row?.project_id).toBe(owner.projectId);
    expect(row?.name).toBe('Owned by another project');
    expect(row?.cron_expression).toBe('0 9 * * *');
  });

  it('rejects cross-project trigger deletes and leaves the trigger intact', async () => {
    const caller = await seedProjectGraph('caller-delete');
    const owner = await seedProjectGraph('owner-delete');
    const token = `${TEST_PREFIX}-cross-delete-token`;
    const triggerId = `${TEST_PREFIX}-cross-delete-trigger`;

    await storeToken(token, caller.projectId, caller.userId);
    await seedTrigger(triggerId, owner.projectId, owner.userId, {
      name: 'Do not delete',
    });
    await seedTriggerExecution(`${triggerId}-execution`, triggerId, owner.projectId);

    const response = await callMcpTool(token, 'delete_trigger', { triggerId });

    expect(response.error?.message).toContain('Trigger not found in this project');
    expect(await countRows('triggers', triggerId)).toBe(1);
    expect(await countRows('trigger_executions', triggerId)).toBe(1);
  });
});
