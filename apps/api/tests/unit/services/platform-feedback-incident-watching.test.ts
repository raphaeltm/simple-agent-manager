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
import { FLEET_OPS_DEFAULTS } from '../../../src/services/fleet-ops/settings-definitions';
import type { IdeaWorkSnapshotReader } from '../../../src/services/platform-feedback-incidents';
import {
  buildIncidentBacklogSummary,
  claimIncident,
  evaluateSpike,
  explainUndispatchableIncidents,
  getIncidentConfig,
  hasDispatchablePendingIncidents,
  listDispatchableIncidentQueue,
  listIncidentQueue,
  parseHourlyCounts,
  recordWatchedRecurrence,
  resolveIncident,
  watchConfigFromSettings,
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
      watch_count_floor INTEGER, watch_counted_ids TEXT,
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
  const run = (now: number, readEngagement: IdeaWorkSnapshotReader = noEngagement) =>
    runPlatformFeedbackTriage(env, 'cron', {
      now: () => now,
      diagnose,
      readEngagement,
    });
  const setSetting = (name: string, value: string) =>
    main
      .prepare(
        `INSERT OR REPLACE INTO platform_settings (key, value, updated_at, updated_by)
         VALUES (?, ?, '2026-11-01T00:00:00Z', 'superadmin-1')`
      )
      .run(name, value);
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
  return { main, env, diagnose, run, addErrors, row, idea, signatureFor, setSetting };
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
    // Deliberately held, not stalled: the decline breakdown and stall anomaly read pending only.
    const breakdown = await explainUndispatchableIncidents(
      h.env,
      getIncidentConfig(h.env),
      t1 + 30 * DAY,
      HOUR
    );
    expect(breakdown).toMatchObject({ pending: 0, stalled: 0 });
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

describe('incident WATCHING robustness', () => {
  const engagedReader =
    (ideaId: () => string): IdeaWorkSnapshotReader =>
    async () => ({
      [ideaId()]: { sessions: [], updates: 1, fileIds: [], pullRequestUrls: [] },
    });

  it('two overlapping recordings add a window once (compare-and-set on the counted ids)', async () => {
    const h = setup();
    const message = 'overlapping hourly windows race on the same signature';
    const signature = await seedWatched(h, message);
    const config = watchConfigFromSettings(FLEET_OPS_DEFAULTS);
    const input = {
      signature,
      occurrences: spread(T0 + HOUR, 5).map((timestamp) => ({ id: randomUUID(), timestamp })),
      severity: 'error',
      evidenceRefs: '[]',
      now: T0 + 2 * HOUR,
      config,
      dedupeHorizonMs: 2 * HOUR,
    };
    const outcomes = await Promise.all([
      recordWatchedRecurrence(h.env, input),
      recordWatchedRecurrence(h.env, input),
    ]);
    expect(outcomes.filter((outcome) => outcome.recorded)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.recorded)).toMatchObject({ newOccurrences: 0 });
    expect(h.row(signature).occurrence_count).toBe(6);
    const buckets = parseHourlyCounts(h.row(signature).watch_hourly_counts as string);
    expect([...buckets.values()].reduce((sum, n) => sum + n, 0)).toBe(5);
  });

  it('one failing watched signature does not stop the others, new triage or quiet expiry', async () => {
    const h = setup();
    const broken = 'broken: watched signature whose write keeps failing';
    const healthy = 'healthy: watched signature that records normally';
    const quiet = 'quiet: watched signature that went quiet long ago';
    const quietSignature = await seedWatched(h, quiet, T0 - 14 * DAY + HOUR);
    const brokenSignature = await seedWatched(h, broken);
    const healthySignature = await seedWatched(h, healthy, T0 + 1_000);
    const database = h.env.DATABASE;
    h.env.DATABASE = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (!sql.includes('watch_counted_ids IS ?')) return statement;
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            if (!values.includes(brokenSignature)) return bound;
            return { ...bound, run: async () => Promise.reject(new Error('D1 write failed')) };
          },
        };
      },
    } as unknown as Env['DATABASE'];

    const t1 = T0 + 2 * HOUR;
    h.addErrors(broken, [t1]);
    h.addErrors(healthy, [t1 + 1_000]);
    h.addErrors('a novel failure in the same window', [t1 + 2_000]);
    const result = await h.run(t1 + 5 * 60_000);

    expect(result).toMatchObject({ groupsFailed: 1, watchedRecurrences: 1, ideasCreated: 1 });
    expect(result.failureReasons).toEqual(['D1 write failed']);
    expect(h.row(healthySignature).occurrence_count).toBe(2);
    expect(h.row(brokenSignature).occurrence_count).toBe(1);
    expect(result.watchedExpired).toBe(1);
    expect(h.row(quietSignature).queue_state).toBe('expired');
  });

  it('counts a late-committed error with an older timestamp and same-millisecond errors once each', async () => {
    const h = setup();
    const message = 'errors that commit out of order';
    const signature = await seedWatched(h, message);
    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, [t1 + 30 * 60_000, t1 + 30 * 60_000]); // same millisecond
    await h.run(t1 + 40 * 60_000);
    expect(h.row(signature).occurrence_count).toBe(3);
    // A row that commits after that run, with an earlier timestamp still inside the next window.
    h.addErrors(message, [t1 + 20 * 60_000]);
    await h.run(t1 + 70 * 60_000);
    expect(h.row(signature).occurrence_count).toBe(4);
    // A manual run over the same window adds nothing.
    await h.run(t1 + 75 * 60_000);
    expect(h.row(signature).occurrence_count).toBe(4);
  });

  it('does not recount errors from before the watch decision', async () => {
    const h = setup();
    const message = 'errors just before the watch decision';
    h.addErrors(message, [T0, T0 + 1_000]);
    await h.run(T0 + 60_000);
    const signature = h.signatureFor(message);
    const claim = await claimIncident(h.env, signature, TRIAGE_TASK, T0 + 120_000);
    await watchIncident(
      h.env,
      signature,
      claim!.claimToken,
      TRIAGE_TASK,
      'watch',
      T0 + 130_000,
      2_000
    );
    // The next run's window still contains both pre-watch errors plus one new one.
    h.addErrors(message, [T0 + 10 * 60_000]);
    await h.run(T0 + 30 * 60_000);
    expect(h.row(signature).occurrence_count).toBe(3);
  });

  it('a watched signature whose recording failed is not quiet-expired in that run', async () => {
    const h = setup();
    const message = 'old watch that recurs while its write fails';
    const signature = await seedWatched(h, message, T0 - 15 * DAY);
    const database = h.env.DATABASE;
    h.env.DATABASE = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (!sql.includes('watch_counted_ids IS ?')) return statement;
        return {
          ...statement,
          bind: (...values: unknown[]) => ({
            ...statement.bind(...values),
            run: async () => Promise.reject(new Error('D1 write failed')),
          }),
        };
      },
    } as unknown as Env['DATABASE'];
    h.addErrors(message, [T0 + 1_000]);
    const result = await h.run(T0 + 5 * 60_000);
    expect(result).toMatchObject({ groupsFailed: 1, watchedExpired: 0 });
    expect(h.row(signature).queue_state).toBe('watching');
  });

  it('records a signature that became watching between selection and the ordinary update', async () => {
    const h = setup();
    const message = 'watched by a concurrent triage mid-run';
    h.addErrors(message, [T0]);
    await h.run(T0 + 60_000);
    const signature = h.signatureFor(message);
    const claim = await claimIncident(h.env, signature, TRIAGE_TASK, T0 + 120_000);
    const database = h.env.DATABASE;
    let flipped = false;
    h.env.DATABASE = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (flipped || !sql.includes("queue_state <> 'watching'")) return statement;
        return {
          ...statement,
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              ...bound,
              run: async () => {
                // The concurrent triage task commits its watch decision first.
                flipped = true;
                await watchIncident(
                  h.env,
                  signature,
                  claim!.claimToken,
                  TRIAGE_TASK,
                  'concurrent watch',
                  T0 + 130_000,
                  2_000
                );
                return bound.run();
              },
            };
          },
        };
      },
    } as unknown as Env['DATABASE'];

    h.addErrors(message, [T0 + 20 * 60_000]);
    const result = await h.run(T0 + 30 * 60_000);

    expect(flipped).toBe(true);
    expect(result.watchedRecurrences).toBe(1);
    expect(h.row(signature)).toMatchObject({ queue_state: 'watching', occurrence_count: 2 });
    expect(h.diagnose).toHaveBeenCalledTimes(1);
  });

  it('records counts but leaves an engaged idea alone and releases it', async () => {
    const h = setup();
    const message = 'watched signature whose idea someone took up';
    const signature = await seedWatched(h, message);
    const ideaId = () => h.row(signature).idea_id as string;
    const before = h.idea(signature).description;

    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, [t1, t1 + 1_000]);
    const result = await h.run(t1 + 5 * 60_000, engagedReader(ideaId));

    expect(result).toMatchObject({ watchedRecurrences: 1, ideasUpdated: 0 });
    expect(h.row(signature)).toMatchObject({ queue_state: 'watching', occurrence_count: 3 });
    expect(h.idea(signature).description).toBe(before);
    expect(
      h.main
        .prepare('SELECT idea_owned_at FROM platform_feedback_triages WHERE signature = ?')
        .get(signature)
    ).toEqual({ idea_owned_at: 'released' });
  });

  it('records counts for a watched signature with no idea', async () => {
    const h = setup();
    const message = 'watched signature without an idea';
    const signature = await seedWatched(h, message);
    h.main
      .prepare('UPDATE platform_feedback_triages SET idea_id = NULL WHERE signature = ?')
      .run(signature);
    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, [t1]);
    const result = await h.run(t1 + 5 * 60_000);
    expect(result).toMatchObject({ watchedRecurrences: 1, groupsFailed: 0 });
    expect(h.row(signature).occurrence_count).toBe(2);
  });

  it('a few old occurrences do not inflate the baseline and hide a burst', async () => {
    const h = setup();
    const message = 'a few stray errors then a real burst';
    const signature = await seedWatched(h, message);
    // Watched since T0; three stray errors on day three, then a burst of 50 just over a day later.
    const stray = T0 + 3 * DAY;
    h.addErrors(message, spread(stray, 3));
    await h.run(stray + 5 * 60_000);
    // Earlier rate since the watch began: 3 in ~73h, about 1 a day. Measured only from the
    // stray hour it would look like ~70 a day and hide the burst.
    const burst = stray + 25 * HOUR;
    h.addErrors(message, spread(burst, 50));
    await h.run(burst + 5 * 60_000);
    expect(h.row(signature).queue_state).toBe('pending');
  });

  it('uses the admin settings: a lower spike threshold, a shorter quiet period, a record cap', async () => {
    const h = setup();
    h.setSetting('operations.incidentWatchSpikeMinOccurrences', '5');
    h.setSetting('operations.incidentWatchQuietExpiryHours', '24');
    const spiking = 'settings-driven spike signature';
    const control = 'settings-driven control signature';
    const spikingSignature = await seedWatched(h, spiking);
    const controlSignature = await seedWatched(h, control, T0 + 1_000);

    const t1 = T0 + 2 * HOUR;
    h.addErrors(spiking, spread(t1, 6));
    h.addErrors(control, spread(t1 + 10_000, 4));
    await h.run(t1 + 5 * 60_000);
    expect(h.row(spikingSignature).queue_state).toBe('pending');
    expect(h.row(controlSignature).queue_state).toBe('watching');

    // 24h quiet period: the control expires two days later.
    const result = await h.run(t1 + 2 * DAY);
    expect(result.watchedExpired).toBe(1);
    expect(h.row(controlSignature).queue_state).toBe('expired');
  });

  it('falls back to default settings when settings cannot be read', async () => {
    const h = setup();
    const message = 'watched while the settings store is unavailable';
    const warn = vi.spyOn(console, 'warn');
    // A stored row the settings cache cannot parse makes the whole settings read fail.
    h.main
      .prepare(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by)
         VALUES ('operations.incidentWatchSpikeMinOccurrences', '5', NULL, NULL)`
      )
      .run();
    const signature = await seedWatched(h, message);
    const t1 = T0 + 2 * HOUR;
    h.addErrors(message, spread(t1, 10));
    const result = await h.run(t1 + 5 * 60_000);
    expect(result.watchedRecurrences).toBe(1);
    // Defaults apply: 10 is under the default 50, while the unreadable stored 5 would spike.
    expect(h.row(signature)).toMatchObject({ queue_state: 'watching', occurrence_count: 11 });
    expect(JSON.stringify(warn.mock.calls)).toContain('watch_settings_read_failed');
    warn.mockRestore();
  });

  it('expiry is one-shot, and a later recurrence reopens the signature and its idea', async () => {
    const h = setup();
    const message = 'quiet signature that comes back much later';
    const signature = await seedWatched(h, message);
    const expiredAt = T0 + 15 * DAY;
    expect((await h.run(expiredAt)).watchedExpired).toBe(1);
    expect((await h.run(expiredAt + HOUR)).watchedExpired).toBe(0);
    expect(h.row(signature)).toMatchObject({ queue_state: 'expired', expired_at: expiredAt });
    await reconcileIncidentIdeas(h.env, {
      now: () => expiredAt + HOUR,
      readEngagement: noEngagement,
      batchSize: 10,
      deadlineMs: 10_000,
    });
    expect(h.idea(signature).status).toBe('cancelled');

    const back = expiredAt + 2 * HOUR;
    h.addErrors(message, [back]);
    await h.run(back + 60_000);
    expect(h.row(signature)).toMatchObject({ queue_state: 'pending', queued_at: back + 60_000 });
    expect(h.idea(signature).status).toBe('draft');
  });

  it('watchIncident enforces the claim fence and clears dispatch bookkeeping', async () => {
    const h = setup();
    const message = 'claim fence for the watching transition';
    h.addErrors(message, [T0]);
    await h.run(T0 + 60_000);
    const signature = h.signatureFor(message);
    const watch = (token: string, task: string, at: number) =>
      watchIncident(h.env, signature, token, task, 'reason', at, 2_000);

    // Not claimed: refused.
    expect(await watch('none', TRIAGE_TASK, T0 + 90_000)).toBe(false);
    const claim = await claimIncident(h.env, signature, TRIAGE_TASK, T0 + 120_000);
    h.main
      .prepare(
        `UPDATE platform_feedback_triages SET dispatch_attempts = 2, budget_deferred_until = ?,
           dispatch_lease_token = 'lease', dispatched_task_id = 'dispatched-task' WHERE signature = ?`
      )
      .run(T0 + DAY, signature);
    expect(await watch(claim!.claimToken, 'another-task', T0 + 130_000)).toBe(false);
    expect(await watch('wrong-token', TRIAGE_TASK, T0 + 130_000)).toBe(false);
    expect(await watch(claim!.claimToken, TRIAGE_TASK, T0 + 10 * DAY)).toBe(false); // lease expired
    expect(h.row(signature).queue_state).toBe('claimed');

    expect(await watch(claim!.claimToken, TRIAGE_TASK, T0 + 130_000)).toBe(true);
    expect(
      h.main
        .prepare(
          `SELECT queue_state, dispatch_attempts, budget_deferred_until, dispatch_lease_token,
             dispatched_task_id, incident_claim_token FROM platform_feedback_triages WHERE signature = ?`
        )
        .get(signature)
    ).toEqual({
      queue_state: 'watching',
      dispatch_attempts: 0,
      budget_deferred_until: null,
      dispatch_lease_token: null,
      dispatched_task_id: null,
      incident_claim_token: null,
    });
    // A watched row cannot be claimed or resolved.
    expect(await claimIncident(h.env, signature, TRIAGE_TASK, T0 + DAY)).toBeNull();
  });

  it("a person's report cannot be watched", async () => {
    const h = setup();
    h.main
      .prepare(
        `INSERT INTO platform_feedback_triages
          (signature, source, summary, first_seen_at, last_seen_at, occurrence_count, evidence_refs,
           queue_state, queued_at)
         VALUES ('report-1', 'user-report', 'User report', ?, ?, 1, '[]', 'pending', ?)`
      )
      .run(T0, T0, T0);
    const claim = await claimIncident(h.env, 'report-1', TRIAGE_TASK, T0 + 1_000);
    expect(
      await watchIncident(h.env, 'report-1', claim!.claimToken, TRIAGE_TASK, 'r', T0 + 2_000, 2_000)
    ).toBe(false);
    expect(h.row('report-1').queue_state).toBe('claimed');
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
    expect([
      ...parseHourlyCounts('{"10":3,"x":4,"11":-1,"12":"5","13":2.5,"014":4,"15.0":1}'),
    ]).toEqual([[10, 3]]);
  });
});
