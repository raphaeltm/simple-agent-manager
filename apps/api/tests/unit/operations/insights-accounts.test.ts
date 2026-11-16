/**
 * projectAccounts (Insights · Accounts) against a real SQL engine. Each case seeds a foreign
 * project's rows beside the owner's, rows that would change a count if a project predicate or a
 * join's project condition were missing (rules 11 and 28), and pairs every refusal with an
 * owner control. Limit waits are built by the production constructor (`newProviderLimitWait`),
 * and their keys by the shared `credentialLimitReferenceKey`, so the stored shape is the one the
 * writers produce.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectAccounts, projectFlow } from '@simple-agent-manager/operations';
import { accountRunsStatement } from '@simple-agent-manager/operations/internal/insights-accounts-sql';
import { flowWindow } from '@simple-agent-manager/operations/internal/insights-flow';
import { newProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import { credentialLimitReferenceKey } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const daysAgo = (days: number) => iso(days * DAY);
const ref = (id: string) => `cc_credentials:${id}`;
/** A 2026-06 backfill id: long enough that its limit key is a SHA-256 digest. */
const LONG_ID = `cc-legacy-${'x'.repeat(180)}`;

describe('projectAccounts', () => {
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

  /**
   * A finished run of project `projectId` on `credentialId` (null: no credential recorded),
   * with one workspace and one agent session, as production has.
   */
  function run(
    id: string,
    credentialId: string | null,
    fields: Record<string, string | number | null> = {},
    session: Record<string, string | number | null> = {}
  ): void {
    const projectId = (fields.project_id as string | undefined) ?? 'p';
    const userId = (session.user_id as string | undefined) ?? 'owner';
    insert('workspaces', {
      id: `w-${id}`,
      project_id: (fields.workspace_project_id as string | undefined) ?? projectId,
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
      agent_credential_source: 'user',
      agent_credential_reference: credentialId ? ref(credentialId) : null,
      ...session,
    });
    const taskFields = { ...fields };
    delete taskFields.workspace_project_id;
    insert('tasks', {
      id,
      project_id: projectId,
      user_id: userId,
      title: `Run ${id}`,
      status: 'completed',
      task_mode: 'task',
      is_idea: 0,
      workspace_id: `w-${id}`,
      created_at: daysAgo(6),
      updated_at: daysAgo(5),
      completed_at: daysAgo(5),
      ...taskFields,
    });
  }

  async function wait(
    taskId: string,
    credentialReference: string,
    observedAgo: number,
    options: { resetsInMs?: number; phase?: 'waiting' | 'blocked' | 'released' } = {}
  ): Promise<void> {
    const observedAt = NOW - observedAgo;
    const built = newProviderLimitWait({
      taskId,
      origin: 'callback',
      incidentId: `incident-${taskId}`,
      credentialKey: await credentialLimitReferenceKey(credentialReference),
      previous: null,
      now: observedAt,
      resetsAt: observedAt + (options.resetsInMs ?? 30 * MIN),
      jitter: 0,
    });
    const stored = { ...built, phase: options.phase ?? built.phase };
    sqlite
      .prepare('UPDATE tasks SET provider_limit_wait_json = ? WHERE id = ?')
      .run(JSON.stringify(stored), taskId);
  }

  async function rejectedWindow(
    credentialReference: string,
    windowType: string,
    observedAgo: number,
    resetsInMs: number | null,
    fields: Record<string, string | number | null> = {}
  ): Promise<void> {
    const observedAt = NOW - observedAgo;
    insert('credential_limit_windows', {
      project_id: 'p',
      credential_reference: (await credentialLimitReferenceKey(credentialReference)) as string,
      window_type: windowType,
      credential_source: 'user',
      provider: 'anthropic',
      provider_mode: 'direct',
      agent_type: 'claude-code',
      user_id: 'owner',
      source: 'claude-acp.rate_limit',
      status: 'rejected',
      last_event_level: 'rejected',
      utilization_percent: 100,
      window_minutes: windowType === 'claude.five_hour' ? 300 : 10080,
      resets_at: resetsInMs === null ? null : observedAt + resetsInMs,
      observed_at: observedAt,
      created_at: observedAt,
      updated_at: observedAt,
      ...fields,
    });
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('mate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO projects (id, name, repository, user_id) VALUES ('p', 'Project', 'acme/app', 'owner'),
        ('foreign', 'Other', 'acme/app', 'outsider');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','mate','member','active'), ('foreign','outsider','owner','active');
    `);
    credential('cc-max', 'owner', 'Personal Max', 'oauth-token');
    credential('cc-key', 'owner', 'Work API key', 'api-key');
    credential('cc-mate', 'mate', 'Mate Secret Name', 'oauth-token');
    credential('cc-mate2', 'mate', 'Mate Second Name', 'oauth-token');
    credential(LONG_ID, 'owner', 'Legacy Max', 'oauth-token');
    credential('cc-out', 'outsider', 'Outsider Name', 'oauth-token');
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('attributes runs to accounts: yours by name, teammates grouped by kind, never another project', async () => {
    run('a1', 'cc-max');
    run('a2', 'cc-max', { output_pr_url: 'https://github.com/acme/app/pull/1' });
    insert('pull_requests', {
      id: 'pr1',
      project_id: 'p',
      repository: 'acme/app',
      number: 1,
      url: 'https://github.com/acme/app/pull/1',
      state: 'merged',
      merged_at: daysAgo(5),
      created_at: daysAgo(6),
      updated_at: daysAgo(5),
      last_synced_at: daysAgo(5),
    });
    run('k1', 'cc-key', {
      created_at: daysAgo(2),
      completed_at: daysAgo(1),
      updated_at: daysAgo(1),
    });
    run('m1', 'cc-mate', {}, { user_id: 'mate' });
    run('m2', 'cc-mate2', {}, { user_id: 'mate' });
    run('none', null);
    run('live', 'cc-max', { status: 'in_progress', completed_at: null, created_at: daysAgo(1) });
    // Foreign rows: a foreign task on the owner's credential, and a foreign task whose workspace
    // claims project p. Neither may count.
    run('f1', 'cc-max', { project_id: 'foreign' });
    run(
      'f2',
      'cc-out',
      { project_id: 'foreign', workspace_project_id: 'p' },
      { user_id: 'outsider' }
    );
    // A run of p whose workspace belongs to the foreign project: its account is not p's evidence.
    run('f3', 'cc-out', { workspace_project_id: 'foreign' }, { user_id: 'outsider' });

    const result = await projectAccounts(ctx(), { projectId: 'p', range: '7d', nowMs: NOW });
    const byKey = Object.fromEntries(result.accounts.map((a) => [a.key, a]));

    expect(byKey['cred:cc-max']).toMatchObject({
      name: 'Personal Max',
      owner: 'you',
      kind: 'subscription',
      runs: 3,
      merged: 1,
      spend: null,
    });
    expect(byKey['cred:cc-key']).toMatchObject({
      name: 'Work API key',
      kind: 'api_key',
      runs: 1,
      spend: { state: 'not_reported' },
    });
    // Two of the teammate's accounts form one row, with no name and no credential id.
    expect(byKey['teammate:claude-code:subscription']).toMatchObject({
      name: null,
      owner: 'teammate',
      runs: 2,
      credentials: 2,
    });
    expect(byKey.not_recorded).toMatchObject({ owner: 'not_recorded', runs: 2 });
    expect(result.totals).toEqual({ runs: 8, merged: 1 });
    // Same run population as Flow: its ended runs plus the running one.
    const flow = await projectFlow(ctx(), { projectId: 'p', range: '7d', nowMs: NOW });
    const { buckets, other } = flow.runs;
    const flowEnded =
      buckets.reduce((n, b) => n + b.merged + b.closed + b.failed, 0) +
      other.stopped +
      other.prOpen +
      other.noPullRequest;
    expect(flowEnded + 1).toBe(result.totals.runs);
    // Days line up with the buckets: the live run counts on the day it started.
    expect(result.bucket).toBe('day');
    expect(byKey['cred:cc-max']?.runsByBucket.reduce((a, b) => a + b, 0)).toBe(3);
    expect(byKey['cred:cc-max']?.runsByBucket.at(-2)).toBe(1);

    const body = JSON.stringify(result);
    for (const secret of [
      'Mate Secret Name',
      'Mate Second Name',
      'cc-mate',
      'Outsider Name',
      'cc-out',
      'ciphertext',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('shows a teammate their own account by name and the owner only as a teammate', async () => {
    run('a1', 'cc-max');
    run('m1', 'cc-mate', {}, { user_id: 'mate' });
    const result = await projectAccounts(ctx('mate'), { projectId: 'p', range: '7d', nowMs: NOW });
    const names = result.accounts.map((a) => [a.key, a.name, a.owner]);
    expect(names).toEqual(
      expect.arrayContaining([
        ['cred:cc-mate', 'Mate Secret Name', 'you'],
        ['teammate:claude-code:subscription', null, 'teammate'],
      ])
    );
    expect(JSON.stringify(result)).not.toContain('Personal Max');
  });

  it("keeps another member's credential name in the database (the SQL gate on its own)", async () => {
    run('a1', 'cc-max');
    run('m1', 'cc-mate', {}, { user_id: 'mate' });
    const statement = accountRunsStatement(flowWindow('p', '7d', NOW), 'owner');
    const rows = sqlite.prepare(statement.sql).all(...statement.binds) as Array<
      Record<string, unknown>
    >;
    const byRef = Object.fromEntries(rows.map((row) => [row.ref, row]));
    // Owner control: the viewer's own name is read.
    expect(byRef[ref('cc-max')]).toMatchObject({ own_name: 'Personal Max', cred_own: 1 });
    expect(byRef[ref('cc-mate')]).toMatchObject({
      own_name: null,
      cred_own: 0,
      kind: 'oauth-token',
    });
    expect(JSON.stringify(rows)).not.toContain('ciphertext');
  });

  it('merges overlapping limit waits and rejected windows into episodes per account', async () => {
    // Runs that ended after their waits (or are still going), as production orders them.
    run('w1', 'cc-max', { completed_at: iso(HOUR), updated_at: iso(HOUR) });
    run('w2', 'cc-max', { completed_at: iso(HOUR), updated_at: iso(HOUR) });
    run('w3', 'cc-max', { status: 'in_progress', completed_at: null, created_at: iso(HOUR) });
    run('b1', 'cc-key', { status: 'cancelled', completed_at: iso(DAY), updated_at: iso(DAY) });
    run('long', LONG_ID, { completed_at: iso(HOUR), updated_at: iso(HOUR) });
    run('fw', 'cc-max', { project_id: 'foreign' });
    // Two runs paused by one 5-hour window two minutes apart, and the window row itself: one stall.
    await wait('w1', ref('cc-max'), 3 * HOUR, { resetsInMs: 40 * MIN, phase: 'released' });
    await wait('w2', ref('cc-max'), 3 * HOUR - 2 * MIN, {
      resetsInMs: 38 * MIN,
      phase: 'released',
    });
    await rejectedWindow(ref('cc-max'), 'claude.five_hour', 3 * HOUR - MIN, 39 * MIN);
    // A second, later stall on the same account, still waiting.
    await wait('w3', ref('cc-max'), 10 * MIN, { resetsInMs: 50 * MIN });
    // A blocked wait on the API key, and a stall on a long legacy reference (digest key).
    await wait('b1', ref('cc-key'), 2 * DAY, { phase: 'blocked' });
    await wait('long', ref(LONG_ID), 1 * DAY, { resetsInMs: 20 * MIN, phase: 'released' });
    // Foreign project: its wait and its window must not count.
    await wait('fw', ref('cc-max'), 1 * HOUR, { resetsInMs: 20 * MIN });
    await rejectedWindow(ref('cc-max'), 'claude.seven_day', 30 * MIN, 5 * HOUR, {
      project_id: 'foreign',
    });

    const result = await projectAccounts(ctx(), { projectId: 'p', range: '7d', nowMs: NOW });
    const max = result.accounts.find((a) => a.key === 'cred:cc-max');
    // SAM resumes a run 10 s after the reported reset (PROVIDER_LIMIT_POLICY.resetGraceMs).
    const GRACE = 10_000;
    expect(max?.stalls).toEqual({
      episodes: 2,
      totalMs: 40 * MIN + GRACE + 10 * MIN,
      ongoing: true,
    });
    const episodes = result.stallEpisodes.items.filter((e) => e.accountKey === 'cred:cc-max');
    expect(episodes).toEqual([
      expect.objectContaining({ runs: 1, outcome: 'ongoing', durationMs: 10 * MIN, window: null }),
      expect.objectContaining({
        runs: 2,
        outcome: 'resumed',
        durationMs: 40 * MIN + GRACE,
        window: '5h',
      }),
    ]);
    const key = result.accounts.find((a) => a.key === 'cred:cc-key');
    // Blocked two days ago, until the run was cancelled a day later.
    expect(key?.stalls).toEqual({ episodes: 1, totalMs: DAY, ongoing: false });
    expect(result.stallEpisodes.items.find((e) => e.accountKey === 'cred:cc-key')).toMatchObject({
      outcome: 'blocked',
    });
    // The digest-keyed wait reaches its account through the shared key function.
    const legacy = result.accounts.find((a) => a.key === `cred:${LONG_ID}`);
    expect(legacy).toMatchObject({
      name: 'Legacy Max',
      stalls: { episodes: 1, totalMs: 20 * MIN + GRACE },
    });
    expect(result.stallEpisodes).toMatchObject({ total: 4, truncated: false });
    expect(result.stallEpisodes.items.some((e) => e.window?.includes('Week'))).toBe(false);
  });

  it('skips a malformed wait or window row without failing the page', async () => {
    run('good', 'cc-max', { completed_at: iso(HOUR) });
    run('bad', 'cc-max', { completed_at: iso(HOUR) });
    run('good2', 'cc-max', { completed_at: iso(HOUR) });
    await wait('good', ref('cc-max'), 2 * DAY, { phase: 'released' });
    await wait('good2', ref('cc-max'), 1 * DAY, { phase: 'released' });
    sqlite
      .prepare('UPDATE tasks SET provider_limit_wait_json = ? WHERE id = ?')
      .run(JSON.stringify({ version: 1, phase: 'released', observedAt: NOW - 3 * DAY }), 'bad');
    // A window type that is not text (a blob) costs only this row.
    sqlite
      .prepare(
        `INSERT INTO credential_limit_windows (project_id, credential_reference, window_type, credential_source,
           provider, provider_mode, user_id, source, status, observed_at, created_at, updated_at)
         VALUES ('p', ?, ?, 'user', 'anthropic', 'direct', 'owner', 's', 'rejected', ?, 0, 0)`
      )
      .run(ref('cc-max'), Buffer.from('x'), NOW - 5 * HOUR);

    const result = await projectAccounts(ctx(), { projectId: 'p', range: '7d', nowMs: NOW });
    expect(result.unavailable).toEqual([]);
    expect(result.accounts.find((a) => a.key === 'cred:cc-max')?.stalls.episodes).toBe(2);
  });

  it('discloses when the stall scan cap cut older waits off', async () => {
    for (let i = 0; i < 52; i += 1) {
      run(`t${i}`, 'cc-max');
      await wait(`t${i}`, ref('cc-max'), (i + 1) * HOUR, {
        resetsInMs: 10 * MIN,
        phase: 'released',
      });
    }
    // The admin setting, through the settings port the operation reads.
    const base = ctx();
    const capped: OperationContext = {
      ...base,
      ports: {
        ...base.ports,
        settings: {
          ...base.ports.settings,
          resolveDetailsMany: async (names: readonly string[]) =>
            names.map((name) => ({ value: name === 'insights.accountsStallScanCap' ? 50 : null })),
        },
      } as OperationContext['ports'],
    };
    const result = await projectAccounts(capped, { projectId: 'p', range: '7d', nowMs: NOW });
    expect(result.stallEpisodes.truncated).toBe(true);
    expect(result.stallEpisodes.total).toBe(50);
    expect(result.stallEpisodes.items).toHaveLength(10);
  });

  it('attaches the last-reported limit windows to your own accounts only', async () => {
    run('a1', 'cc-max');
    run('m1', 'cc-mate', {}, { user_id: 'mate' });
    insert('credential_limit_windows', {
      project_id: 'p',
      credential_reference: ref('cc-max'),
      window_type: 'claude.seven_day',
      credential_source: 'user',
      provider: 'anthropic',
      provider_mode: 'direct',
      agent_type: 'claude-code',
      user_id: 'owner',
      source: 'claude-acp.rate_limit',
      status: 'allowed',
      utilization_percent: 71,
      window_minutes: 10080,
      resets_at: NOW + DAY,
      observed_at: NOW - HOUR,
      created_at: NOW - HOUR,
      updated_at: NOW - HOUR,
    });
    const result = await projectAccounts(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });
    const own = result.accounts.find((a) => a.key === 'cred:cc-max');
    expect(own?.usage?.windows.map((w) => [w.windowType, w.utilizationPercent])).toEqual([
      ['claude.seven_day', 71],
    ]);
    expect(result.accounts.find((a) => a.owner === 'teammate')?.usage).toBeNull();
    expect(result.bucket).toBe('week');
  });

  it('refuses a non-member, a foreign project and an unknown range', async () => {
    run('a1', 'cc-max');
    await expect(
      projectAccounts(ctx('outsider'), { projectId: 'p', nowMs: NOW })
    ).rejects.toThrow();
    await expect(projectAccounts(ctx(), { projectId: 'foreign', nowMs: NOW })).rejects.toThrow();
    await expect(
      projectAccounts(ctx(), { projectId: 'p', range: '365d', nowMs: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // Owner control: the default range works for a member.
    const result = await projectAccounts(ctx(), { projectId: 'p', nowMs: NOW });
    expect(result.range).toBe('30d');
    expect(result.totals.runs).toBe(1);
  });

  it('stays within its round-trip budget', async () => {
    const real = env.DATABASE;
    let trips = 0;
    const wrap = <T extends Record<string, unknown>>(statement: T): T => ({
      ...statement,
      all: async (...a: unknown[]) => {
        trips += 1;
        return (statement.all as (...x: unknown[]) => unknown)(...a);
      },
      first: async (...a: unknown[]) => {
        trips += 1;
        return (statement.first as (...x: unknown[]) => unknown)(...a);
      },
      run: async (...a: unknown[]) => {
        trips += 1;
        return (statement.run as (...x: unknown[]) => unknown)(...a);
      },
      raw: async (...a: unknown[]) => {
        trips += 1;
        return (statement.raw as (...x: unknown[]) => unknown)(...a);
      },
    });
    env = {
      ...env,
      DATABASE: {
        ...real,
        prepare: (sql: string) => {
          const statement = real.prepare(sql) as unknown as Record<string, unknown>;
          return {
            ...wrap(statement),
            bind: (...params: unknown[]) =>
              wrap((statement.bind as (...p: unknown[]) => Record<string, unknown>)(...params)),
          };
        },
        batch: async (statements: unknown[]) => {
          trips += 1;
          return (real.batch as (s: unknown[]) => unknown)(statements);
        },
      },
    } as unknown as Env;
    // Busy project: 120 runs over every account, own accounts with stalls, so every read fires.
    for (let i = 0; i < 120; i += 1) {
      const id = ['cc-max', 'cc-key', 'cc-mate', LONG_ID][i % 4] as string;
      run(`t${i}`, id, {}, id === 'cc-mate' ? { user_id: 'mate' } : {});
      if (i % 10 === 0) await wait(`t${i}`, ref(id), (i + 1) * HOUR, { phase: 'released' });
    }
    await projectAccounts(ctx(), { projectId: 'p', range: '30d', nowMs: NOW }); // warm settings
    trips = 0;
    const result = await projectAccounts(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });
    expect(result.totals.runs).toBe(120);
    expect(result.accounts.find((a) => a.key === 'cred:cc-max')?.stalls.episodes).toBeGreaterThan(
      0
    );
    // Rule 60 budget for this read is 6 (Insights spec).
    expect(trips).toBeLessThanOrEqual(6);
  });
});
