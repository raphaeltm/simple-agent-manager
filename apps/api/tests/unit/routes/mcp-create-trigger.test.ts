import {
  DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING_LIMIT,
  DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS_LIMIT,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { TRIGGER_TOOLS } from '../../../src/routes/mcp/tool-definitions-trigger-tools';
import { handleCreateTrigger, handleUpdateTrigger } from '../../../src/routes/mcp/trigger-tools';
import { invalidateAdminSettings } from '../../../src/services/admin-settings';
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

  it('sets concurrency, skip behavior and description atomically on create', async () => {
    const result = await handleCreateTrigger(
      'parity',
      { ...github, description: 'Explicit controls', maxConcurrent: 3, skipIfRunning: false },
      token,
      env
    );
    expect(result.error).toBeUndefined();
    expect(content(result)).toMatchObject({
      description: 'Explicit controls',
      maxConcurrent: 3,
      skipIfRunning: false,
    });
    expect(
      sqlite.prepare('SELECT description, max_concurrent, skip_if_running FROM triggers').get()
    ).toEqual({ description: 'Explicit controls', max_concurrent: 3, skip_if_running: 0 });
    const definition = TRIGGER_TOOLS.find((tool) => tool.name === 'create_trigger')!;
    expect(definition.inputSchema.properties).toHaveProperty('maxConcurrent');
    expect(definition.inputSchema.properties).toHaveProperty('skipIfRunning');
    expect(definition.inputSchema.properties).toHaveProperty('description');
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
  it('returns stored queue settings and defaults from creation', async () => {
    const defaults = content(await handleCreateTrigger('defaults', github, token, env));
    expect(defaults.githubConfig).toMatchObject({
      subjectAffinity: false,
      queueMaxPending: 50,
      queueTtlSeconds: 86400,
    });
  });
  it('returns queue settings at the shared safety ceilings', async () => {
    const settings = {
      subjectAffinity: true,
      queueMaxPending: DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING_LIMIT,
      queueTtlSeconds: DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS_LIMIT,
    };
    const custom = content(
      await handleCreateTrigger(
        'custom',
        { ...github, githubConfig: { ...github.githubConfig, ...settings } },
        token,
        env
      )
    );
    expect(custom.githubConfig).toMatchObject(settings);
  });
  it.each([
    ['queueMaxPending', DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING_LIMIT + 1],
    ['queueTtlSeconds', DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS_LIMIT + 1],
  ])('rejects creation and update beyond the %s ceiling', async (field, value) => {
    const invalid = { ...github.githubConfig, [field]: value };
    expect(
      (await handleCreateTrigger('invalid', { ...github, githubConfig: invalid }, token, env)).error
        ?.code
    ).toBe(-32602);
    const created = content(await handleCreateTrigger('valid', github, token, env));
    expect(
      (
        await handleUpdateTrigger(
          'invalid-update',
          { triggerId: created.triggerId, githubConfig: invalid },
          token,
          env
        )
      ).error?.code
    ).toBe(-32602);
  });
  it.each([
    { pending: 2000, ttl: 60 * 86400 },
    { pending: 3, ttl: 60 },
  ])(
    'honors higher and lower admin ceilings on create and update: %j',
    async ({ pending, ttl }) => {
      const put = sqlite.prepare(
        'INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)'
      );
      put.run('operations.githubTriggerQueueMaxPendingLimit', String(pending), 'now');
      put.run('operations.githubTriggerQueueTtlSecondsLimit', String(ttl), 'now');
      invalidateAdminSettings(env);
      const defaults = content(await handleCreateTrigger('admin-default', github, token, env));
      expect(defaults.githubConfig.queueMaxPending).toBe(Math.min(50, pending));
      expect(defaults.githubConfig.queueTtlSeconds).toBe(Math.min(86400, ttl));
      const atLimit = { ...github.githubConfig, queueMaxPending: pending, queueTtlSeconds: ttl };
      const created = await handleCreateTrigger(
        'limit',
        { ...github, name: 'At limit', githubConfig: atLimit },
        token,
        env
      );
      expect(created.error).toBeUndefined();
      expect(content(created).githubConfig).toMatchObject({
        queueMaxPending: pending,
        queueTtlSeconds: ttl,
      });
      for (const [field, value] of [
        ['queueMaxPending', pending + 1],
        ['queueTtlSeconds', ttl + 1],
      ] as const) {
        const invalid = { ...atLimit, [field]: value };
        expect(
          (
            await handleCreateTrigger(
              'over',
              { ...github, name: 'Over limit', githubConfig: invalid },
              token,
              env
            )
          ).error?.code
        ).toBe(-32602);
        expect(
          (
            await handleUpdateTrigger(
              'update-over',
              { triggerId: defaults.triggerId, githubConfig: invalid },
              token,
              env
            )
          ).error?.code
        ).toBe(-32602);
      }
      const updated = await handleUpdateTrigger(
        'update-limit',
        { triggerId: defaults.triggerId, githubConfig: atLimit },
        token,
        env
      );
      expect(updated.error).toBeUndefined();
      expect(content(updated).githubConfig).toMatchObject({
        queueMaxPending: pending,
        queueTtlSeconds: ttl,
      });
    }
  );
  it('updates queue controls and preserves them during later filter-only edits', async () => {
    const created = content(await handleCreateTrigger('queue-create', github, token, env));
    const settings = { subjectAffinity: true, queueMaxPending: 7, queueTtlSeconds: 120 };
    const updated = await handleUpdateTrigger(
      'queue-update',
      { triggerId: created.triggerId, githubConfig: { ...github.githubConfig, ...settings } },
      token,
      env
    );
    expect(updated.error).toBeUndefined();
    expect(content(updated).githubConfig).toMatchObject(settings);
    const filtered = await handleUpdateTrigger(
      'queue-filter',
      {
        triggerId: created.triggerId,
        githubConfig: { eventType: 'issues', filters: { labels: ['bug'] } },
      },
      token,
      env
    );
    expect(filtered.error).toBeUndefined();
    expect(content(filtered).githubConfig).toMatchObject({
      ...settings,
      filters: { labels: ['bug'] },
    });
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
      subjectAffinity: false,
      queueMaxPending: 50,
      queueTtlSeconds: 86400,
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
