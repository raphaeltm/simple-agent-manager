import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { OperationContext } from '../../../src/operations/types';
import {
  auditConnectorWrite,
  consumeConnectorBudget,
  executeConnectorWrite as executeWrite,
} from '../../../src/services/connector-execution';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  recordActivityEvent: vi.fn(async () => 'activity'),
}));
const executeConnectorWrite: typeof executeWrite = (ctx, name, input, run) =>
  auditConnectorWrite(ctx, name, input, () => executeWrite(ctx, name, input, run));
let sqlite: Database.Database;
let ctx: OperationContext;
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users, schema.projects, schema.platformSettings]);
  for (const migration of ['0189_cli_operation_receipts.sql', '0191_connector_execution.sql']) {
    // Execute the production migration as SQLite setup; assertions exercise real writes.
    const migrationUrl = new URL(`../../../src/db/migrations/${migration}`, import.meta.url);
    sqlite.exec(readFileSync(migrationUrl, 'utf8'));
  }
  sqlite.exec(
    "INSERT INTO users(id) VALUES ('owner'),('other'); INSERT INTO projects(id) VALUES ('project');"
  );
  ctx = {
    env: { DATABASE: createSqliteD1(sqlite) } as Env,
    actor: { userId: 'owner', via: 'connector', scopes: new Set(['sam.read', 'sam.write']) },
    requestId: 'r',
    idempotencyKey: 'intent-1',
  };
});
afterEach(() => {
  sqlite.close();
  vi.useRealTimers();
});

describe('Connector atomic execution', () => {
  it('never audits secret-looking identifiers or arbitrary input keys before authorization', async () => {
    const canary = 'sam_pat_canary_private_token';
    await expect(
      auditConnectorWrite(
        ctx,
        'sam_chat_start',
        { projectId: canary, taskId: canary, [canary]: true },
        async () => {
          throw new Error('denied');
        }
      )
    ).rejects.toThrow('denied');
    expect(
      JSON.stringify(sqlite.prepare('SELECT * FROM connector_operation_audit').all())
    ).not.toContain(canary);
  });
  it('replays same intent once and isolates users; rejects changed intent', async () => {
    const run = vi.fn(async () => ({ taskId: 'task-1' }));
    const input = { projectId: 'project', message: 'canary-secret-prompt' };
    expect(await executeConnectorWrite(ctx, 'sam_chat_start', input, run)).toEqual({
      taskId: 'task-1',
    });
    expect(await executeConnectorWrite(ctx, 'sam_chat_start', input, run)).toEqual({
      taskId: 'task-1',
    });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(
      executeConnectorWrite(ctx, 'sam_chat_start', { ...input, message: 'different' }, run)
    ).rejects.toMatchObject({ code: 'conflict' });
    await executeConnectorWrite(
      { ...ctx, actor: { ...ctx.actor, userId: 'other' } },
      'sam_chat_start',
      input,
      run
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(sqlite.prepare('SELECT * FROM connector_operation_audit').all())
    ).not.toContain('canary-secret-prompt');
    expect(sqlite.prepare('SELECT result FROM connector_operation_audit').all()).toEqual([
      { result: 'success' },
      { result: 'success' },
      { result: 'conflict' },
      { result: 'success' },
    ]);
  });
  it('never repeats a write with uncertain outcome', async () => {
    const run = vi.fn(async () => {
      throw new Error('canary-secret-error');
    });
    await expect(
      executeConnectorWrite(ctx, 'sam_chat_start', { projectId: 'project' }, run)
    ).rejects.toThrow('canary-secret-error');
    await expect(
      executeConnectorWrite(ctx, 'sam_chat_start', { projectId: 'project' }, run)
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(sqlite.prepare('SELECT * FROM connector_operation_audit').all())
    ).not.toContain('canary-secret-error');
  });
  it('atomic parallel budget admits exactly the configured count, resets and isolates users', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => consumeConnectorBudget(ctx.env, 'owner', 'read', 3, 60_000))
    );
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
    await consumeConnectorBudget(ctx.env, 'other', 'read', 3, 60_000);
    vi.setSystemTime(new Date('2026-10-09T00:01:00Z'));
    await consumeConnectorBudget(ctx.env, 'owner', 'read', 3, 60_000);
  });
  it('daily start cap blocks provisioning but permits unrelated writes', async () => {
    sqlite.exec(
      `INSERT INTO platform_settings(key,value) VALUES ('connector.maxStartsPerUserPerDay','1')`
    );
    const run = vi.fn(async () => ({ taskId: 'task' }));
    await executeConnectorWrite(ctx, 'sam_chat_start', { projectId: 'project' }, run);
    await expect(
      executeConnectorWrite(
        { ...ctx, idempotencyKey: 'new' },
        'sam_chat_start',
        { projectId: 'project' },
        run
      )
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(run).toHaveBeenCalledTimes(1);
    await executeConnectorWrite(
      { ...ctx, idempotencyKey: 'idea' },
      'sam_idea_create',
      { projectId: 'project' },
      run
    );
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('write switch and missing scope fail before the side effect', async () => {
    const run = vi.fn(async () => ({}));
    await expect(
      executeConnectorWrite(
        { ...ctx, actor: { ...ctx.actor, scopes: new Set(['sam.read']) } },
        'sam_idea_create',
        { projectId: 'project' },
        run
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
    sqlite.exec(
      `INSERT INTO platform_settings(key,value) VALUES ('connector.writeEnabled','false')`
    );
    await expect(
      executeConnectorWrite(ctx, 'sam_idea_create', { projectId: 'project' }, run)
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(run).not.toHaveBeenCalled();
  });
});
