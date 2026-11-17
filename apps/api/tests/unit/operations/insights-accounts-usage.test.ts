/**
 * Insights · Accounts tokens and spend (A2) against a real SQL engine. Usage rows are written by
 * the production writers (`recordHarnessRunUsage`, `recordProxyRunUsage`), so the stored keys and
 * sources are the ones the callback and the AI proxy produce. Every refusal is paired with an
 * owner control, and each guard was deleted once to confirm its test goes red (see the PR).
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectAccounts } from '@simple-agent-manager/operations';
import {
  accountUsageStatement,
  parseAccountUsageRows,
} from '@simple-agent-manager/operations/internal/insights-run-usage';
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import {
  recordHarnessRunUsage,
  recordProxyRunUsage,
  type RunUsageModelCounts,
} from '../../../src/services/agent-run-usage';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const ref = (id: string) => `cc_credentials:${id}`;
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

/** Catalog price of plain input/output tokens, computed here from the catalog, not the code. */
function catalogUsd(model: string, input: number, output: number): number {
  const price = PLATFORM_AI_MODELS.find((m) => m.id === model);
  if (!price) throw new Error(`no catalog price for ${model}`);
  return (input * price.costPer1kInputTokens + output * price.costPer1kOutputTokens) / 1000;
}

function counts(model: string, input: number, output: number): RunUsageModelCounts {
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
  };
}

