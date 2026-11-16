/**
 * installationHealth (Admin Health & cost, Insights slice H) against a real SQL engine. Spend,
 * reuse and density are SQL predicates plus arithmetic over real rows, so each case seeds the
 * rows production holds and asserts on what the operation computes from them.
 *
 * NOW is Monday 2026-11-16 12:00 UTC, so the current chart week started 12 hours ago.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { installationHealth, OperationError } from '@simple-agent-manager/operations';
import type { InstallationLifecycleLatency } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const iso = (value: string) => new Date(value).toISOString();
const ms = (value: string) => Date.parse(value);

describe('installationHealth', () => {
  let sqlite: Database.Database;
  let env: Env;
  let latency: ReturnType<typeof vi.fn>;

  /** `limits` overrides individual admin settings; the rest resolve through the real port. */
  function ctx(userId = 'admin', limits: Record<string, number> = {}): OperationContext {
    const ports = createOperationPorts(env);
    const settings = {
      ...ports.settings,
      resolveDetailsMany: async (
        names: Parameters<typeof ports.settings.resolveDetailsMany>[0]
      ) => {
        const resolved = await ports.settings.resolveDetailsMany(names);
        return resolved.map((row, index) => {
          const override = limits[names[index] as string];
          return override === undefined ? row : { ...row, value: override };
        });
      },
    };
    return {
      env,
      ports: { ...ports, settings, lifecycleLatency: { rangeReport: latency } },
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
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

  function node(id: string, fields: Record<string, string | number | null> = {}): void {
    insert('nodes', {
      id,
      user_id: 'admin',
      name: id,
      status: 'running',
      runtime: 'vm',
      node_class: 'managed',
      node_role: 'workspace',
      credential_source: 'user',
      cloud_provider: 'hetzner',
      provider_instance_price_hourly_micros: 10_000, // $0.01 an hour
      provider_instance_price_currency: 'USD',
      created_at: iso('2026-11-01T00:00:00Z'),
      updated_at: iso('2026-11-16T11:59:00Z'),
      ...fields,
    });
  }

  function workspace(
    id: string,
    nodeId: string,
    createdAt: string,
    fields: Record<string, string | number | null> = {}
  ): void {
    insert('workspaces', {
      id,
      node_id: nodeId,
      project_id: 'p',
      user_id: 'admin',
      name: id,
      status: 'running',
      created_at: iso(createdAt),
      updated_at: iso(createdAt),
      ...fields,
    });
  }

  function run(workspaceId: string, nodeId: string | null, start: string, end: string): void {
    insert('workspace_resource_summaries', {
      id: `run-${workspaceId}`,
      project_id: 'p',
      workspace_id: workspaceId,
      node_id: nodeId,
      runtime: 'vm',
      source_version: 1,
      started_at: ms(start),
      ended_at: ms(end),
      sample_count: 10,
      completeness_json: '{}',
      summary_json: '{}',
      created_at: ms(start),
      updated_at: ms(end),
    });
  }

  const placement = (hosts: unknown) => JSON.stringify({ diagnostics: { hosts } });

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app');
      INSERT INTO users (id, name, email, role, status) VALUES
        ('admin', 'Admin', 'a@example.com', 'superadmin', 'active'),
        ('member', 'Member', 'm@example.com', 'user', 'active'),
        ('suspended-admin', 'Gone', 'g@example.com', 'superadmin', 'suspended');
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
    latency = vi.fn(async (): Promise<InstallationLifecycleLatency> => ({
      minSamples: 5,
      states: [],
    }));
  });
  afterEach(() => sqlite.close());

  describe('compute spend', () => {
    it('prices each machine once at its own hourly price, however many workspaces share it', async () => {
      node('shared'); // ran the whole 7 days: 168 h × $0.01
      workspace('w1', 'shared', '2026-11-10T00:00:00Z');
      workspace('w2', 'shared', '2026-11-10T01:00:00Z');
      workspace('w3', 'shared', '2026-11-11T00:00:00Z');
      node('gcp-short', {
        cloud_provider: 'gcp',
        provider_instance_price_hourly_micros: 100_000, // $0.10 an hour
        status: 'deleted',
        created_at: iso('2026-11-15T12:00:00Z'),
        updated_at: iso('2026-11-15T22:00:00Z'), // ended after 10 h
      });

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.compute).toMatchObject({
        currency: 'USD',
        totalUsd: 2.68,
        nodes: 2,
        unpricedNodes: 0,
        truncated: false,
      });
      expect(result.compute?.byProvider).toEqual([
        { provider: 'hetzner', usd: 1.68, nodeHours: 168, nodes: 1 },
        { provider: 'gcp', usd: 1, nodeHours: 10, nodes: 1 },
      ]);
      // compute_usage would have counted the shared machine three times; it is not read.
      expect(result.compute?.totalUsd).not.toBeCloseTo(1.68 * 3 + 1);
    });

    it('leaves out machines SAM did not pay a provider for, and counts unpriced ones separately', async () => {
      node('paid');
      node('byo', { node_class: 'user-owned' });
      node('self-hosted', { credential_source: 'self-hosted' });
      node('instant', { runtime: 'cf-container' });
      node('no-price', { provider_instance_price_hourly_micros: null });
      node('euro', { provider_instance_price_currency: 'EUR' });
      node('gone-before', {
        status: 'destroyed',
        created_at: iso('2026-10-01T00:00:00Z'),
        updated_at: iso('2026-10-02T00:00:00Z'),
      });

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.compute).toMatchObject({ totalUsd: 1.68, nodes: 3, unpricedNodes: 2 });
      expect(result.compute?.byProvider).toHaveLength(1);
    });

    it('splits spend into Monday-start UTC weeks, oldest first', async () => {
      node('shared');
      node('gcp-short', {
        cloud_provider: 'gcp',
        provider_instance_price_hourly_micros: 100_000,
        status: 'deleted',
        created_at: iso('2026-11-15T12:00:00Z'),
        updated_at: iso('2026-11-15T22:00:00Z'),
      });

      const result = await installationHealth(ctx(), { range: 'month' }, NOW);
      const weeks = result.compute?.weeks ?? [];

      expect(weeks).toHaveLength(6);
      expect(weeks.at(-1)).toEqual({
        weekStart: '2026-11-16T00:00:00.000Z',
        totalUsd: 0.12, // 12 h of the shared machine
        byProvider: [{ provider: 'hetzner', usd: 0.12 }],
      });
      expect(weeks.at(-2)).toEqual({
        weekStart: '2026-11-09T00:00:00.000Z',
        totalUsd: 2.68,
        byProvider: [
          { provider: 'hetzner', usd: 1.68 },
          { provider: 'gcp', usd: 1 },
        ],
      });
      // The month started 2026-11-01: 15.5 days of the shared machine plus the gcp machine.
      expect(result.window.start).toBe('2026-11-01T00:00:00.000Z');
      expect(result.compute?.totalUsd).toBe(4.72);
    });

    it('keeps the still-running machine under the cap and says the total is a lower bound', async () => {
      node('ended-recently', {
        status: 'deleted',
        created_at: iso('2026-11-15T00:00:00Z'),
        updated_at: iso('2026-11-15T12:00:00Z'),
      });
      node('running-long'); // created 2026-11-01, still running: costs the most
      const result = await installationHealth(
        ctx('admin', { 'insights.healthMaxNodes': 1 }),
        { range: '7d' },
        NOW
      );

      expect(result.compute).toMatchObject({ totalUsd: 1.68, nodes: 1, truncated: true });
    });

    it('skips a machine with an unreadable timestamp and still prices the rest', async () => {
      node('good');
      node('bad', { status: 'deleted', updated_at: 'not-a-date' });

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.compute?.totalUsd).toBe(1.68);
      expect(result.unavailable).toEqual([]);
    });
  });

  describe('machine reuse and new-machine reasons', () => {
    beforeEach(() => {
      node('a');
      workspace('a-first', 'a', '2026-11-01T00:00:00Z'); // before the range: still counts as earlier
      workspace('a-2', 'a', '2026-11-10T00:00:00Z');
      workspace('a-3', 'a', '2026-11-11T00:00:00Z');
      node('b', { created_at: iso('2026-11-12T00:00:00Z') });
      workspace('b-first', 'b', '2026-11-12T00:01:00Z', {
        placement_explanation_json: placement([
          {
            nodeId: 'a',
            outcome: 'rejected',
            reasons: [
              'disk reservation budget would be exceeded',
              'Host agent version is incompatible',
            ],
          },
          {
            nodeId: 'other',
            outcome: 'rejected',
            reasons: ['disk reservation budget would be exceeded'],
          },
          { nodeId: 'b', outcome: 'selected', reasons: [] },
        ]),
      });
      node('c', { created_at: iso('2026-11-13T00:00:00Z') });
      workspace('c-first', 'c', '2026-11-13T00:01:00Z', {
        placement_explanation_json: '{bad json',
      });
      node('d', { created_at: iso('2026-11-14T00:00:00Z') });
      workspace('d-first', 'd', '2026-11-14T00:01:00Z', {
        placement_explanation_json: placement([{ nodeId: 'd', outcome: 'selected', reasons: [] }]),
      });
      node('e', { created_at: iso('2026-11-15T00:00:00Z') });
      workspace('e-first', 'e', '2026-11-15T00:01:00Z', {
        placement_explanation_json: placement([
          { nodeId: 'a', outcome: 'rejected', reasons: ['CPU saturation ceiling reached'] },
        ]),
      });
      insert('node_lifecycle_decisions', {
        id: 'claim-in-range',
        node_id: 'a',
        source: 'node_lifecycle',
        decision: 'claimed',
        reason: 'warm_node_reused',
        created_at: iso('2026-11-10T00:00:00Z'),
      });
      insert('node_lifecycle_decisions', {
        id: 'claim-before-range',
        node_id: 'a',
        source: 'node_lifecycle',
        decision: 'claimed',
        reason: 'warm_node_reused',
        created_at: iso('2026-11-01T00:00:00Z'),
      });
    });

    it('counts a placement as new only when it is the first workspace on its machine', async () => {
      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.reuse).toMatchObject({
        placements: 6,
        onExistingMachine: 2,
        onNewMachine: 4,
        fromWarmPool: 1,
        reuseRate: 2 / 6,
        truncated: false,
      });
      const lastWeek = result.reuse?.weeks.find(
        (week) => week.weekStart === '2026-11-09T00:00:00.000Z'
      );
      expect(lastWeek).toEqual({
        weekStart: '2026-11-09T00:00:00.000Z',
        placements: 6,
        reuseRate: 2 / 6,
      });
    });

    it('names each condition that sent a placement to a new machine, once per machine', async () => {
      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.newMachines).toEqual({
        newMachines: 4,
        reasons: [
          { reason: 'CPU saturation ceiling reached', kind: 'refused', machines: 1 },
          { reason: 'disk reservation budget would be exceeded', kind: 'refused', machines: 1 },
          { reason: 'Host agent version is incompatible', kind: 'refused', machines: 1 },
          { reason: 'No other machine in the pool to try', kind: 'no_candidate', machines: 1 },
          { reason: 'Placement explanation not recorded', kind: 'not_recorded', machines: 1 },
        ],
        otherReasons: 0,
      });
      expect(result.unavailable).toEqual([]);
    });

    it('lists the most common reasons up to the cap and counts the rest', async () => {
      const result = await installationHealth(
        ctx('admin', { 'insights.healthMaxReasons': 2 }),
        { range: '7d' },
        NOW
      );

      expect(result.newMachines?.reasons.map((r) => r.reason)).toEqual([
        'CPU saturation ceiling reached',
        'disk reservation budget would be exceeded',
      ]);
      expect(result.newMachines?.otherReasons).toBe(3);
    });

    it('does not count a warm claim whose workspace row was later deleted', async () => {
      // The decision log outlives workspace rows (cleanup and node delete remove them); a claim
      // with no placement after it must not inflate the warm-pool part past the placements.
      insert('node_lifecycle_decisions', {
        id: 'claim-orphaned',
        node_id: 'a',
        source: 'node_lifecycle',
        decision: 'claimed',
        reason: 'warm_node_reused',
        created_at: iso('2026-11-11T06:00:00Z'),
      });

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.reuse).toMatchObject({
        placements: 6,
        onExistingMachine: 2,
        fromWarmPool: 1,
      });
    });

    it('counts a warm-claimed placement as reuse even when the earlier workspace row is gone', async () => {
      node('f', { created_at: iso('2026-11-13T12:00:00Z') });
      insert('node_lifecycle_decisions', {
        id: 'claim-f',
        node_id: 'f',
        source: 'node_lifecycle',
        decision: 'claimed',
        reason: 'warm_node_reused',
        created_at: iso('2026-11-14T00:00:00Z'),
      });
      // Stored in SQLite's CURRENT_TIMESTAMP text form: compared to the ISO claim as times, not text.
      workspace('f-2', 'f', '2026-11-14T00:01:00Z', { created_at: '2026-11-14 00:01:00' });

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.reuse).toMatchObject({
        placements: 7,
        onExistingMachine: 3,
        onNewMachine: 4,
        fromWarmPool: 2,
      });
      expect(result.newMachines?.newMachines).toBe(4);
    });

    it('does not credit the warm pool for a placement packed after the claimed one', async () => {
      // a-3 follows a-2 on the same machine; the claim before a-2 belongs to a-2 alone.
      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.reuse?.onExistingMachine).toBe(2);
      expect(result.reuse?.fromWarmPool).toBe(1);
    });

    it('credits only an unreleased warm claim, once, ignoring other decisions', async () => {
      node('g', { created_at: iso('2026-11-13T00:00:00Z') });
      const decision = (id: string, at: string, fields: Record<string, string>) =>
        insert('node_lifecycle_decisions', {
          id,
          node_id: 'g',
          source: 'node_lifecycle',
          decision: 'claimed',
          reason: 'warm_node_reused',
          created_at: iso(at),
          ...fields,
        });
      workspace('g-1', 'g', '2026-11-13T00:01:00Z');
      // Before g-2: two claims for one placement, credited once.
      decision('g-claim-1', '2026-11-13T01:00:00Z', {});
      decision('g-claim-2', '2026-11-13T01:30:00Z', {});
      workspace('g-2', 'g', '2026-11-13T02:00:00Z');
      // Before g-3: only decoys, and a claim given back unused.
      decision('g-decoy-kind', '2026-11-13T03:00:00Z', { decision: 'marked_warm', reason: '' });
      decision('g-claim-3', '2026-11-13T03:10:00Z', {});
      decision('g-released', '2026-11-13T03:20:00Z', {
        decision: 'claim_released',
        reason: 'claim_unused',
      });
      // Claim-shaped rows from another source or for another reason are not warm-pool claims.
      decision('g-decoy-source', '2026-11-13T03:40:00Z', { source: 'cleanup_sweep' });
      decision('g-decoy-reason', '2026-11-13T03:45:00Z', { reason: 'something_else' });
      workspace('g-3', 'g', '2026-11-13T04:00:00Z');

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      // Fixture: 6 placements, 2 on existing machines, 1 warm (a-2). g adds 3 placements, 2 reuse.
      expect(result.reuse).toMatchObject({
        placements: 9,
        onExistingMachine: 4,
        fromWarmPool: 2,
      });
    });

    it('says the reuse rate but not the warm-pool part when the decision log cannot be read', async () => {
      sqlite.exec('DROP TABLE node_lifecycle_decisions');

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.reuse).toMatchObject({
        placements: 6,
        onExistingMachine: 2,
        fromWarmPool: null,
      });
      expect(result.unavailable).toEqual([]);
    });

    it('does not credit a claim an unread placement may have served when the cap is reached', async () => {
      // Cap 3 keeps c-first, d-first and e-first. e-early (unread) sits between this claim and
      // e-first, so the claim is e-early's, not e-first's.
      workspace('e-early', 'e', '2026-11-12T12:00:00Z');
      insert('node_lifecycle_decisions', {
        id: 'claim-e',
        node_id: 'e',
        source: 'node_lifecycle',
        decision: 'claimed',
        reason: 'warm_node_reused',
        created_at: iso('2026-11-12T06:00:00Z'),
      });

      const result = await installationHealth(
        ctx('admin', { 'insights.healthMaxPlacements': 3 }),
        { range: '7d' },
        NOW
      );

      expect(result.reuse).toMatchObject({ placements: 3, fromWarmPool: 0, truncated: true });
    });

    it('says the warm-pool part is a lower bound when the decision read reaches its cap', async () => {
      for (let i = 0; i < 8; i++) {
        insert('node_lifecycle_decisions', {
          id: `late-release-${i}`,
          node_id: 'other-node',
          source: 'node_lifecycle',
          decision: 'claim_released',
          reason: 'claim_unused',
          created_at: iso(`2026-11-16T0${i}:00:00Z`),
        });
      }

      const result = await installationHealth(
        ctx('admin', { 'insights.healthMaxPlacements': 7 }),
        { range: '7d' },
        NOW
      );

      // 7 placements fit; 9 decisions in the window (a claim and 8 releases) do not.
      expect(result.reuse).toMatchObject({ placements: 6, truncated: true });
    });

    it('marks placements truncated when the cap is reached', async () => {
      const result = await installationHealth(
        ctx('admin', { 'insights.healthMaxPlacements': 3 }),
        { range: '7d' },
        NOW
      );

      expect(result.reuse).toMatchObject({ placements: 3, truncated: true });
    });

    it('breaks a tie on creation time by id so exactly one workspace is first', async () => {
      node('tie', { created_at: iso('2026-11-15T10:00:00Z') });
      workspace('tie-x', 'tie', '2026-11-15T10:01:00Z');
      workspace('tie-y', 'tie', '2026-11-15T10:01:00Z');

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.reuse?.onNewMachine).toBe(5);
      expect(result.reuse?.onExistingMachine).toBe(3);
    });
  });

  describe('agents per busy machine', () => {
    it('averages agents over running time, not over the creation-to-deletion ledger', async () => {
      node('a');
      workspace('w1', 'a', '2026-11-10T00:00:00Z');
      workspace('w2', 'a', '2026-11-10T00:00:00Z');
      workspace('stopped', 'a', '2026-11-10T00:00:00Z', { status: 'stopped' });
      run('w1', 'a', '2026-11-10T00:00:00Z', '2026-11-10T04:00:00Z');
      run('w2', null, '2026-11-10T02:00:00Z', '2026-11-10T06:00:00Z'); // node_id lost: joined by workspace
      // The trap: a stopped-but-undeleted workspace keeps an open compute_usage interval for days.
      insert('compute_usage', {
        id: 'cu-stopped',
        user_id: 'admin',
        workspace_id: 'stopped',
        node_id: 'a',
        server_type: 'cx22',
        vcpu_count: 2,
        credential_source: 'user',
        started_at: iso('2026-11-10T00:00:00Z'),
        ended_at: null,
      });

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      // Busy 0-6h; two agents 2-4h: 8 agent-hours over 6 busy hours.
      expect(result.density).toEqual({
        agentsPerBusyMachine: 1.33,
        busyMachineHours: 6,
        agentHours: 8,
        peakAgentsOnOneMachine: 2,
        machines: 1,
        runs: 2,
        truncated: false,
      });
    });

    it('marks running intervals truncated when the cap is reached', async () => {
      node('a');
      workspace('w1', 'a', '2026-11-10T00:00:00Z');
      workspace('w2', 'a', '2026-11-10T00:00:00Z');
      run('w1', 'a', '2026-11-10T00:00:00Z', '2026-11-10T04:00:00Z');
      run('w2', 'a', '2026-11-10T02:00:00Z', '2026-11-10T06:00:00Z');

      const result = await installationHealth(
        ctx('admin', { 'insights.healthMaxRuns': 1 }),
        { range: '7d' },
        NOW
      );

      expect(result.density).toMatchObject({ runs: 1, truncated: true });
    });

    it('clips runs to the range and treats back-to-back runs as one agent', async () => {
      node('a');
      workspace('w1', 'a', '2026-11-01T00:00:00Z');
      workspace('w2', 'a', '2026-11-12T00:00:00Z');
      run('w1', 'a', '2026-11-08T12:00:00Z', '2026-11-12T12:00:00Z'); // 3 days inside the range
      run('w2', 'a', '2026-11-12T12:00:00Z', '2026-11-12T13:00:00Z');

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.density).toMatchObject({
        agentsPerBusyMachine: 1,
        busyMachineHours: 73,
        peakAgentsOnOneMachine: 1,
      });
    });
  });

  describe('access and isolation', () => {
    it('refuses anyone who is not an active superadmin, before reading anything else', async () => {
      for (const userId of ['member', 'suspended-admin', 'nobody']) {
        await expect(installationHealth(ctx(userId), { range: '7d' }, NOW)).rejects.toMatchObject({
          code: 'forbidden',
        });
      }
      expect(latency).not.toHaveBeenCalled();
      // Owner control: the superadmin is served.
      await expect(installationHealth(ctx('admin'), { range: '7d' }, NOW)).resolves.toMatchObject({
        window: { range: '7d' },
      });
    });

    it('rejects an unknown range and defaults to the month', async () => {
      await expect(installationHealth(ctx(), { range: '1y' }, NOW)).rejects.toBeInstanceOf(
        OperationError
      );
      const result = await installationHealth(ctx(), {}, NOW);
      expect(result.window.range).toBe('month');
    });

    it('keeps the other sections when one fails, and names the one that did', async () => {
      node('a');
      latency.mockRejectedValueOnce(new Error('settings store down'));

      const result = await installationHealth(ctx(), { range: '7d' }, NOW);

      expect(result.latency).toBeNull();
      expect(result.unavailable).toEqual(['latency']);
      expect(result.compute?.totalUsd).toBe(1.68); // liveness: the other sections still ran
      expect(latency).toHaveBeenCalledWith({ sinceMs: NOW - 7 * 86_400_000, untilMs: NOW });
    });
  });
});
