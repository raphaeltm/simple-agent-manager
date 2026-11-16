import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeBookkeepingSummary,
  claimBookkeepingSummaries,
  computeBookkeepingSummaryQueueAlarmTime,
  enqueueBookkeepingSummary,
  rebasePublishedBookkeepingSummary,
  repairBookkeepingSummary,
} from '../../src/do/message-bookkeeping-summary-queue';
import { runMigrations } from '../../src/do/migrations';
import { createSqlStorage } from '../fixtures/sql-storage';

describe('bounded bookkeeping summary publication episodes', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const config = {
    bookkeepingSummaryRetryMs: 100,
    bookkeepingSummaryMaxAttempts: 2,
    bookkeepingSummaryMaxResidenceMs: 1000,
  };
  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });
  afterEach(() => db.close());
  function enqueue(id: string, now = 0) {
    sql.exec(
      `INSERT INTO chat_sessions (id, status, started_at, created_at, updated_at) VALUES (?, 'active', 0, 0, 0)`,
      id
    );
    enqueueBookkeepingSummary(sql, id, now);
  }

  it('pushes a failing full page out before I/O so valid work behind it progresses', () => {
    for (let i = 0; i < 5; i++) enqueue(`session-${i}`);
    const first = claimBookkeepingSummaries(sql, config, 2, 0);
    expect(first.claimed.map((c) => c.sessionId)).toEqual(['session-0', 'session-1']);
    // A caller can now await and fail. Its claimed rows already have durable backoff.
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBe(0);
    const second = claimBookkeepingSummaries(sql, config, 2, 0);
    const third = claimBookkeepingSummaries(sql, config, 2, 0);
    expect(second.claimed.map((c) => c.sessionId)).toEqual(['session-2', 'session-3']);
    expect(third.claimed.map((c) => c.sessionId)).toEqual(['session-4']);
    for (const c of [...second.claimed, ...third.claimed])
      expect(acknowledgeBookkeepingSummary(sql, c)).toBe(true);
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBe(100);
    expect(claimBookkeepingSummaries(sql, config, 5, 99).claimed).toEqual([]);
    expect(claimBookkeepingSummaries(sql, config, 5, 100).claimed).toHaveLength(2);
    const exhausted = claimBookkeepingSummaries(sql, config, 5, 200);
    expect(exhausted.terminal.map((c) => c.reason)).toEqual([
      'attempts_exhausted',
      'attempts_exhausted',
    ]);
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBeNull();
    expect(claimBookkeepingSummaries(sql, config, 5, 1000)).toEqual({ claimed: [], terminal: [] });
  });

  it('preserves age and attempts through ingest, restarts and terminal quarantine', () => {
    enqueue('session');
    claimBookkeepingSummaries(sql, config, 1, 0);
    enqueueBookkeepingSummary(sql, 'session', 50);
    // Recreating the SqlStorage facade models absence of all in-memory retry state.
    const restarted = createSqlStorage(db);
    const second = claimBookkeepingSummaries(restarted, config, 1, 100).claimed[0]!;
    expect(second).toMatchObject({ attempts: 2, version: 2, firstQueuedAt: 0 });
    enqueueBookkeepingSummary(restarted, 'session', 150);
    expect(claimBookkeepingSummaries(restarted, config, 1, 200).terminal).toHaveLength(1);
    enqueueBookkeepingSummary(restarted, 'session', 300);
    expect(computeBookkeepingSummaryQueueAlarmTime(restarted)).toBeNull();
    expect(rebasePublishedBookkeepingSummary(restarted, second, 300)).toBe(false);
    expect(repairBookkeepingSummary(restarted, 'session', 400)).toBe(true);
    expect(claimBookkeepingSummaries(restarted, config, 1, 400).claimed[0]).toMatchObject({
      attempts: 1,
      firstQueuedAt: 400,
    });
  });

  it('caps retry eligibility at maximum residence and never retries after expiry', () => {
    enqueue('session');
    const short = { ...config, bookkeepingSummaryMaxResidenceMs: 50 };
    expect(claimBookkeepingSummaries(sql, short, 1, 0).claimed).toHaveLength(1);
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBe(50);
    expect(claimBookkeepingSummaries(sql, short, 1, 50).terminal[0]?.reason).toBe(
      'residence_exhausted'
    );
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBeNull();
  });

  it('fences stale acknowledgements and allows only successful publication to rebase a renewed fold', () => {
    enqueue('session');
    const first = claimBookkeepingSummaries(sql, config, 1, 0).claimed[0]!;
    enqueueBookkeepingSummary(sql, 'session', 10);
    expect(acknowledgeBookkeepingSummary(sql, first)).toBe(false);
    expect(rebasePublishedBookkeepingSummary(sql, first, 20)).toBe(true);
    const next = claimBookkeepingSummaries(sql, config, 1, 20).claimed[0]!;
    expect(next).toMatchObject({ attempts: 1, version: 2, firstQueuedAt: 20 });
    expect(acknowledgeBookkeepingSummary(sql, first)).toBe(false);
    expect(rebasePublishedBookkeepingSummary(sql, first, 30)).toBe(false);
    expect(acknowledgeBookkeepingSummary(sql, next)).toBe(true);
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBeNull();
  });

  it('cascade-deletes queue rows with the owning session', () => {
    enqueue('session');
    sql.exec('DELETE FROM chat_sessions WHERE id = ?', 'session');
    expect(computeBookkeepingSummaryQueueAlarmTime(sql)).toBeNull();
  });
});
