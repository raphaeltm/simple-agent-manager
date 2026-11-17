/**
 * Insights slice U on a real SQL engine with the shipped migration 0253, so the upsert's
 * ON CONFLICT key, the per-column MAX and the reads' project predicates are evaluated by SQLite,
 * not a mock (rules 11, 28).
 */
import { readRunUsage, summarizeRunTokens } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { invalidateAdminSettings } from '../../../src/services/admin-settings';
import {
  recordHarnessRunUsage,
  recordHarnessTokenReport,
  recordProxyRunUsage,
  type RunUsageScope,
} from '../../../src/services/agent-run-usage';
import { applySqliteMigration, createSqliteD1 } from '../../helpers/sqlite-d1';

const MIGRATION = new URL('../../../src/db/migrations/0253_agent_run_usage.sql', import.meta.url);

const scope = (overrides: Partial<RunUsageScope> = {}): RunUsageScope => ({
  projectId: 'project-a',
  chatSessionId: 'chat-1',
  workspaceId: 'ws-1',
  agentSessionId: 'as-1',
  agentType: 'claude-code',
  credentialReference: 'cc_credentials:cred-key',
  credentialSource: 'user',
  ...overrides,
});

const opus = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  model: 'claude-opus-5-5',
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  reasoningTokens: null,
});

