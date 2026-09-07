import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleCreateTrigger, handleUpdateTrigger } from '../../../src/routes/mcp/trigger-tools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

describe('MCP trigger resourceRequirements field validation', () => {
  let sqlite: Database.Database;
  let env: Env;
  let tokenData: McpTokenData;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, 'user-1');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    env = {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      CRON_TEMPLATE_MAX_LENGTH: undefined,
      MAX_TRIGGERS_PER_PROJECT: undefined,
      CRON_MIN_INTERVAL_MINUTES: undefined,
      TRIGGER_NAME_MAX_LENGTH: undefined,
      TRIGGER_MAX_CONCURRENT_LIMIT: undefined,
    } as Env;
    tokenData = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: '2026-09-07T00:00:00.000Z',
    };
  });

  afterEach(() => {
    sqlite.close();
  });

  function triggerCount(): number {
    return (sqlite.prepare('SELECT COUNT(*) AS count FROM triggers').get() as { count: number })
      .count;
  }

  function insertTrigger(resourceRequirementsJson: string | null = null): void {
    sqlite
      .prepare(
        `INSERT INTO triggers (
           id, project_id, user_id, name, status, source_type, cron_expression,
           cron_timezone, skip_if_running, prompt_template, task_mode,
           resource_requirements_json, max_concurrent, next_fire_at, created_at, updated_at
         )
         VALUES (
           'trigger-1', 'project-1', 'user-1', 'Existing trigger', 'active',
           'cron', '0 9 * * *', 'UTC', 1, 'Original prompt', 'task',
           ?, 1, '2026-09-08T09:00:00.000Z',
           '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
         )`
      )
      .run(resourceRequirementsJson);
  }

  function readTriggerResourceRequirements(): string | null {
    return (
      sqlite
        .prepare("SELECT resource_requirements_json FROM triggers WHERE id = 'trigger-1'")
        .get() as { resource_requirements_json: string | null }
    ).resource_requirements_json;
  }

  it('rejects wrong-type modern resourceRequirements on create without inserting rows', async () => {
    for (const resourceRequirements of ['{"minVcpu":2}', '   ', [], 'null']) {
      const result = await handleCreateTrigger(
        'req-1',
        {
          name: `Invalid ${String(resourceRequirements).length}`,
          cronExpression: '0 9 * * *',
          promptTemplate: 'Run',
          resourceRequirements,
        },
        tokenData,
        env
      );

      expect(result.error?.message).toContain('resourceRequirements must be an object or null');
      expect(triggerCount()).toBe(0);
    }
  });

  it('keeps resourceRequirementsJson string compatibility and modern precedence on create', async () => {
    const compatibility = await handleCreateTrigger(
      'req-1',
      {
        name: 'Compatibility trigger',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Run',
        resourceRequirementsJson: '{"minDiskGb":0,"exclusiveNode":false}',
      },
      tokenData,
      env
    );

    expect(compatibility.error).toBeUndefined();
    expect(
      sqlite.prepare("SELECT resource_requirements_json FROM triggers WHERE name = 'Compatibility trigger'").get()
    ).toEqual({ resource_requirements_json: '{"minDiskGb":0,"exclusiveNode":false}' });

    const precedence = await handleCreateTrigger(
      'req-2',
      {
        name: 'Precedence trigger',
        cronExpression: '0 10 * * *',
        promptTemplate: 'Run',
        resourceRequirements: { minVcpu: 2 },
        resourceRequirementsJson: '{"minVcpu":9}',
      },
      tokenData,
      env
    );

    expect(precedence.error).toBeUndefined();
    expect(
      sqlite.prepare("SELECT resource_requirements_json FROM triggers WHERE name = 'Precedence trigger'").get()
    ).toEqual({ resource_requirements_json: '{"minVcpu":2}' });
  });

  it('rejects wrong-type modern resourceRequirements on update without mutating the row', async () => {
    insertTrigger('{"minVcpu":2}');

    for (const resourceRequirements of ['{"minVcpu":4}', '   ', [], 'null']) {
      const result = await handleUpdateTrigger(
        'req-1',
        {
          triggerId: 'trigger-1',
          resourceRequirements,
        },
        tokenData,
        env
      );

      expect(result.error?.message).toContain('resourceRequirements must be an object or null');
      expect(readTriggerResourceRequirements()).toBe('{"minVcpu":2}');
    }
  });

  it('keeps resourceRequirementsJson string compatibility, modern precedence, and explicit null clear on update', async () => {
    insertTrigger('{"minVcpu":2}');

    const compatibility = await handleUpdateTrigger(
      'req-1',
      {
        triggerId: 'trigger-1',
        resourceRequirementsJson: '{"minDiskGb":0,"exclusiveNode":false}',
      },
      tokenData,
      env
    );
    expect(compatibility.error).toBeUndefined();
    expect(readTriggerResourceRequirements()).toBe('{"minDiskGb":0,"exclusiveNode":false}');

    const precedence = await handleUpdateTrigger(
      'req-2',
      {
        triggerId: 'trigger-1',
        resourceRequirements: { minMemoryGb: 8 },
        resourceRequirementsJson: '{"minMemoryGb":64}',
      },
      tokenData,
      env
    );
    expect(precedence.error).toBeUndefined();
    expect(readTriggerResourceRequirements()).toBe('{"minMemoryGb":8}');

    const clear = await handleUpdateTrigger(
      'req-3',
      {
        triggerId: 'trigger-1',
        resourceRequirements: null,
      },
      tokenData,
      env
    );
    expect(clear.error).toBeUndefined();
    expect(readTriggerResourceRequirements()).toBeNull();
  });
});
