/**
 * readLifecycleLatencyRange against a real SQL engine: one windowed episode read for every
 * watched state, rows stuck past budget now, and open incidents found by the signature the
 * hourly triage gives the watchdog's own error message.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { LIFECYCLE_LATENCY_DEFAULTS } from '../../../src/services/lifecycle-latency';
import { readLifecycleLatencyRange } from '../../../src/services/lifecycle-latency/range-report';
import { slowStateMessage } from '../../../src/services/lifecycle-latency/watchdog';
import { platformErrorSignature } from '../../../src/services/platform-feedback-triage';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const MINUTE = 60_000;

describe('readLifecycleLatencyRange', () => {
  let sqlite: Database.Database;
  let env: Env;
  let nextId = 1;

  function episode(entityType: string, status: string, durationMs: number, endedAt: number): void {
    const start = endedAt - durationMs;
    sqlite
      .prepare(
        `INSERT INTO lifecycle_state_episodes (id, entity_type, entity_id, status, first_seen_at, last_seen_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nextId++,
        entityType,
        `e-${nextId}`,
        status,
        new Date(start).toISOString(),
        new Date(endedAt).toISOString(),
        new Date(endedAt).toISOString()
      );
  }

  function observation(entityType: string, status: string, firstSeenAt: number): void {
    sqlite
      .prepare(
        `INSERT INTO lifecycle_state_observations (entity_type, entity_id, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        entityType,
        `o-${nextId++}`,
        status,
        new Date(firstSeenAt).toISOString(),
        new Date(NOW).toISOString()
      );
  }

  async function triage(
    signature: string,
    queueState: string,
    ideaId: string | null
  ): Promise<void> {
    sqlite
      .prepare(
        `INSERT INTO platform_feedback_triages (signature, source, summary, first_seen_at, last_seen_at,
           occurrence_count, evidence_refs, queue_state, idea_id)
         VALUES (?, 'api', 'Recurring api platform error', ?, ?, 7, '[]', ?, ?)`
      )
      .run(signature, NOW - DAY, NOW - MINUTE, queueState, ideaId);
  }

  beforeEach(() => {
    nextId = 1;
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      `INSERT INTO tasks (id, project_id, title) VALUES ('idea-1', 'feedback-project', 'Slow stops')`
    );
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('reports p95 against the budget per state from one read, and flags a slow state', async () => {
    // workspace stopping: budget 10 min. Six episodes of 30 minutes: over budget.
    for (let i = 0; i < 6; i++)
      episode('workspace', 'stopping', 30 * MINUTE, NOW - (i + 1) * 3_600_000);
    // workspace creating: budget 15 min. Six quick episodes: within budget.
    for (let i = 0; i < 6; i++)
      episode('workspace', 'creating', (i + 1) * MINUTE, NOW - (i + 1) * 3_600_000);
    // Outside the range: must not count.
    episode('workspace', 'creating', 60 * MINUTE, NOW - 10 * DAY);

    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS }
    );

    expect(result.minSamples).toBe(5);
    expect(result.states).toHaveLength(11);
    const stopping = result.states.find(
      (s) => s.entityType === 'workspace' && s.status === 'stopping'
    );
    expect(stopping).toMatchObject({
      budgetMs: 10 * MINUTE,
      count: 6,
      p95Ms: 30 * MINUTE,
      overBudget: true,
      overBudgetNow: 0,
      truncated: false,
    });
    const creating = result.states.find(
      (s) => s.entityType === 'workspace' && s.status === 'creating'
    );
    expect(creating).toMatchObject({
      count: 6,
      p50Ms: 3 * MINUTE,
      p95Ms: 6 * MINUTE,
      maxMs: 6 * MINUTE,
      overBudget: false,
    });
  });

  it('skips an episode with an unreadable timestamp instead of counting it as 0 ms', async () => {
    for (let i = 0; i < 5; i++) episode('node', 'stopping', 30 * MINUTE, NOW - (i + 1) * 3_600_000);
    sqlite
      .prepare(
        `INSERT INTO lifecycle_state_episodes (id, entity_type, entity_id, status, first_seen_at, last_seen_at, ended_at)
         VALUES (999, 'node', 'bad', 'stopping', 'garbage', ?, ?)`
      )
      .run(new Date(NOW - 60_000).toISOString(), new Date(NOW - 60_000).toISOString());

    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS }
    );

    expect(
      result.states.find((s) => s.entityType === 'node' && s.status === 'stopping')
    ).toMatchObject({
      count: 5,
      p50Ms: 30 * MINUTE,
    });
  });

  it('does not judge a state with fewer than minSamples episodes', async () => {
    for (let i = 0; i < 4; i++) episode('node', 'creating', 60 * MINUTE, NOW - (i + 1) * 3_600_000);

    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS }
    );

    expect(
      result.states.find((s) => s.entityType === 'node' && s.status === 'creating')
    ).toMatchObject({
      count: 4,
      overBudget: false,
    });
  });

  it('caps episodes per state and says so', async () => {
    for (let i = 0; i < 5; i++) episode('workspace', 'pending', MINUTE, NOW - (i + 1) * MINUTE);
    for (let i = 0; i < 2; i++) episode('workspace', 'creating', MINUTE, NOW - (i + 1) * MINUTE);

    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS, evaluationSampleLimit: 3 }
    );

    expect(
      result.states.find((s) => s.status === 'pending' && s.entityType === 'workspace')
    ).toMatchObject({
      count: 3,
      truncated: true,
    });
    // The cap is per state: another state is not crowded out.
    expect(
      result.states.find((s) => s.status === 'creating' && s.entityType === 'workspace')
    ).toMatchObject({
      count: 2,
      truncated: false,
    });
  });

  it('counts rows stuck past their budget right now, and not rows still within it', async () => {
    observation('workspace', 'stopping', NOW - 31 * MINUTE);
    observation('workspace', 'stopping', NOW - 12 * MINUTE);
    observation('workspace', 'stopping', NOW - 5 * MINUTE); // within the 10 minute budget
    observation('node', 'creating', NOW - 5 * MINUTE);

    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS }
    );

    expect(
      result.states.find((s) => s.entityType === 'workspace' && s.status === 'stopping')
        ?.overBudgetNow
    ).toBe(2);
    expect(
      result.states.find((s) => s.entityType === 'node' && s.status === 'creating')?.overBudgetNow
    ).toBe(0);
  });

  it('links only open incidents raised for that state', async () => {
    const stoppingSignature = await platformErrorSignature(
      'api',
      slowStateMessage('workspace', 'stopping')
    );
    const creatingSignature = await platformErrorSignature(
      'api',
      slowStateMessage('node', 'creating')
    );
    const unrelated = await platformErrorSignature('api', 'Some other platform error');
    await triage(stoppingSignature, 'pending', 'idea-1');
    await triage(creatingSignature, 'resolved', null); // closed: not linked
    await triage(unrelated, 'pending', null);

    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS }
    );

    const stopping = result.states.find(
      (s) => s.entityType === 'workspace' && s.status === 'stopping'
    );
    expect(stopping?.incidents).toEqual([
      {
        signature: stoppingSignature,
        state: 'pending',
        firstSeenAt: new Date(NOW - DAY).toISOString(),
        lastSeenAt: new Date(NOW - MINUTE).toISOString(),
        occurrences: 7,
        ideaId: 'idea-1',
        ideaProjectId: 'feedback-project',
      },
    ]);
    expect(
      result.states.find((s) => s.entityType === 'node' && s.status === 'creating')?.incidents
    ).toEqual([]);
    expect(result.states.flatMap((s) => s.incidents).map((i) => i.signature)).not.toContain(
      unrelated
    );
  });

  it('leaves out states whose budget is 0 (watch turned off)', async () => {
    const result = await readLifecycleLatencyRange(
      env,
      { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      { ...LIFECYCLE_LATENCY_DEFAULTS, workspaceStoppingMinutes: 0 }
    );

    expect(result.states).toHaveLength(10);
    expect(result.states.some((s) => s.entityType === 'workspace' && s.status === 'stopping')).toBe(
      false
    );
  });
});
