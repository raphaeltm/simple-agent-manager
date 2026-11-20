/**
 * WATCHING disposition, driven through the real intake path: errors land in
 * `platform_errors`, the hourly runner groups them, and triage state changes go through the
 * real claim/watch/resolve writers. Real SQLite for every predicate (rule 28).
 */
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { runDebugDiagnosis } from '../../../src/services/debug-agent';
import {
  buildIncidentBacklogSummary,
  claimIncident,
  evaluateSpike,
  getIncidentConfig,
  hasDispatchablePendingIncidents,
  listDispatchableIncidentQueue,
  listIncidentQueue,
  parseHourlyCounts,
  resolveIncident,
  watchIncident,
} from '../../../src/services/platform-feedback-incidents';
import {
  reconcileIncidentIdeas,
  runPlatformFeedbackTriage,
} from '../../../src/services/platform-feedback-triage';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const noEngagement = async () => ({});
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-01T10:00:00Z');
const TRIAGE_TASK = 'triage-task-1';

function setup(extraEnv: Record<string, string> = {}) {
  const main = new Database(':memory:');
  main.exec(`
    CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
      is_idea INTEGER NOT NULL DEFAULT 0, triggered_by TEXT,
      task_mode TEXT NOT NULL, dispatch_depth INTEGER NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, output_pr_url TEXT);
    CREATE TABLE task_status_events (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, reason TEXT, created_at TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, agent_version TEXT, callback_generation TEXT);
    CREATE TABLE debug_diagnoses (id TEXT PRIMARY KEY, diagnosis TEXT NOT NULL, idea_id TEXT);
    CREATE TABLE platform_feedback_triages (
      signature TEXT PRIMARY KEY, canonical_signature TEXT, source TEXT NOT NULL, summary TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, occurrence_count INTEGER NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error', evidence_refs TEXT NOT NULL, diagnosis_id TEXT, idea_id TEXT, idea_owned_at TEXT, claim_token TEXT,
      claim_expires_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_reason TEXT, last_failed_at INTEGER, rejected_at INTEGER,
      budget_deferred_until INTEGER, budget_deferred_reason TEXT,
      budget_defer_count INTEGER NOT NULL DEFAULT 0, last_budget_deferred_at INTEGER,
      queue_state TEXT NOT NULL DEFAULT 'resolved', queued_at INTEGER,
      dispatch_lease_token TEXT, dispatch_lease_expires_at INTEGER,
      dispatched_trigger_id TEXT, dispatched_execution_id TEXT, dispatched_task_id TEXT,
      dispatched_at INTEGER, dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      incident_claim_token TEXT, incident_claim_expires_at INTEGER,
      incident_claimed_by_task_id TEXT, incident_claimed_at INTEGER,
      resolved_at INTEGER, resolved_by_task_id TEXT, resolution_note TEXT,
      resolution_references TEXT, expired_at INTEGER,
      watching_since INTEGER, watch_reason TEXT, watch_hourly_counts TEXT,
      watch_escalated_at INTEGER, watch_escalation_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX idx_platform_feedback_triages_canonical_signature
      ON platform_feedback_triages(canonical_signature) WHERE canonical_signature IS NOT NULL;
    INSERT INTO projects VALUES ('feedback-project', 'owner-1');
  `);
  const observability = new Database(':memory:');
  observability.exec(`CREATE TABLE platform_errors (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
    timestamp INTEGER NOT NULL, task_id TEXT, node_id TEXT);`);
  const env = {
    DATABASE: createSqliteD1(main),
    OBSERVABILITY_DATABASE: createSqliteD1(observability),
    PLATFORM_FEEDBACK_PROJECT_ID: 'feedback-project',
    PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES: '60',
    ...extraEnv,
  } as Env;
  const diagnose = vi.fn(async () => ({
    id: `diagnosis-${randomUUID()}`,
    diagnosis: 'redacted',
  })) as unknown as typeof runDebugDiagnosis & ReturnType<typeof vi.fn>;
  const run = (now: number) =>
    runPlatformFeedbackTriage(env, 'cron', {
      now: () => now,
      diagnose,
      readEngagement: noEngagement,
    });
  const addErrors = (message: string, timestamps: number[]) => {
    const insert = observability.prepare(
      'INSERT INTO platform_errors (id, source, level, message, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
    for (const timestamp of timestamps)
      insert.run(randomUUID(), 'api', 'error', message, timestamp);
  };
  const row = (signature: string) =>
    main
      .prepare(
        `SELECT queue_state, occurrence_count, first_seen_at, last_seen_at, queued_at,
           dispatch_attempts, watching_since, watch_reason, watch_hourly_counts,
           watch_escalated_at, watch_escalation_reason, expired_at, idea_id
         FROM platform_feedback_triages WHERE signature = ?`
      )
      .get(signature) as Record<string, unknown>;
  const idea = (signature: string) =>
    main
      .prepare(
        `SELECT t.status, t.description FROM tasks t
         JOIN platform_feedback_triages p ON p.idea_id = t.id WHERE p.signature = ?`
      )
      .get(signature) as { status: string; description: string };
  const signatureFor = (message: string) =>
    (
      main
        .prepare('SELECT signature FROM platform_feedback_triages WHERE summary LIKE ?')
        .get(`%${message.slice(0, 20)}%`) as { signature: string }
    ).signature;
  return { main, env, diagnose, run, addErrors, row, idea, signatureFor };
}

type Harness = ReturnType<typeof setup>;

/** First occurrence through the runner (idea filed), then the real claim and watch writers. */
async function seedWatched(h: Harness, message: string, at = T0) {
  h.addErrors(message, [at]);
  await h.run(at + 60_000);
  const signature = h.signatureFor(message);
  const claim = await claimIncident(h.env, signature, TRIAGE_TASK, at + 120_000);
  expect(claim).not.toBeNull();
  const watched = await watchIncident(
    h.env,
    signature,
    claim!.claimToken,
    TRIAGE_TASK,
    'Benign retry noise; measure frequency before fixing',
    at + 130_000,
    2_000
  );
  expect(watched).toBe(true);
  return signature;
}

function spread(start: number, count: number, stepMs = 1_000): number[] {
  return Array.from({ length: count }, (_, index) => start + index * stepMs);
}

describe('incident WATCHING disposition', () => {
  it('a watched recurrence updates counts and its idea without reopening or dispatching', async () => {
    const h = setup();
    const message = 'provider list call failed with transient 503 from upstream';
    const signature = await seedWatched(h, message);
    const before = h.row(signature);
    expect(before).toMatchObject({ queue_state: 'watching', occurrence_count: 1 });
    expect(h.idea(signature).description).toContain('Occurrences: 1');

    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, [t1 + 60_000, t1 + 120_000, t1 + 180_000]);
    const result = await h.run(t1 + 10 * 60_000);

    expect(result).toMatchObject({ watchedRecurrences: 1, watchedEscalated: 0, ideasCreated: 0 });
    expect(h.diagnose).toHaveBeenCalledTimes(1); // the original intake only
    const after = h.row(signature);
    expect(after).toMatchObject({
      queue_state: 'watching',
      occurrence_count: 4,
      first_seen_at: T0,
      last_seen_at: t1 + 180_000,
      queued_at: before.queued_at,
      dispatch_attempts: 0,
    });
    const description = h.idea(signature).description;
    expect(description).toContain('Occurrences: 4');
    expect(description).toContain('while watching: 3');
    expect(description).toContain('Disposition: watching since');
    expect(h.main.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });

    // Not dispatchable, and not counted twice when the next hourly window overlaps.
    expect(await listDispatchableIncidentQueue(h.env, 10, t1 + 10 * 60_000)).toEqual([]);
    expect(await hasDispatchablePendingIncidents(h.env, getIncidentConfig(h.env), t1)).toBe(false);
    await h.run(t1 + 20 * 60_000);
    expect(h.row(signature).occurrence_count).toBe(4);
  });

  it('records watched recurrences outside the group limit', async () => {
    const h = setup({ PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT: '1' });
    const watchedMessage = 'workspace heartbeat arrived after node retirement';
    const signature = await seedWatched(h, watchedMessage);
    const t1 = T0 + 2 * HOUR;
    h.addErrors(watchedMessage, [t1 + 1_000]);
    h.addErrors('a brand new failure shape nobody has seen', [t1 + 2_000]);

    const result = await h.run(t1 + 5 * 60_000);

    expect(result).toMatchObject({ ideasCreated: 1, watchedRecurrences: 1, groupsFound: 2 });
    expect(h.row(signature).occurrence_count).toBe(2);
  });

  it('returns a spiking watched signature to the queue with a reason; a smaller burst stays watched', async () => {
    const h = setup();
    const message = 'durable object storage write rejected under load';
    const signature = await seedWatched(h, message);

    // Below the default threshold (50 in 24h): still watching.
    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, spread(t1, 10));
    await h.run(t1 + 5 * 60_000);
    expect(h.row(signature)).toMatchObject({ queue_state: 'watching', occurrence_count: 11 });

    // 60 more inside the spike window: 70 since the watch decision.
    const t2 = T0 + 4 * HOUR;
    h.addErrors(message, spread(t2, 60));
    const now = t2 + 5 * 60_000;
    const result = await h.run(now);

    expect(result.watchedEscalated).toBe(1);
    const after = h.row(signature);
    expect(after).toMatchObject({
      queue_state: 'pending',
      queued_at: now,
      watch_escalated_at: now,
      occurrence_count: 71,
    });
    expect(after.watch_escalation_reason).toContain('spike: 70 occurrences in the last 24h');
    expect(h.diagnose).toHaveBeenCalledTimes(1);

    const queue = await listDispatchableIncidentQueue(h.env, 10, now);
    expect(queue.map((item) => item.id)).toEqual([signature]);
    const summary = await buildIncidentBacklogSummary(h.env, 10, now, getIncidentConfig(h.env), {
      expireStale: false,
      reclaimClaims: false,
    });
    expect(summary.rendered).toContain('returned from watching (spike: 70 occurrences');
  });

  it('does not count a burst triage already saw once it is watched again', async () => {
    const h = setup();
    const message = 'git push rejected by remote pre-receive hook';
    const signature = await seedWatched(h, message);
    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, spread(t1, 60));
    await h.run(t1 + 5 * 60_000);
    expect(h.row(signature).queue_state).toBe('pending');

    // Triage looks again and keeps watching it.
    const rewatchAt = t1 + 30 * 60_000;
    const claim = await claimIncident(h.env, signature, TRIAGE_TASK, rewatchAt);
    expect(
      await watchIncident(
        h.env,
        signature,
        claim!.claimToken,
        TRIAGE_TASK,
        'still benign',
        rewatchAt,
        2_000
      )
    ).toBe(true);

    const t2 = t1 + 2 * HOUR;
    h.addErrors(message, spread(t2, 5));
    await h.run(t2 + 5 * 60_000);
    expect(h.row(signature)).toMatchObject({ queue_state: 'watching', occurrence_count: 66 });
    // History survives the re-watch for the weekly ranking.
    const listed = await listIncidentQueue(h.env, ['watching'], 10, {
      context: { now: t2 + 5 * 60_000, recentWindowMs: 7 * DAY },
    });
    expect(listed[0]?.recentOccurrenceCount).toBe(65);
  });

  it('a steadily noisy watched signature is not re-queued for its usual rate', async () => {
    const h = setup();
    const message = 'client reported websocket reconnect storm';
    const signature = await seedWatched(h, message);
    // 40 a day for six days: each day alone is under the threshold.
    for (let day = 1; day <= 6; day += 1) {
      const at = T0 + day * DAY;
      h.addErrors(message, spread(at, 40));
      await h.run(at + 5 * 60_000);
    }
    expect(h.row(signature).queue_state).toBe('watching');
    // 60 on day seven crosses the absolute threshold but not 3x the earlier ~40/day.
    const day7 = T0 + 7 * DAY;
    h.addErrors(message, spread(day7, 60));
    await h.run(day7 + 5 * 60_000);
    expect(h.row(signature).queue_state).toBe('watching');
  });

  it('expires a quiet watched signature and closes its idea; a recurring one stays watched', async () => {
    const h = setup();
    const quiet = 'stale deploy artifact cleanup skipped a missing object';
    const recurring = 'session snapshot upload retried after a timeout';
    const quietSignature = await seedWatched(h, quiet);
    const recurringSignature = await seedWatched(h, recurring, T0 + 1_000);

    // Fifteen days later (quiet period 14 days): the recurring one occurs in this window.
    const now = T0 + 15 * DAY;
    h.addErrors(recurring, [now - 10 * 60_000]);
    const result = await h.run(now);

    expect(result.watchedExpired).toBe(1);
    expect(h.row(quietSignature)).toMatchObject({ queue_state: 'expired', expired_at: now });
    expect(h.row(recurringSignature)).toMatchObject({
      queue_state: 'watching',
      occurrence_count: 2,
    });

    const reconciled = await reconcileIncidentIdeas(h.env, {
      now: () => now,
      readEngagement: noEngagement,
      batchSize: 10,
      deadlineMs: 10_000,
    });
    expect(reconciled.cancelled).toBe(1);
    expect(h.idea(quietSignature).status).toBe('cancelled');
    expect(h.idea(recurringSignature).status).toBe('draft');
  });

  it('a resolved (not watched) signature still reopens for triage on recurrence', async () => {
    const h = setup();
    const message = 'callback token rejected for retired workspace';
    h.addErrors(message, [T0]);
    await h.run(T0 + 60_000);
    const signature = h.signatureFor(message);
    const claim = await claimIncident(h.env, signature, TRIAGE_TASK, T0 + 120_000);
    expect(
      await resolveIncident(
        h.env,
        signature,
        claim!.claimToken,
        'resolved',
        TRIAGE_TASK,
        'tracked',
        {
          now: T0 + 130_000,
          resolutionReferences: { linkedRecordId: '01M0YGSPRC0E17FPQMZYW012R8' },
        }
      )
    ).toBe(true);

    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, [t1]);
    const result = await h.run(t1 + 60_000);

    expect(result.watchedRecurrences).toBe(0);
    expect(h.row(signature)).toMatchObject({ queue_state: 'pending', queued_at: t1 + 60_000 });
  });
});

