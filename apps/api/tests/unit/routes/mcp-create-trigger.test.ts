import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { TRIGGER_TOOLS } from '../../../src/routes/mcp/tool-definitions-trigger-tools';
import { handleCreateTrigger, handleUpdateTrigger } from '../../../src/routes/mcp/trigger-tools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const token: McpTokenData = {
  taskId: 'task',
  projectId: 'project',
  userId: 'user',
  workspaceId: 'ws',
  createdAt: '2026-10-07T00:00:00Z',
};
const cron = { name: 'Daily', cronExpression: '0 9 * * *', promptTemplate: 'Review' };
const github = {
  name: 'Issues',
  sourceType: 'github',
  githubConfig: {
    eventType: 'issues',
    filters: { actions: ['opened'], labels: ['bug'], ignoreActors: ['bot'] },
  },
  promptTemplate: 'Review {{github.title}}',
};

describe('MCP create_trigger with canonical persistence', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, 'user');
    seedProjectWithMember(sqlite, { projectId: 'project', userId: 'user', role: 'owner' });
    env = { DATABASE: createSqliteD1WithBindLimit(sqlite, 100) } as Env;
  });
  afterEach(() => sqlite.close());
  const content = (result: Awaited<ReturnType<typeof handleCreateTrigger>>) =>
    JSON.parse((result.result as { content: { text: string }[] }).content[0].text);

  it('rejects MCP webhook creation while public ingress is disabled', async () => {
    env.WEBHOOK_TRIGGERS_ENABLED = 'false';
    const result = await handleCreateTrigger(
      '1',
      {
        name: 'Webhook',
        sourceType: 'webhook',
        agentProfileId: 'profile',
        promptTemplate: 'Handle webhook',
        webhookConfig: {},
      },
      token,
      env
    );
    expect(result.error?.message).toContain('Webhook triggers are disabled');
    expect(sqlite.prepare('SELECT count(*) AS count FROM triggers').get()).toEqual({ count: 0 });
  });

  it('preserves cron callers that omit sourceType and UTC default', async () => {
    const result = await handleCreateTrigger('1', cron, token, env);
    expect(result.error).toBeUndefined();
    expect(content(result)).toMatchObject({
      sourceType: 'cron',
      cronTimezone: 'UTC',
      status: 'active',
    });
    expect(content(result).nextFireAt).toBeTruthy();
    expect(content(result).cronHumanReadable).toBeTruthy();
  });
  it('creates and replaces GitHub config without cron scheduling', async () => {
    const result = await handleCreateTrigger('1', github, token, env);
    expect(result.error).toBeUndefined();
    const created = content(result);
    expect(created).toMatchObject({
      sourceType: 'github',
      cronExpression: null,
      cronTimezone: null,
      nextFireAt: null,
      githubConfig: github.githubConfig,
    });
    const updated = await handleUpdateTrigger(
      '2',
      {
        triggerId: created.triggerId,
        githubConfig: { eventType: 'push', filters: { branches: ['main'] } },
      },
      token,
      env
    );
    expect(updated.error).toBeUndefined();
    expect(content(updated).githubConfig).toEqual({
      eventType: 'push',
      filters: { branches: ['main'] },
    });
    const cleared = await handleUpdateTrigger(
      '3',
      { triggerId: created.triggerId, githubConfig: { eventType: 'push', filters: {} } },
      token,
      env
    );
    expect(content(cleared).githubConfig.filters).toEqual({});
  });
  it.each([
    [{ ...cron, name: undefined }, 'name'],
    [{ ...cron, name: ' ' }, 'name is required'],
    [{ ...cron, cronExpression: '' }, 'cronExpression is required'],
    [{ ...cron, promptTemplate: ' ' }, 'promptTemplate is required'],
    [{ ...cron, promptTemplate: 'x'.repeat(8001) }, 'too long'],
    [{ ...cron, cronExpression: 'invalid' }, 'Invalid cron'],
    [{ ...cron, cronTimezone: 'Invalid/Zone' }, 'Invalid timezone'],
    [{ ...cron, vmSizeOverride: 'xlarge' }, 'vmSizeOverride'],
    [{ ...github, githubConfig: undefined }, 'githubConfig.eventType'],
    [{ ...github, githubConfig: { eventType: 'unsupported' } }, 'githubConfig'],
    [
      { ...github, githubConfig: { eventType: 'issues', filters: { labels: 'bug' } } },
      'githubConfig',
    ],
    [
      { ...github, githubConfig: { eventType: 'issues', filters: { unknownFilter: true } } },
      'githubConfig',
    ],
    [{ ...github, cronExpression: '0 9 * * *' }, 'only valid for cron'],
    [{ ...cron, githubConfig: github.githubConfig }, 'only valid for github'],
    [{ ...cron, sourceType: 'webhook' }, 'only valid for cron'],
    [{ ...cron, sourceType: 'incident' }, 'sourceType'],
    [{ ...github, agentProfileId: 'foreign' }, 'Agent profile not found'],
  ])('rejects invalid input without persisting: %j', async (params, message) => {
    const result = await handleCreateTrigger('1', params, token, env);
    expect(result.error?.message).toContain(message);
    expect(sqlite.prepare('SELECT count(*) AS count FROM triggers').get()).toEqual({ count: 0 });
  });
  it('enforces duplicate names and project trigger limits', async () => {
    expect((await handleCreateTrigger('1', github, token, env)).error).toBeUndefined();
    expect((await handleCreateTrigger('2', github, token, env)).error?.message).toContain(
      'already exists'
    );
    sqlite.prepare('UPDATE projects SET max_triggers = 1 WHERE id = ?').run('project');
    expect((await handleCreateTrigger('3', cron, token, env)).error?.message).toContain(
      'Maximum triggers'
    );
  });
  it('rejects nonexistent token project', async () => {
    expect(
      (await handleCreateTrigger('1', github, { ...token, projectId: 'missing' }, env)).error
        ?.message
    ).toContain('Project not found');
  });
  it('rejects source-specific updates without changing stored config', async () => {
    const created = content(await handleCreateTrigger('1', github, token, env));
    for (const params of [
      { cronExpression: '0 10 * * *' },
      { sourceType: 'cron' },
      { githubConfig: { eventType: 'bad' } },
    ]) {
      expect(
        (await handleUpdateTrigger('2', { triggerId: created.triggerId, ...params }, token, env))
          .error
      ).toBeDefined();
    }
    expect(sqlite.prepare('SELECT event_type FROM github_trigger_configs').get()).toEqual({
      event_type: 'issues',
    });
  });
});

// Some tool clients reject union schemas at the tool root before invoking the handler.
it('advertises an object schema while handlers enforce source-specific requirements', () => {
  const tool = TRIGGER_TOOLS.find((entry) => entry.name === 'create_trigger')!;
  expect(tool.inputSchema.type).toBe('object');
  expect(tool.inputSchema).not.toHaveProperty('anyOf');
  expect(tool.inputSchema.required).toEqual(['name', 'promptTemplate']);
  expect(tool.inputSchema.properties).toHaveProperty('githubConfig');
  expect(tool.inputSchema.properties).toHaveProperty('sourceType.enum', [
    'cron',
    'github',
    'webhook',
  ]);
  expect(tool.inputSchema.properties).toHaveProperty(
    'cronExpression.description',
    expect.stringContaining('Required when sourceType is cron or omitted')
  );
});
