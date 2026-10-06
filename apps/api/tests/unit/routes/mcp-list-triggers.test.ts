import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleListTriggers } from '../../../src/routes/mcp/trigger-list-tool';
import { cronToHumanReadable } from '../../../src/services/cron-utils';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

interface TriggerFixture {
  id: string;
  projectId?: string;
  name?: string;
  description?: string | null;
  status?: string;
  sourceType?: string;
  cronExpression?: string | null;
  cronTimezone?: string | null;
  skipIfRunning?: boolean;
  promptTemplate?: string;
  agentProfileId?: string | null;
  skillId?: string | null;
  taskMode?: string;
  maxConcurrent?: number;
  lastTriggeredAt?: string | null;
  triggerCount?: number;
  nextFireAt?: string | null;
  createdAt?: string;
}

interface ListedTrigger {
  id: string;
  name: string;
  description: string | null;
  status: string;
  sourceType: string;
  cronExpression: string | null;
  cronTimezone: string;
  cronHumanReadable: string | null;
  nextFireAt: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
  taskMode: string;
  agentProfileId: string | null;
  skillId: string | null;
  maxConcurrent: number;
  skipIfRunning: boolean;
}

const tokenData: McpTokenData = {
  taskId: 'task-1',
  projectId: 'project-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-08-08T00:00:00.000Z',
};

function parseContent(response: Awaited<ReturnType<typeof handleListTriggers>>): ListedTrigger[] {
  expect(response.error).toBeUndefined();
  const result = response.result as { content: Array<{ text: string }> };
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as { triggers: ListedTrigger[] };
  return payload.triggers;
}

