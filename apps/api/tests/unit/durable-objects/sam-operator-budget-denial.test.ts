import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { incrementProviderUsage } from '@simple-agent-manager/ai-proxy';
import { DEFAULT_SAM_MODEL } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { OperatorController } from '../../../src/durable-objects/sam-session/operator/controller';
import * as model from '../../../src/durable-objects/sam-session/operator/model';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

async function fixture(administrator: boolean | null, cancelDuringBudgetRead = false) {
  const database = new Database(':memory:');
  const privateDatabase = new Database(':memory:');
  databases.push(database, privateDatabase);
  createSchemaTables(database, [schema.users, schema.platformSettings]);
  database.exec(
    "INSERT INTO users(id,name,email,status,role) VALUES ('owner','Owner','owner@example.test','active','user')"
  );
  if (administrator)
    database
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES (?,?,?)')
      .run('aiProxy.perUserMonthlyCostCeilingUsd', '1', new Date().toISOString());
  const rows = new Map<string, string>();
  let onSpendRead: (() => void) | undefined;
  if (administrator === false)
    rows.set('ai-budget-settings:owner', JSON.stringify({ monthlyCostCapUsd: 1 }));
  const kv = {
    get: async (key: string, type?: string) => {
      if (key.startsWith('ai-provider-usage:')) onSpendRead?.();
      const value = rows.get(key) ?? null;
      return value === null ? null : type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      rows.set(key, value);
    },
  } as unknown as KVNamespace;
  const env = { DATABASE: createSqliteD1(database), KV: kv, BASE_DOMAIN: 'example.test' } as Env;
  if (administrator !== null)
    await incrementProviderUsage(
      kv,
      'owner',
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        dialect: 'openai',
      },
      1,
      1,
      env,
      2
    );
  const pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      transactionSync: <T>(fn: () => T) => privateDatabase.transaction(fn)(),
      setAlarm: vi.fn(async () => undefined),
      deleteAlarm: vi.fn(async () => undefined),
    },
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  } as unknown as DurableObjectState;
  const controller = new OperatorController(ctx, env, createSqlStorage(privateDatabase));
  controller.store.bindUser('owner');
  controller.store.setEnabled(true);
  const provider = vi.fn(async () => {
    throw new Error('PRIVATE PROVIDER DIAGNOSTIC');
  });
  const languageModel = createOpenAICompatible({
    name: 'budget-test',
    baseURL: 'https://provider.example.test/v1',
    apiKey: 'unused',
    fetch: provider,
  }).chatModel(DEFAULT_SAM_MODEL);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(model, 'resolveOperatorModel').mockImplementation(async () => {
    await barrier;
    return languageModel;
  });
  const request = (path: string, body?: unknown) =>
    new Request(`https://sam-session${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-sam-user-id': 'owner' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const accepted = await controller.handle(
    request('/turns', { requestKey: 'test', message: 'Hello' })
  );
  expect(accepted?.status).toBe(202);
  const turn = controller.store.active()!;
  const stream = await controller.handle(request(`/turns/${turn.id}/stream`));
  expect(stream?.status).toBe(200);
  const streamed = stream!.text();
  if (cancelDuringBudgetRead)
    onSpendRead = () => {
      controller.store.setState(turn.id, 'cancelled', null, 'Cancelled by user');
    };
  release();
  await Promise.all(pending);
  return { controller, request, provider, streamed: await streamed, turn };
}

describe('operator budget denial through real Mastra prepareStep and controller', () => {
  it.each([true, false])(
    'persists monthly recovery advice for live-refetch clients, administrator=%s',
    async (administrator) => {
      const f = await fixture(administrator);
      expect(f.provider).not.toHaveBeenCalled();
      expect(f.streamed).toContain('"type":"done","state":"interrupted"');
      const history = await f.controller.handle(f.request('/turns'));
      const body = (await history!.json()) as { turns: Array<{ error: string }> };
      expect(body.turns[0]!.error).toContain(
        administrator
          ? 'Contact your administrator or wait until next month.'
          : 'Adjust your cap in Settings > Usage.'
      );
      expect(f.controller.store.turn(f.turn.id)?.error).toBe(body.turns[0]!.error);
    }
  );

  it('keeps unexpected provider failures generic', async () => {
    const f = await fixture(null);
    expect(f.provider).toHaveBeenCalled();
    const history = await f.controller.handle(f.request('/turns'));
    const body = (await history!.json()) as { turns: Array<{ error: string }> };
    expect(body.turns[0]!.error).toContain('SAM could not finish this turn.');
    expect(JSON.stringify(body)).not.toContain('PRIVATE PROVIDER DIAGNOSTIC');
    expect(f.streamed).not.toContain('PRIVATE PROVIDER DIAGNOSTIC');
  });

  it('does not replace cancellation when a monthly budget read finishes after it', async () => {
    const f = await fixture(true, true);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.controller.store.turn(f.turn.id)).toMatchObject({
      state: 'cancelled',
      error: 'Cancelled by user',
    });
    expect(f.streamed).toContain('"type":"done","state":"cancelled"');
  });
});
