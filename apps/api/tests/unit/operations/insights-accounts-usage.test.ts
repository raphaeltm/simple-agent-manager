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
  runUsageAdmissionHitStatement,
} from '@simple-agent-manager/operations/internal/insights-run-usage';
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { invalidateAdminSettings } from '../../../src/services/admin-settings';
import {
  recordHarnessRunUsage,
  recordProxyRunUsage,
  type RunUsageModelCounts,
} from '../../../src/services/agent-run-usage';
import { createDeclaredIndexes } from '../../helpers/sqlite-d1';
import {
  createAccountsTestDb,
  insertCredential,
  insertRow,
  insertRun,
  operationContext,
  withFailingStatement,
} from './insights-accounts-test-db';

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

  const ctx = (userId = 'owner'): OperationContext => operationContext(env, userId);
  const insert = (table: string, row: Record<string, string | number | null>) =>
    insertRow(sqlite, table, row);
  const credential = (id: string, ownerId: string, name: string, kind: string) =>
    insertCredential(sqlite, id, ownerId, name, kind);

  /** A finished run of project p on `credentialId`, merged when `merged` is set. */
  function run(
    id: string,
    credentialId: string,
    options: { userId?: string; source?: string; merged?: boolean } = {}
  ): void {
    const prUrl = options.merged ? `https://github.com/acme/app/pull/${id}` : null;
    insertRun(sqlite, id, {
      userId: options.userId,
      credentialReference: ref(credentialId),
      session: { agent_credential_source: options.source ?? 'user' },
      task: { output_pr_url: prUrl },
      taskTimes: { created: daysAgo(3), ended: daysAgo(2) },
    });
    if (!prUrl) return;
    insert('pull_requests', {
      id: `pr-${id}`,
      project_id: 'p',
      repository: 'acme/app',
      number: 100 + Number(sqlite.prepare('SELECT count(*) FROM pull_requests').pluck().get()),
      url: prUrl,
      state: 'merged',
      merged_at: daysAgo(2),
      created_at: daysAgo(3),
      updated_at: daysAgo(2),
      last_synced_at: daysAgo(2),
    });
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

  /** The usage statement's raw rows for the owner over the last week, straight from SQL. */
  function usageRows(maxRows = 50): Record<string, unknown>[] {
    const statement = accountUsageStatement({
      projectId: 'p',
      viewerId: 'owner',
      sinceMs: NOW - 7 * DAY,
      maxRows,
    });
    return sqlite.prepare(statement.sql).all(...statement.binds) as Record<string, unknown>[];
  }

  async function accounts(viewer = 'owner') {
    const result = await projectAccounts(ctx(viewer), { projectId: 'p', range: '7d', nowMs: NOW });
    return { result, byKey: Object.fromEntries(result.accounts.map((a) => [a.key, a])) };
  }

  beforeEach(() => {
    ({ sqlite, env } = createAccountsTestDb());
    // The writers upsert on the unique key, and the read seeks the project/updated index.
    createDeclaredIndexes(sqlite, [schema.agentRunUsage, schema.agentRunUsageAdmissionHits]);
    credential('cc-key', 'owner', 'Work API key', 'api-key');
    credential('cc-key2', 'owner', 'Spare API key', 'api-key');
    credential('cc-max', 'owner', 'Personal Max', 'oauth-token');
    credential('cc-compat', 'owner', 'Local gateway', 'openai-compatible');
    credential('cc-mate-key', 'mate', 'Mate Secret Key', 'api-key');
    credential('cc-shared-key', 'mate', 'Team key', 'api-key');
  });
  afterEach(() => sqlite.close());

  it('seeks refusal metadata and recent usage by project indexes at historical scale', () => {
    sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
      INSERT INTO agent_run_usage_admission_hits(project_id,chat_session_id,last_rejected_at)
      SELECT 'p','history-'||x,0 FROM n`);
    const statement = runUsageAdmissionHitStatement({ projectId: 'p', sinceMs: NOW - 7 * DAY });
    const plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + statement.sql).all(...statement.binds) as {
      detail: string;
    }[];
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain('idx_agent_run_usage_hits_project_rejected');
    expect(details).toContain('idx_agent_run_usage_project_updated');
    expect(details).not.toMatch(/SCAN [hrp](?:$|\s)/m);
    expect(sqlite.prepare(statement.sql).all(...statement.binds)).toEqual([]);
  });

  it('keeps a complete account exact when another account has rejected usage', async () => {
    sqlite.exec(
      "INSERT INTO platform_settings(key,value,updated_at) VALUES ('insights.runUsageMaxRowsPerSession','1','2026-11-16T12:00:00.000Z')"
    );
    invalidateAdminSettings(env);
    run('complete-account', 'cc-key');
    run('rejected-account', 'cc-key2');
    await harness('complete-account', 'cc-key', [counts(SONNET, 10, 1)]);
    await harness('rejected-account', 'cc-key2', [counts(SONNET, 20, 2), counts(HAIKU, 5, 1)]);
    expect(
      sqlite
        .prepare('SELECT chat_session_id, input_tokens, output_tokens FROM agent_run_usage')
        .all()
    ).toEqual([{ chat_session_id: 'chat-complete-account', input_tokens: 10, output_tokens: 1 }]);
    expect(usageRows()).toMatchObject([{ input_tokens: 10, output_tokens: 1 }]);
    const { result, byKey } = await accounts();
    expect(result).toMatchObject({ usageLimited: false, usageAdmissionLimited: true });
    expect(byKey['cred:cc-key']?.tokens).toMatchObject({ total: 11 });
    expect(byKey['cred:cc-key']?.spend).toMatchObject({ state: 'reported', unpricedModels: [] });
  });

  it('discloses a rejected report with no accepted rows only in its project and reporting window', async () => {
    sqlite.exec(
      "INSERT INTO platform_settings(key,value,updated_at) VALUES ('insights.runUsageMaxRowsPerSession','1','2026-11-16T12:00:00.000Z')"
    );
    invalidateAdminSettings(env);
    await harness('cap', 'cc-key', [counts(SONNET, 10, 1), counts(HAIKU, 5, 1)]);
    expect((await accounts()).result.usageAdmissionLimited).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 0 });
    sqlite
      .prepare('UPDATE agent_run_usage_admission_hits SET last_rejected_at = ?')
      .run(NOW - 8 * DAY);
    expect((await accounts()).result.usageAdmissionLimited).toBe(false);
    await harness('cap', 'cc-key', [counts(SONNET, 10, 1)]);
    // Even a recently updated admitted row remains incomplete after an older refusal.
    expect((await accounts()).result.usageAdmissionLimited).toBe(true);
    await proxied('cap', 'cc-key', SONNET, 10, 1);
    expect((await accounts()).result.usageAdmissionLimited).toBe(false);
    await harness('foreign-cap', 'cc-key', [counts(SONNET, 10, 1), counts(HAIKU, 5, 1)], {
      projectId: 'foreign',
    });
    expect((await accounts()).result.usageAdmissionLimited).toBe(false);
  });

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
    const rows = usageRows() as Array<{
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
    expect(plan.filter((detail) => /^SCAN (r|p|s|w|rw|c|sc)\b/.test(detail))).toEqual([]);
  });

  it('keeps the largest rows under the cap and says it cut the rest', async () => {
    run('k1', 'cc-key');
    await harness('k1', 'cc-key', [counts(SONNET, 50_000, 0), counts(HAIKU, 10, 0)]);
    const raw = usageRows(1);
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

  it('prices a long legacy key stored as a digest, and keeps a teammate’s one private', async () => {
    // A 2026-06 backfill id: its reference is longer than a limit key, so the writers store it as
    // a sha256 digest that names no credential row.
    const longOwn = `cc-legacy-${'x'.repeat(180)}`;
    const longMate = `cc-legacy-${'m'.repeat(180)}`;
    credential(longOwn, 'owner', 'Legacy key', 'api-key');
    credential(longMate, 'mate', 'Mate Legacy Key', 'api-key');
    run('l1', longOwn, { merged: true });
    run('l2', longMate, { userId: 'mate' });
    await harness('l1', longOwn, [counts(SONNET, 10_000, 1_000)]);
    await harness('l2', longMate, [counts(SONNET, 30_000, 3_000)]);
    // An AI proxy response with no agent session: ownership comes from the run's workspace.
    for (const [id, cred] of [
      ['l1', longOwn],
      ['l2', longMate],
    ] as const) {
      await recordProxyRunUsage(
        env,
        {
          projectId: 'p',
          chatSessionId: `chat-${id}-proxy`,
          workspaceId: `w-${id}`,
          agentSessionId: null,
          agentType: 'claude-code',
          credentialReference: ref(cred),
          credentialSource: 'user',
        },
        HAIKU,
        {
          inputTokens: 4_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: null,
        },
        NOW - DAY
      );
    }
    const stored = sqlite
      .prepare('SELECT credential_key FROM agent_run_usage ORDER BY chat_session_id')
      .pluck()
      .all() as string[];
    expect(stored.every((key) => key.startsWith('sha256:'))).toBe(true);

    const { result, byKey } = await accounts();
    const own = byKey[`cred:${longOwn}`];
    expect(own?.tokens?.total).toBe(15_000);
    expect(own?.spend).toMatchObject({ state: 'reported', unpricedModels: [] });
    if (own?.spend?.state !== 'reported') throw new Error('spend not reported');
    expect(own.spend.costUsd).toBeCloseTo(
      catalogUsd(SONNET, 10_000, 1_000) + catalogUsd(HAIKU, 4_000, 0),
      6
    );
    // The teammate's long key joins their group by kind, with tokens and no spend.
    expect(byKey['teammate:claude-code:api_key']).toMatchObject({
      tokens: { total: 33_000 },
      spend: { state: 'private' },
    });
    expect(JSON.stringify(result)).not.toContain(longMate);
    // The teammate's session-less proxy row stays hidden: no kind or owner to file it under, so it
    // is not shown rather than shown as the viewer's.
    expect(result.accounts.some((a) => a.tokens?.total === 4_000)).toBe(false);
  });

  it('trusts a session for key visibility only when it belongs to this project', async () => {
    // A key that names no credential row (deleted) is visible only for a run the viewer started.
    insert('workspaces', {
      id: 'w-fx',
      project_id: 'foreign',
      user_id: 'owner',
      name: 'foreign ws',
      repository: 'acme/app',
      branch: 'main',
      status: 'deleted',
      vm_size: 'small',
      vm_location: 'fsn1',
    });
    insert('agent_sessions', {
      id: 's-fx',
      workspace_id: 'w-fx',
      user_id: 'owner',
      status: 'stopped',
      agent_type: 'claude-code',
    });
    run('own', 'cc-key');
    // The run's own workspace and session are the foreign ones (w-fx, s-fx).
    await harness('fx', 'gone-attack', [counts(SONNET, 1_000, 0)]);
    // Owner control: the same deleted-credential shape on the viewer's own session in p.
    await harness('own', 'gone-own', [counts(SONNET, 2_000, 0)]);
    const rows = usageRows() as Array<{
      ref: string | null;
      redacted: number;
      input_tokens: number;
    }>;
    expect(rows.find((row) => row.input_tokens === 2_000)).toMatchObject({
      ref: ref('gone-own'),
      redacted: 0,
    });
    expect(rows.find((row) => row.input_tokens === 1_000)).toMatchObject({
      ref: null,
      redacted: 1,
    });
  });

  it('a failed usage read marks only tokens, and leaves runs alone', async () => {
    run('k1', 'cc-key');
    await harness('k1', 'cc-key', [counts(SONNET, 1_000, 100)]);
    env = {
      ...env,
      DATABASE: withFailingStatement(env.DATABASE, (sql) => sql.includes('FROM agent_run_usage r')),
    };
    const { result, byKey } = await accounts();
    expect(result.unavailable).toEqual(['tokens']);
    // Liveness: the runs still load; tokens and spend are absent rather than "not reported".
    expect(byKey['cred:cc-key']).toMatchObject({ runs: 1, tokens: null, spend: null });
  });
});