describe('watch spike arithmetic', () => {
  const config = {
    recentWindowMs: 7 * DAY,
    spikeWindowMs: DAY,
    spikeMinOccurrences: 50,
    spikeBaselineMultiplier: 3,
    quietExpiryMs: 14 * DAY,
  };
  const hour = (at: number) => Math.floor(at / HOUR);

  it('needs both the absolute threshold and the baseline multiple', () => {
    const now = T0 + 7 * DAY;
    const fresh = new Map([[hour(now - HOUR), 60]]);
    expect(evaluateSpike(fresh, now, T0, config).spike).toBe(true);
    expect(evaluateSpike(new Map([[hour(now - HOUR), 49]]), now, T0, config).spike).toBe(false);
    const noisy = new Map(fresh);
    // The baseline covers the hours since the earliest bucket: 100 over five days is 20 a day.
    noisy.set(hour(now - 6 * DAY), 100);
    expect(evaluateSpike(noisy, now, T0, config).spike).toBe(true); // 60 >= 3 * 20
    noisy.set(hour(now - 4 * DAY), 300);
    expect(evaluateSpike(noisy, now, T0, config).spike).toBe(false);
  });

  it('ignores occurrences from before the latest watch decision', () => {
    const now = T0 + DAY;
    const counts = new Map([[hour(now - 3 * HOUR), 60]]);
    expect(evaluateSpike(counts, now, now - 4 * HOUR, config).spike).toBe(true);
    expect(evaluateSpike(counts, now, now - HOUR, config).spike).toBe(false);
  });

  it('reads malformed stored buckets as empty', () => {
    expect(parseHourlyCounts('not json').size).toBe(0);
    expect(parseHourlyCounts('[1,2]').size).toBe(0);
    expect([...parseHourlyCounts('{"10":3,"x":4,"11":-1,"12":"5"}')]).toEqual([[10, 3]]);
  });
});