describe('MCP list_triggers handler', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.triggers, schema.webhookTriggerConfigs]);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertTrigger(fixture: TriggerFixture): void {
    sqlite
      .prepare(
        `INSERT INTO triggers (
          id, project_id, user_id, name, description, status, source_type,
          cron_expression, cron_timezone, skip_if_running, prompt_template,
          agent_profile_id, skill_id, task_mode, vm_size_override, max_concurrent,
          last_triggered_at, trigger_count, next_execution_sequence, next_fire_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        fixture.id,
        fixture.projectId ?? tokenData.projectId,
        'user-1',
        fixture.name ?? fixture.id,
        fixture.description ?? null,
        fixture.status ?? 'active',
        fixture.sourceType ?? 'cron',
        fixture.cronExpression === undefined ? '0 9 * * *' : fixture.cronExpression,
        fixture.cronTimezone === undefined ? 'UTC' : fixture.cronTimezone,
        fixture.skipIfRunning === false ? 0 : 1,
        fixture.promptTemplate ?? 'Review the project',
        fixture.agentProfileId ?? null,
        fixture.skillId ?? null,
        fixture.taskMode ?? 'task',
        fixture.maxConcurrent ?? 1,
        fixture.lastTriggeredAt ?? null,
        fixture.triggerCount ?? 0,
        fixture.nextFireAt ?? null,
        fixture.createdAt ?? '2026-08-08T00:00:00.000Z',
        fixture.createdAt ?? '2026-08-08T00:00:00.000Z'
      );
  }

  it('returns an empty list for a project with no triggers', async () => {
    const response = await handleListTriggers('req-1', {}, tokenData, env);

    expect(parseContent(response)).toEqual([]);
  });

  it('returns multiple triggers with the operational field contract', async () => {
    insertTrigger({
      id: 'cron-trigger',
      name: 'Daily review',
      description: 'Review open changes',
      cronExpression: '0 9 * * 1-5',
      cronTimezone: 'America/New_York',
      skipIfRunning: false,
      agentProfileId: 'profile-1',
      skillId: 'skill-1',
      taskMode: 'conversation',
      maxConcurrent: 3,
      lastTriggeredAt: '2026-08-07T13:00:00.000Z',
      triggerCount: 7,
      nextFireAt: '2026-08-10T13:00:00.000Z',
      createdAt: '2026-08-08T02:00:00.000Z',
    });
    insertTrigger({
      id: 'webhook-trigger',
      sourceType: 'webhook',
      cronExpression: null,
      cronTimezone: null,
      createdAt: '2026-08-08T01:00:00.000Z',
    });

    const response = await handleListTriggers('req-1', {}, tokenData, env);
    const triggers = parseContent(response);

    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toEqual({
      id: 'cron-trigger',
      name: 'Daily review',
      description: 'Review open changes',
      status: 'active',
      sourceType: 'cron',
      cronExpression: '0 9 * * 1-5',
      cronTimezone: 'America/New_York',
      cronHumanReadable: cronToHumanReadable('0 9 * * 1-5', 'America/New_York'),
      nextFireAt: '2026-08-10T13:00:00.000Z',
      lastTriggeredAt: '2026-08-07T13:00:00.000Z',
      triggerCount: 7,
      taskMode: 'conversation',
      agentProfileId: 'profile-1',
      skillId: 'skill-1',
      maxConcurrent: 3,
      skipIfRunning: false,
    });
    expect(triggers[1]).toMatchObject({
      id: 'webhook-trigger',
      sourceType: 'webhook',
      cronExpression: null,
      cronHumanReadable: null,
    });
  });

  it('filters triggers by status in SQL', async () => {
    insertTrigger({ id: 'active-trigger', status: 'active' });
    insertTrigger({ id: 'paused-trigger', status: 'paused' });
    insertTrigger({ id: 'disabled-trigger', status: 'disabled' });

    const response = await handleListTriggers('req-1', { status: 'paused' }, tokenData, env);

    expect(parseContent(response).map((trigger) => trigger.id)).toEqual(['paused-trigger']);
  });

  it('filters triggers by source type in SQL', async () => {
    insertTrigger({ id: 'cron-trigger', sourceType: 'cron' });
    insertTrigger({ id: 'webhook-trigger', sourceType: 'webhook', cronExpression: null });
    insertTrigger({ id: 'github-trigger', sourceType: 'github', cronExpression: null });

    const response = await handleListTriggers('req-1', { sourceType: 'github' }, tokenData, env);

    expect(parseContent(response).map((trigger) => trigger.id)).toEqual(['github-trigger']);
  });

  it('isolates projects and omits webhook secret/config material', async () => {
    const promptCanary = 'PROMPT_SECRET_CANARY';
    const tokenHashCanary = 'TOKEN_HASH_SECRET_CANARY';
    const headerCanary = 'X-SECRET-HEADER-CANARY';
    const filterCanary = 'FILTER_SECRET_CANARY';
    insertTrigger({
      id: 'own-webhook',
      sourceType: 'webhook',
      cronExpression: null,
      promptTemplate: promptCanary,
    });
    insertTrigger({
      id: 'foreign-trigger',
      projectId: 'project-2',
      name: 'CROSS_PROJECT_SECRET_CANARY',
    });
    sqlite
      .prepare(
        `INSERT INTO webhook_trigger_configs (
          trigger_id, token_hash, token_last_four, token_created_at, token_rotated_at,
          source_label, filter_mode, filters_json, included_headers_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 'all', ?, ?, ?, ?)`
      )
      .run(
        'own-webhook',
        tokenHashCanary,
        '9876',
        '2026-08-08T00:00:00.000Z',
        'SOURCE_LABEL_SECRET_CANARY',
        JSON.stringify([{ value: filterCanary }]),
        JSON.stringify([headerCanary]),
        '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z'
      );

    const response = await handleListTriggers('req-1', {}, tokenData, env);
    const result = response.result as { content: Array<{ text: string }> };
    const serialized = result.content[0]?.text ?? '';
    const triggers = parseContent(response);

    expect(triggers.map((trigger) => trigger.id)).toEqual(['own-webhook']);
    expect(serialized).not.toContain('CROSS_PROJECT_SECRET_CANARY');
    expect(serialized).not.toContain(promptCanary);
    expect(serialized).not.toContain(tokenHashCanary);
    expect(serialized).not.toContain('9876');
    expect(serialized).not.toContain(headerCanary);
    expect(serialized).not.toContain(filterCanary);
    expect(serialized).not.toContain('SOURCE_LABEL_SECRET_CANARY');
    expect(serialized).not.toContain('promptTemplate');
    expect(serialized).not.toContain('webhookConfig');
    expect(serialized).not.toContain('webhookCredential');
    expect(serialized).not.toContain('includedHeaders');
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('tokenLastFour');
  });

  it('enforces configurable default and maximum result bounds', async () => {
    env.MCP_TRIGGER_LIST_LIMIT = '2';
    env.MCP_TRIGGER_LIST_MAX = '3';
    for (let index = 0; index < 5; index += 1) {
      insertTrigger({
        id: `trigger-${index}`,
        createdAt: `2026-08-08T00:00:0${index}.000Z`,
      });
    }

    const defaultResponse = await handleListTriggers('req-1', {}, tokenData, env);
    const cappedResponse = await handleListTriggers('req-2', { limit: 99 }, tokenData, env);
    const requestedResponse = await handleListTriggers('req-3', { limit: 1.9 }, tokenData, env);

    expect(parseContent(defaultResponse).map((trigger) => trigger.id)).toEqual([
      'trigger-4',
      'trigger-3',
    ]);
    expect(parseContent(cappedResponse)).toHaveLength(3);
    expect(parseContent(requestedResponse)).toHaveLength(1);
  });

  it('rejects invalid filters and limits', async () => {
    const invalidStatus = await handleListTriggers('req-1', { status: 'running' }, tokenData, env);
    const invalidSource = await handleListTriggers(
      'req-2',
      { sourceType: 'email' },
      tokenData,
      env
    );
    const invalidLimit = await handleListTriggers('req-3', { limit: 0 }, tokenData, env);

    expect(invalidStatus.error?.message).toContain('status must be');
    expect(invalidSource.error?.message).toContain('sourceType must be');
    expect(invalidLimit.error?.message).toContain('limit must be');
  });
});
