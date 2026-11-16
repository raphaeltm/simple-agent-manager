/**
 * The Cloudflare card read (Insights slice CF): month-to-date, the rule-76.4 projection (spent
 * so far plus the recent daily rate, not the running average), top product lines and the daily
 * series, from rows on a real SQL engine.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import {
  cloudflareReadStartDay,
  readCloudflareCost,
  summarizeCloudflareCost,
} from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const OPTIONS = { seriesDays: 30, topLines: 3, projectionDays: 7 };
const novDay = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;

type Line = Parameters<typeof summarizeCloudflareCost>[0][number];

describe('summarizeCloudflareCost', () => {
  it('projects from the recent daily rate, not the month-to-date average', () => {
    // DO rows written: 20M a day for the first 4 days, then 1M a day through Nov 15.
    const rows: Line[] = Array.from({ length: 15 }, (_, index) => ({
      day: novDay(index + 1),
      key: 'doRowsWritten',
      usage: index < 4 ? 20_000_000 : 1_000_000,
      costUsd: 0,
    }));
    rows[2]!.costUsd = 10; // the allowance (50M) runs out during day 3
    rows[3]!.costUsd = 20;
    for (let index = 4; index < 15; index++) rows[index]!.costUsd = 1;

    const card = summarizeCloudflareCost(rows, null, OPTIONS);
    const line = card.productLines.find((entry) => entry.key === 'doRowsWritten');

    // MTD: 91M rows → $41. Recent 7-day rate 1M/day × 15 remaining days → 106M → $56.
    // The running average (91M/15 ≈ 6.07M/day) would have projected 182M → $132.
    expect(line?.monthToDateUsd).toBeCloseTo(41, 6);
    expect(line?.monthToDateUsage).toBe(91_000_000);
    expect(line?.projectedUsd).toBeCloseTo(56, 6);
    expect(card.month).toBe('2026-11');
    expect(card.throughDay).toBe('2026-11-15');
    expect(card.monthComplete).toBe(false);
    expect(card.missingDays).toBe(0);
    expect(card.status).toBe('never_run');
  });

  it('projects with the configured number of recent days', () => {
    // 10M rows written a day for 10 days, then 2M a day for 5 days (allowance 50M).
    const rows: Line[] = Array.from({ length: 15 }, (_, index) => ({
      day: novDay(index + 1),
      key: 'doRowsWritten',
      usage: index < 10 ? 10_000_000 : 2_000_000,
      costUsd: 0,
    }));
    const project = (projectionDays: number) =>
      summarizeCloudflareCost(rows, null, { ...OPTIONS, projectionDays }).productLines.find(
        (line) => line.key === 'doRowsWritten'
      )?.projectedUsd;

    // MTD 110M. 5-day rate 2M × 15 → 140M → $90; 15-day rate (110/15)M × 15 → 220M → $170.
    expect(project(5)).toBeCloseTo(90, 6);
    expect(project(15)).toBeCloseTo(170, 6);
  });

  it('keeps the top lines by projected cost and sums the rest', () => {
    const rows: Line[] = [
      { day: novDay(1), key: 'r2StorageGb', usage: 174, costUsd: 0.08 },
      { day: novDay(1), key: 'workersAiNeurons', usage: 21_000, costUsd: 0.121 },
      { day: novDay(1), key: 'kvReads', usage: 10, costUsd: 0 },
      { day: novDay(1), key: 'doRequests', usage: 3_000_000, costUsd: 0.3 },
      { day: novDay(1), key: 'containerMemoryGibSeconds', usage: 100_000, costUsd: 0.025 },
    ];
    const card = summarizeCloudflareCost(rows, null, OPTIONS);

    expect(card.productLines.map((line) => line.key)).toHaveLength(3);
    expect(card.otherProductLines.count).toBe(16);
    const listed = card.productLines.reduce((total, line) => total + line.projectedUsd, 0);
    expect(listed + card.otherProductLines.projectedUsd).toBeCloseTo(card.projectedUsd, 9);
    expect(card.monthToDateUsd).toBeCloseTo(0.526, 9);
    // Ranked by projected cost, ties broken by key so the order is stable.
    const projected = card.productLines.map((line) => line.projectedUsd);
    expect([...projected].sort((a, b) => b - a)).toEqual(projected);
  });

  it('marks missing days, closes a finished month and leaves gaps in the series', () => {
    const rows: Line[] = [
      { day: '2026-10-01', key: 'doRequests', usage: 2_000_000, costUsd: 0.15 },
      { day: '2026-10-31', key: 'doRequests', usage: 2_000_000, costUsd: 0.3 },
    ];
    const card = summarizeCloudflareCost(
      rows,
      { status: 'error', lastAttemptAt: null, lastSuccessAt: null, error: 'boom' },
      { seriesDays: 7, topLines: 5, projectionDays: 7 }
    );

    expect(card.status).toBe('error');
    expect(card.error).toBe('boom');
    expect(card.monthComplete).toBe(true);
    expect(card.missingDays).toBe(29);
    expect(card.projectedUsd).toBeCloseTo(card.monthToDateUsd, 9);
    expect(card.daily).toHaveLength(7);
    expect(card.daily[0]).toEqual({ day: '2026-10-25', costUsd: null });
    expect(card.daily[6]).toEqual({ day: '2026-10-31', costUsd: 0.3 });
  });

  it('reports an empty card when nothing is stored yet', () => {
    const card = summarizeCloudflareCost([], null, OPTIONS);
    expect(card).toMatchObject({
      status: 'never_run',
      month: null,
      throughDay: null,
      monthToDateUsd: 0,
      productLines: [],
      daily: [],
    });
  });
});

describe('readCloudflareCost', () => {
  let sqlite: Database.Database;
  let ctx: OperationContext;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    ctx = { env: { DATABASE: createSqliteD1(sqlite) } as unknown as Env } as OperationContext;
  });
  afterEach(() => sqlite.close());

  it('reads the stored month and sync status, skipping a malformed row', async () => {
    sqlite.exec(`
      INSERT INTO installation_cost_daily VALUES
        ('cloudflare', '2026-11-14', 'r2StorageGb', 174, 'GB', 0.08, 1),
        ('cloudflare', '2026-11-15', 'r2StorageGb', 174, 'GB', 0.08, 1),
        ('cloudflare', '2026-11-15', 'retiredMetric', 1, 'x', 99, 1),
        ('other-source', '2026-11-15', 'r2StorageGb', 999, 'GB', 99, 1),
        ('cloudflare', '2026-08-01', 'r2StorageGb', 174, 'GB', 99, 1);
      INSERT INTO installation_cost_sync (source, status, last_attempt_at, last_success_at, error_message, rows_written)
      VALUES ('cloudflare', 'permission_denied', ${NOW}, ${NOW - 86_400_000}, 'Authentication error', 0);
    `);

    const card = await readCloudflareCost(ctx, NOW, OPTIONS);

    expect(card.status).toBe('permission_denied');
    expect(card.error).toBe('Authentication error');
    expect(card.lastSuccessAt).toBe(new Date(NOW - 86_400_000).toISOString());
    expect(card.throughDay).toBe('2026-11-15');
    // Only this source's known lines in the read window count.
    expect(card.monthToDateUsd).toBeCloseTo(0.16, 9);
    expect(card.missingDays).toBe(13);
  });

  it('reads back from the previous month so a month-end day is still found', () => {
    expect(cloudflareReadStartDay(Date.parse('2026-11-01T01:00:00Z'), 30)).toBe('2026-10-01');
    expect(cloudflareReadStartDay(NOW, 62)).toBe('2026-09-15');
  });
});