describe('agent_run_usage writers and reads', () => {
  let sqlite: Database.Database;
  let env: Env;
  const cap = (n: number) => {
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)'
      )
      .run('insights.runUsageMaxRowsPerSession', String(n), new Date().toISOString());
    invalidateAdminSettings(env);
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    applySqliteMigration(sqlite, MIGRATION);
    sqlite.exec(
      'CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)'
    );
    sqlite.exec(`CREATE TABLE cc_credentials (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, kind TEXT);
      INSERT INTO cc_credentials VALUES ('cred-key', 'u', 'Anthropic key', 'api-key'),
        ('cred-max', 'u', 'Claude Max', 'oauth-token');`);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
  });
  afterEach(() => sqlite.close());

  const read = (projectId = 'project-a', chatSessionId = 'chat-1') =>
    readRunUsage(env.DATABASE, { projectId, chatSessionId, maxRows: 64 });

  it('counts the same report once when it arrives twice', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(100, 20, 1000, 50)]);
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(100, 20, 1000, 50)]);
    const usage = await read();
    expect(usage?.models).toEqual([
      expect.objectContaining({
        model: 'claude-opus-5-5',
        input: 100,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 50,
      }),
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 1 });
  });

  it('never lowers a total when an older report arrives after a newer one', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(300, 60, 5000, 50)]);
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(100, 20, 1000, 50)]);
    expect((await read())?.models[0]).toMatchObject({ input: 300, output: 60, cacheRead: 5000 });
  });

  it('adds a new epoch (a restarted agent) to the earlier one', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(100, 20)]);
    await recordHarnessRunUsage(env, scope({ agentSessionId: 'as-2' }), 'epoch-2', [opus(40, 5)]);
    expect((await read())?.models[0]).toMatchObject({ input: 140, output: 25 });
  });

  it('atomically caps client-selected epochs while preserving cumulative updates', async () => {
    cap(2);
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(10, 1)]);
    await recordHarnessRunUsage(env, scope(), 'epoch-2', [opus(20, 2)]);

    // Lowering policy below existing cardinality must still allow non-growing cumulative updates.
    cap(1);
    expect(await recordHarnessRunUsage(env, scope(), 'epoch-3', [opus(30, 3)])).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 2 });

    await recordHarnessRunUsage(env, scope(), 'epoch-2', [opus(25, 4)]);
    expect((await read())?.models[0]).toMatchObject({ input: 35, output: 5 });
  });

  it('updates existing keys in a mixed over-cap report without admitting any novel model', async () => {
    cap(2);
    await recordHarnessRunUsage(env, scope(), 'e', [opus(10, 1)]);
    await recordHarnessRunUsage(env, scope(), 'other', [opus(5, 1)]);
    await recordHarnessRunUsage(env, scope(), 'e', [
      opus(20, 2),
      { ...opus(9, 1), model: 'novel' },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 2 });
    expect((await read())?.models[0]).toMatchObject({ input: 25, output: 3 });
  });

  it('admits a whole novel model set or none and groups equivalent trimmed model names', async () => {
    cap(2);
    expect(
      await recordHarnessRunUsage(env, scope(), 'e', [
        opus(10, 1),
        { ...opus(20, 2), model: ' claude-opus-5-5 ' },
      ])
    ).toBe(1);
    expect(
      await recordHarnessRunUsage(env, scope(), 'new', [
        opus(30, 3),
        { ...opus(40, 4), model: 'other' },
      ])
    ).toBe(0);
    expect((await read())?.models[0]).toMatchObject({ input: 20, output: 2 });
  });

  it('does not reset the lifetime bound across credential changes and isolates projects and chats', async () => {
    cap(1);
    await recordHarnessRunUsage(env, scope(), 'e', [opus(10, 1)]);
    expect(
      await recordHarnessRunUsage(
        env,
        scope({ credentialReference: 'cc_credentials:rotated' }),
        'e',
        [opus(20, 2)]
      )
    ).toBe(0);
    expect(
      await recordHarnessRunUsage(env, scope({ projectId: 'project-b' }), 'e', [opus(20, 2)])
    ).toBe(1);
    expect(
      await recordHarnessRunUsage(env, scope({ chatSessionId: 'chat-b' }), 'e', [opus(20, 2)])
    ).toBe(1);
  });

  it('bounds the default at 256 rows and retains old history and updates if settings fail', async () => {
    for (let index = 0; index < 257; index++) {
      await recordHarnessRunUsage(env, scope(), `epoch-${index}`, [opus(1, 1)]);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 256 });
    sqlite.exec('DROP TABLE platform_settings');
    invalidateAdminSettings(env);
    expect(await recordHarnessRunUsage(env, scope(), 'new', [opus(2, 2)])).toBe(0);
    expect(await recordHarnessRunUsage(env, scope(), 'epoch-0', [opus(3, 3)])).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 256 });
  });

  it('never widens a configured low cap during a settings outage', async () => {
    cap(1);
    await recordHarnessRunUsage(env, scope(), 'e', [opus(10, 1)]);
    sqlite.exec('DROP TABLE platform_settings');
    invalidateAdminSettings(env);
    expect(await recordHarnessRunUsage(env, scope(), 'new', [opus(20, 2)])).toBe(0);
    expect(await recordHarnessRunUsage(env, scope(), 'e', [opus(30, 3)])).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 1 });
  });

  it('preserves a large legacy over-cap history without scanning it for admission', async () => {
    cap(2);
    sqlite.exec(`WITH RECURSIVE epochs(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM epochs WHERE n<10000)
      INSERT INTO agent_run_usage(project_id,chat_session_id,source,usage_epoch,model,credential_key,input_tokens,created_at,updated_at)
      SELECT 'project-a','chat-1','harness','legacy-'||n,'claude-opus-5-5','cc_credentials:cred-key',1,0,0 FROM epochs`);
    let issuedSql = '';
    let issuedBinds: unknown[] = [];
    const real = env.DATABASE;
    env.DATABASE = new Proxy(real, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.startsWith('WITH report')) return statement;
            issuedSql = query;
            return new Proxy(statement, {
              get(object, method) {
                if (method === 'bind')
                  return (...values: unknown[]) => {
                    issuedBinds = values;
                    return object.bind(...values);
                  };
                const value = Reflect.get(object, method);
                return typeof value === 'function' ? value.bind(object) : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await recordHarnessRunUsage(env, scope(), 'new', [opus(2, 2)])).toBe(0);
    expect(await recordHarnessRunUsage(env, scope(), 'legacy-10000', [opus(3, 3)])).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 10001 });
    const plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + issuedSql).all(...issuedBinds) as Array<{
      detail: string;
    }>;
    expect(plan.some((row) => row.detail.includes('MATERIALIZE usage_counts'))).toBe(true);
    expect(
      plan
        .filter((row) => row.detail.includes('agent_run_usage'))
        .every((row) => row.detail.includes('COVERING INDEX idx_agent_run_usage_key'))
    ).toBe(true);
    // Static work-shape guard: real SQL includes the bound, above behavioral test proves history survives.
    expect(issuedSql).toContain('LIMIT (SELECT max_rows + 1 FROM report)');
  });

  it('adds proxy responses and prefers the proxy over the harness for the same run', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(999, 999)]);
    const measured = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: null,
    };
    await recordProxyRunUsage(env, scope(), 'claude-opus-5-5', measured);
    await recordProxyRunUsage(env, scope(), 'claude-opus-5-5', measured);
    const usage = await read();
    expect(usage?.source).toBe('ai_proxy');
    expect(usage?.models).toEqual([
      expect.objectContaining({ input: 20, output: 8, cacheRead: 200 }),
    ]);
  });

  it('skips a proxied workspace that has no run (no chat session)', async () => {
    const measured = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: null,
    };
    await recordProxyRunUsage(env, { ...scope(), chatSessionId: null }, 'm', measured);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 0 });
  });

  it('stores the credential key, never a long legacy reference', async () => {
    const legacy = `cc_credentials:cred-${'KgCluaQx9+Ga5+i+JTSMVBxORYB/j3L90fcFFZrC4rik9mbQ2'.repeat(3)}:iv`;
    await recordHarnessRunUsage(env, scope({ credentialReference: legacy }), 'epoch-1', [
      opus(1, 1),
    ]);
    const row = sqlite.prepare('SELECT credential_key FROM agent_run_usage').get() as {
      credential_key: string;
    };
    expect(row.credential_key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('logs and swallows a failed callback write so the limit observations still land', async () => {
    sqlite.exec('DROP TABLE agent_run_usage');
    await expect(
      recordHarnessTokenReport(env, scope(), {
        epoch: 'e',
        models: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
      })
    ).resolves.toBeUndefined();
  });

  describe('project scope (attack and owner control)', () => {
    beforeEach(async () => {
      await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(100, 20)]);
    });

    it('reads nothing for the same chat session id addressed through another project', async () => {
      expect(await read('project-b', 'chat-1')).toBeNull();
      expect(summarizeRunTokens(await read('project-b', 'chat-1'))).toEqual({
        state: 'not_reported',
      });
    });

    it('reads the owner project’s run', async () => {
      expect(summarizeRunTokens(await read('project-a', 'chat-1'))).toMatchObject({
        state: 'reported',
        total: { input: 100, output: 20 },
      });
    });
  });

  it('shows spend only for API-key accounts', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(1_000_000, 100_000)]);
    await recordHarnessRunUsage(
      env,
      scope({ chatSessionId: 'chat-max', credentialReference: 'cc_credentials:cred-max' }),
      'e',
      [opus(5, 5)]
    );
    await recordHarnessRunUsage(
      env,
      scope({ chatSessionId: 'chat-none', credentialReference: null }),
      'e',
      [opus(5, 5)]
    );

    const keyed = summarizeRunTokens(await read('project-a', 'chat-1'));
    expect(keyed).toMatchObject({
      state: 'reported',
      spend: { state: 'estimate', unpricedModels: [] },
    });
    if (keyed.state !== 'reported' || keyed.spend.state !== 'estimate')
      throw new Error('expected estimate');
    // Opus 5.5 catalog prices: $0.005 / 1K input, $0.025 / 1K output.
    expect(keyed.spend.usd).toBeCloseTo(5 + 2.5, 6);

    expect(summarizeRunTokens(await read('project-a', 'chat-max'))).toMatchObject({
      spend: { state: 'not_applicable' },
    });
    expect(summarizeRunTokens(await read('project-a', 'chat-none'))).toMatchObject({
      spend: { state: 'unknown_account' },
    });
  });

  it('hides the spend of another member’s personal key', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(1_000, 100)]);
    expect(summarizeRunTokens(await read(), { spendVisible: false })).toMatchObject({
      spend: { state: 'private' },
      models: [{ estimatedSpendUsd: null }],
    });
  });

  it('never fails the read when summed counters exceed the integer range', async () => {
    // Writes clamp each counter; rows written past the ceiling (hostile or buggy) still read.
    sqlite.exec(`INSERT INTO agent_run_usage (project_id, chat_session_id, source, usage_epoch, model,
      credential_key, input_tokens, created_at, updated_at) VALUES
      ('project-a', 'chat-1', 'harness', 'e1', 'm', '', 9000000000000000000, 0, 0),
      ('project-a', 'chat-1', 'harness', 'e2', 'm', '', 9000000000000000000, 0, 0)`);
    await expect(read()).resolves.not.toBeNull();
  });

  it('clamps a counter to the report ceiling on write', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(Number.MAX_SAFE_INTEGER, 1)]);
    const row = sqlite.prepare('SELECT input_tokens FROM agent_run_usage').get() as {
      input_tokens: number;
    };
    expect(row.input_tokens).toBe(1_000_000_000_000);
  });

  it('skips one unreadable row instead of failing the read', async () => {
    await recordHarnessRunUsage(env, scope(), 'epoch-1', [opus(10, 1)]);
    sqlite.exec(`INSERT INTO agent_run_usage (project_id, chat_session_id, source, usage_epoch, model,
      credential_key, input_tokens, created_at, updated_at)
      VALUES ('project-a', 'chat-1', 'harness', 'epoch-x', 'bad', '', -5, 0, 0)`);
    const usage = await read();
    expect(usage?.models.map((row) => row.model)).toEqual(['claude-opus-5-5']);
  });
});