describe('projectAccounts tokens and spend', () => {
  let sqlite: Database.Database;
  let env: Env;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
    };
  }

  function insert(table: string, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  function credential(id: string, ownerId: string, name: string, kind: string): void {
    insert('cc_credentials', {
      id,
      owner_id: ownerId,
      name,
      kind,
      encrypted_token: 'ciphertext-never-read',
      iv: 'iv-never-read',
    });
  }

  /** A finished run of project p on `credentialId`, merged when `merged` is set. */
  function run(
    id: string,
    credentialId: string,
    options: { userId?: string; source?: string; merged?: boolean } = {}
  ): void {
    const userId = options.userId ?? 'owner';
    insert('workspaces', {
      id: `w-${id}`,
      project_id: 'p',
      user_id: userId,
      name: `ws ${id}`,
      repository: 'acme/app',
      branch: 'main',
      status: 'deleted',
      vm_size: 'small',
      vm_location: 'fsn1',
    });
    insert('agent_sessions', {
      id: `s-${id}`,
      workspace_id: `w-${id}`,
      user_id: userId,
      status: 'stopped',
      agent_type: 'claude-code',
      agent_credential_source: options.source ?? 'user',
      agent_credential_reference: ref(credentialId),
    });
    const prUrl = options.merged ? `https://github.com/acme/app/pull/${id}` : null;
    insert('tasks', {
      id,
      project_id: 'p',
      user_id: userId,
      title: `Run ${id}`,
      status: 'completed',
      task_mode: 'task',
      is_idea: 0,
      workspace_id: `w-${id}`,
      created_at: daysAgo(3),
      updated_at: daysAgo(2),
      completed_at: daysAgo(2),
      output_pr_url: prUrl,
    });
    if (prUrl) {
      insert('pull_requests', {
        id: `pr-${id}`,
        project_id: 'p',
        repository: 'acme/app',
        number: 100 + sqlite.prepare('SELECT count(*) AS n FROM pull_requests').pluck().get(),
        url: prUrl,
        state: 'merged',
        merged_at: daysAgo(2),
        created_at: daysAgo(3),
        updated_at: daysAgo(2),
        last_synced_at: daysAgo(2),
      });
    }
  }

  /** The VM agent's cumulative report for run `id`, written by the production writer. */
  async function harness(
    id: string,
    credentialId: string | null,
    models: RunUsageModelCounts[],
    options: { projectId?: string; source?: string; agoMs?: number } = {}
  ): Promise<void> {
    await recordHarnessRunUsage(
      env,
      {
        projectId: options.projectId ?? 'p',
        chatSessionId: `chat-${id}`,
        workspaceId: `w-${id}`,
        agentSessionId: `s-${id}`,
        agentType: 'claude-code',
        credentialReference: credentialId ? ref(credentialId) : null,
        credentialSource: options.source ?? 'user',
      },
      'epoch-1',
      models,
      NOW - (options.agoMs ?? DAY)
    );
  }

  /** One measured AI proxy response for run `id`, written by the production writer. */
  async function proxied(
    id: string,
    credentialId: string,
    model: string,
    input: number,
    output: number,
    projectId = 'p'
  ): Promise<void> {
    await recordProxyRunUsage(
      env,
      {
        projectId,
        chatSessionId: `chat-${id}`,
        workspaceId: `w-${id}`,
        agentSessionId: `s-${id}`,
        agentType: 'claude-code',
        credentialReference: ref(credentialId),
        credentialSource: 'user',
      },
      model,
      {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
      },
      NOW - DAY
    );
  }

  async function accounts(viewer = 'owner') {
    const result = await projectAccounts(ctx(viewer), { projectId: 'p', range: '7d', nowMs: NOW });
    return { result, byKey: Object.fromEntries(result.accounts.map((a) => [a.key, a])) };
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // The writers upsert on the unique key, and the read seeks the project/updated index.
    createDeclaredIndexes(sqlite, [schema.agentRunUsage]);
    sqlite.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('mate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO projects (id, name, repository, user_id) VALUES ('p', 'Project', 'acme/app', 'owner'),
        ('foreign', 'Other', 'acme/app', 'outsider');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','mate','member','active'), ('foreign','outsider','owner','active');
    `);
    credential('cc-key', 'owner', 'Work API key', 'api-key');
    credential('cc-key2', 'owner', 'Spare API key', 'api-key');
    credential('cc-max', 'owner', 'Personal Max', 'oauth-token');
    credential('cc-compat', 'owner', 'Local gateway', 'openai-compatible');
    credential('cc-mate-key', 'mate', 'Mate Secret Key', 'api-key');
    credential('cc-shared-key', 'mate', 'Team key', 'api-key');
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('estimates an API key’s spend and divides it by merged runs; a subscription shows tokens only', async () => {
    run('k1', 'cc-key', { merged: true });
    run('k2', 'cc-key');
    run('m1', 'cc-max', { merged: true });
    run('n1', 'cc-key2');
    await harness('k1', 'cc-key', [counts(SONNET, 100_000, 10_000)]);
    await harness('k2', 'cc-key', [counts(HAIKU, 200_000, 20_000)]);
    await harness('m1', 'cc-max', [counts(SONNET, 50_000, 5_000)]);

    const { byKey } = await accounts();
    const expected = catalogUsd(SONNET, 100_000, 10_000) + catalogUsd(HAIKU, 200_000, 20_000);
    expect(expected).toBeGreaterThan(0);
    const key = byKey['cred:cc-key'];
    expect(key).toMatchObject({ runs: 2, merged: 1 });
    expect(key?.tokens).toEqual({ total: 330_000, perMergedPullRequest: 330_000 });
    expect(key?.spend).toMatchObject({ state: 'reported', unpricedModels: [] });
    if (key?.spend?.state !== 'reported') throw new Error('spend not reported');
    expect(key.spend.costUsd).toBeCloseTo(expected, 6);
    expect(key.spend.perMergedPullRequestUsd).toBeCloseTo(expected, 6);
    // A subscription: tokens, no money.
    expect(byKey['cred:cc-max']).toMatchObject({
      kind: 'subscription',
      tokens: { total: 55_000, perMergedPullRequest: 55_000 },
      spend: null,
    });
    // An API key with runs but no measured usage keeps "not reported".
    expect(byKey['cred:cc-key2']).toMatchObject({
      tokens: null,
      spend: { state: 'not_reported' },
    });
  });

  it('never counts another project’s usage (attack + owner control)', async () => {
    run('k1', 'cc-key');
    await harness('k1', 'cc-key', [counts(SONNET, 1_000, 100)]);
    // The same credential and chat id, written under the foreign project.
    await harness('k1', 'cc-key', [counts(SONNET, 9_000_000, 900_000)], { projectId: 'foreign' });
    await harness('fx', 'cc-key', [counts(SONNET, 7_000_000, 0)], { projectId: 'foreign' });

    const { byKey } = await accounts();
    // Owner control: p's own usage is there, and only it.
    expect(byKey['cred:cc-key']?.tokens?.total).toBe(1_100);
    // The foreign project reads only its own rows, and p is not visible to its owner.
    await expect(
      projectAccounts(ctx('outsider'), { projectId: 'p', nowMs: NOW })
    ).rejects.toThrow();
  });

  it('counts a proxied run once, from the AI proxy rows', async () => {
    run('k1', 'cc-key');
    run('k2', 'cc-key');
    // k1 went through SAM's AI proxy: the harness reports the same calls the proxy measured.
    await harness('k1', 'cc-key', [counts(SONNET, 100_000, 10_000)]);
    await proxied('k1', 'cc-key', SONNET, 60_000, 6_000);
    await proxied('k1', 'cc-key', SONNET, 40_000, 4_000);
    // k2 did not; a foreign project's proxy row on the same chat id must not hide k2's harness rows.
    await harness('k2', 'cc-key', [counts(HAIKU, 5_000, 500)]);
    await proxied('k2', 'cc-key', HAIKU, 1, 1, 'foreign');

    const { byKey } = await accounts();
    expect(byKey['cred:cc-key']?.tokens?.total).toBe(110_000 + 5_500);
    const spend = byKey['cred:cc-key']?.spend;
    if (spend?.state !== 'reported') throw new Error('spend not reported');
    expect(spend.costUsd).toBeCloseTo(
      catalogUsd(SONNET, 100_000, 10_000) + catalogUsd(HAIKU, 5_000, 500),
      6
    );
  });

  it('keeps a teammate’s personal key private: tokens grouped by kind, no key, no spend', async () => {
    run('k1', 'cc-key');
    run('t1', 'cc-mate-key', { userId: 'mate' });
    run('s1', 'cc-shared-key', { userId: 'mate', source: 'project' });
    await harness('k1', 'cc-key', [counts(SONNET, 1_000, 100)]);
    await harness('t1', 'cc-mate-key', [counts(SONNET, 20_000, 2_000)]);
    await harness('s1', 'cc-shared-key', [counts(HAIKU, 30_000, 3_000)], { source: 'project' });

    const { result, byKey } = await accounts('owner');
    expect(byKey['teammate:claude-code:api_key']).toMatchObject({
      name: null,
      tokens: { total: 22_000, perMergedPullRequest: null },
      spend: { state: 'private' },
    });
    // A project key is shared: every member sees its spend (owner control for "private").
    expect(byKey['project:claude-code:api_key']?.spend).toMatchObject({ state: 'reported' });
    expect(byKey['project:claude-code:api_key']?.tokens?.total).toBe(33_000);
    const body = JSON.stringify(result);
    expect(body).not.toContain('cc-mate-key');
    expect(body).not.toContain('Mate Secret Key');

    // The key's owner sees it by name, with its spend.
    const mine = await accounts('mate');
    expect(mine.byKey['cred:cc-mate-key']).toMatchObject({
      name: 'Mate Secret Key',
      spend: { state: 'reported' },
      tokens: { total: 22_000 },
    });
    expect(mine.byKey['teammate:claude-code:api_key']?.spend).toEqual({ state: 'private' });
  });

  it('withholds another member’s credential key in SQL (the redaction on its own)', async () => {
    run('t1', 'cc-mate-key', { userId: 'mate' });
    run('k1', 'cc-key');
    await harness('t1', 'cc-mate-key', [counts(SONNET, 20_000, 2_000)]);
    await harness('k1', 'cc-key', [counts(SONNET, 1_000, 100)]);
    const statement = accountUsageStatement({
      projectId: 'p',
      viewerId: 'owner',
      sinceMs: NOW - 7 * DAY,
      maxRows: 50,
    });
    const rows = sqlite.prepare(statement.sql).all(...statement.binds) as Array<{
      ref: string | null;
      redacted: number;
    }>;
    expect(rows).toHaveLength(2);
    // Owner control: the viewer's own key comes back.
    expect(rows.find((row) => row.redacted === 0)?.ref).toBe(ref('cc-key'));
    // The teammate's does not.
    expect(rows.find((row) => row.redacted === 1)?.ref).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('cc-mate-key');
  });

  it('names an unpriced model and makes the total partial; a custom endpoint is never priced', async () => {
    run('k1', 'cc-key', { merged: true });
    run('c1', 'cc-compat');
    await harness('k1', 'cc-key', [
      counts(SONNET, 10_000, 1_000),
      counts('mystery-model-9', 50_000, 5_000),
    ]);
    await harness('c1', 'cc-compat', [counts(SONNET, 10_000, 1_000)]);

    const { byKey } = await accounts();
    const spend = byKey['cred:cc-key']?.spend;
    if (spend?.state !== 'reported') throw new Error('spend not reported');
    expect(spend.unpricedModels).toEqual(['mystery-model-9']);
    // Only the priced model is summed; nothing is guessed for the other.
    expect(spend.costUsd).toBeCloseTo(catalogUsd(SONNET, 10_000, 1_000), 6);
    expect(byKey['cred:cc-key']?.tokens?.total).toBe(66_000);
    // An OpenAI-compatible endpoint is an API key, but SAM's catalog does not price it.
    expect(byKey['cred:cc-compat']?.spend).toEqual({
      state: 'reported',
      costUsd: null,
      perMergedPullRequestUsd: null,
      unpricedModels: [SONNET],
    });
  });

  it('reads only the range, and seeks it through the project/updated index', async () => {
    createDeclaredIndexes(sqlite, [schema.agentSessions, schema.workspaces]);
    run('k1', 'cc-key');
    await harness('k1', 'cc-key', [counts(SONNET, 1_000, 0)], { agoMs: DAY });
    await harness('old', 'cc-key', [counts(SONNET, 999_000, 0)], { agoMs: 30 * DAY });
    for (let i = 0; i < 300; i += 1) {
      await harness(`f${i}`, 'cc-key', [counts(SONNET, 10, 0)], { projectId: 'foreign' });
    }
    const { byKey } = await accounts();
    expect(byKey['cred:cc-key']?.tokens?.total).toBe(1_000);

    const statement = accountUsageStatement({
      projectId: 'p',
      viewerId: 'owner',
      sinceMs: NOW - 7 * DAY,
      maxRows: 50,
    });
    const plan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.binds) as Array<{
        detail: string;
      }>
    ).map((row) => row.detail);
    expect(plan.join('\n')).toMatch(/SEARCH r USING INDEX idx_agent_run_usage_project_updated/);
    expect(plan.join('\n')).toMatch(/SEARCH p USING (COVERING )?INDEX idx_agent_run_usage_key/);
    expect(plan.filter((detail) => /^SCAN (r|p|s|w|c)\b/.test(detail))).toEqual([]);
  });

  it('keeps the largest rows under the cap and says it cut the rest', async () => {
    run('k1', 'cc-key');
    await harness('k1', 'cc-key', [counts(SONNET, 50_000, 0), counts(HAIKU, 10, 0)]);
    const statement = accountUsageStatement({
      projectId: 'p',
      viewerId: 'owner',
      sinceMs: NOW - 7 * DAY,
      maxRows: 1,
    });
    const raw = sqlite.prepare(statement.sql).all(...statement.binds) as Record<string, unknown>[];
    const read = parseAccountUsageRows(raw, { projectId: 'p', maxRows: 1 });
    expect(read.limited).toBe(true);
    expect(read.rows.map((row) => row.model)).toEqual([SONNET]);
    // Control: under a cap that fits, nothing is cut.
    expect(parseAccountUsageRows(raw, { projectId: 'p', maxRows: 2 }).limited).toBe(false);

    // Through the operation: the setting reaches the read and the page says it is a floor.
    const base = ctx();
    const capped: OperationContext = {
      ...base,
      ports: {
        ...base.ports,
        settings: {
          ...base.ports.settings,
          resolveDetailsMany: async (names: readonly string[]) =>
            names.map((name) => ({ value: name === 'insights.accountsUsageRowCap' ? 50 : null })),
        },
      } as OperationContext['ports'],
    };
    for (let i = 0; i < 60; i += 1) {
      await harness('k1', 'cc-key', [counts(`model-${i}`, 100 + i, 0)]);
    }
    const result = await projectAccounts(capped, { projectId: 'p', range: '7d', nowMs: NOW });
    expect(result.usageLimited).toBe(true);
    expect((await accounts()).result.usageLimited).toBe(false);
  });

  it('skips a malformed usage row and keeps the good ones', () => {
    const good = {
      ref: ref('cc-key'),
      redacted: 0,
      source: 'user',
      agent_type: 'claude-code',
      kind: 'api-key',
      cred_own: 1,
      session_own: 1,
      model: SONNET,
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: null,
    };
    const read = parseAccountUsageRows(
      [good, { ...good, input_tokens: -5 }, { ...good, model: HAIKU }],
      { projectId: 'p', maxRows: 10 }
    );
    expect(read.rows.map((row) => row.model)).toEqual([SONNET, HAIKU]);
    expect(
      parseAccountUsageRows([{ ...good, redacted: 'yes' }], { projectId: 'p', maxRows: 10 }).rows
    ).toEqual([]);
  });
});
