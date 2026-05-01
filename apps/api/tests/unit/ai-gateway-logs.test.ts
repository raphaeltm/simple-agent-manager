/**
 * Unit tests for shared AI Gateway log helpers.
 *
 * Tests period parsing, period bounds, aggregation functions,
 * and pagination resolution — all pure logic, no bindings needed.
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateByDay,
  aggregateByModel,
  type AIGatewayLogEntry,
  getGatewayPeriodBounds,
  getPeriodLabel,
  parseGatewayPeriod,
  resolveGatewayPagination,
  type UsageByDay,
  type UsageByModel,
} from '../../src/services/ai-gateway-logs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AIGatewayLogEntry> = {}): AIGatewayLogEntry {
  return {
    id: 'test-1',
    model: 'gpt-4o',
    provider: 'openai',
    tokens_in: 100,
    tokens_out: 50,
    cost: 0.01,
    success: true,
    cached: false,
    created_at: '2026-04-15T10:00:00Z',
    duration: 500,
    metadata: { userId: 'user-1' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseGatewayPeriod
// ---------------------------------------------------------------------------

describe('parseGatewayPeriod', () => {
  it('returns current-month as default for undefined', () => {
    expect(parseGatewayPeriod(undefined)).toBe('current-month');
  });

  it('returns current-month as default for invalid string', () => {
    expect(parseGatewayPeriod('banana')).toBe('current-month');
    expect(parseGatewayPeriod('')).toBe('current-month');
    expect(parseGatewayPeriod('24h')).toBe('current-month'); // 24h is admin-only
  });

  it('accepts valid periods', () => {
    expect(parseGatewayPeriod('current-month')).toBe('current-month');
    expect(parseGatewayPeriod('7d')).toBe('7d');
    expect(parseGatewayPeriod('30d')).toBe('30d');
    expect(parseGatewayPeriod('90d')).toBe('90d');
  });
});

// ---------------------------------------------------------------------------
// getGatewayPeriodBounds
// ---------------------------------------------------------------------------

describe('getGatewayPeriodBounds', () => {
  it('current-month starts at the first of the month', () => {
    const { startDate } = getGatewayPeriodBounds('current-month');
    const date = new Date(startDate);
    expect(date.getUTCDate()).toBe(1);
    expect(date.getUTCHours()).toBe(0);
  });

  it('7d starts 7 days ago', () => {
    const { startDate } = getGatewayPeriodBounds('7d');
    const date = new Date(startDate);
    const now = new Date();
    const diffDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });

  it('30d starts 30 days ago', () => {
    const { startDate } = getGatewayPeriodBounds('30d');
    const date = new Date(startDate);
    const now = new Date();
    const diffDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(29.9);
    expect(diffDays).toBeLessThanOrEqual(30.1);
  });

  it('returns valid ISO strings', () => {
    for (const period of ['current-month', '7d', '30d', '90d'] as const) {
      const { startDate } = getGatewayPeriodBounds(period);
      expect(new Date(startDate).toISOString()).toBe(startDate);
    }
  });
});

// ---------------------------------------------------------------------------
// getPeriodLabel
// ---------------------------------------------------------------------------

describe('getPeriodLabel', () => {
  it('returns month name for current-month', () => {
    const label = getPeriodLabel('current-month');
    // Should contain a year and a month name
    expect(label).toMatch(/\d{4}/);
    expect(label.length).toBeGreaterThan(5);
  });

  it('returns human-readable labels for day periods', () => {
    expect(getPeriodLabel('7d')).toBe('Last 7 days');
    expect(getPeriodLabel('30d')).toBe('Last 30 days');
    expect(getPeriodLabel('90d')).toBe('Last 90 days');
  });
});

// ---------------------------------------------------------------------------
// resolveGatewayPagination
// ---------------------------------------------------------------------------

describe('resolveGatewayPagination', () => {
  it('uses defaults when env is empty', () => {
    const env = {} as Record<string, string>;
    const { pageSize, maxPages } = resolveGatewayPagination(env as never);
    expect(pageSize).toBe(50);
    expect(maxPages).toBe(20);
  });

  it('respects env overrides', () => {
    const env = { AI_USAGE_PAGE_SIZE: '25', AI_USAGE_MAX_PAGES: '10' };
    const { pageSize, maxPages } = resolveGatewayPagination(env as never);
    expect(pageSize).toBe(25);
    expect(maxPages).toBe(10);
  });

  it('caps maxPages at 20', () => {
    const env = { AI_USAGE_MAX_PAGES: '100' };
    const { maxPages } = resolveGatewayPagination(env as never);
    expect(maxPages).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// aggregateByModel
// ---------------------------------------------------------------------------

describe('aggregateByModel', () => {
  it('creates a new entry for a new model', () => {
    const map = new Map<string, UsageByModel>();
    aggregateByModel(map, makeEntry());
    expect(map.size).toBe(1);
    const entry = map.get('gpt-4o')!;
    expect(entry.requests).toBe(1);
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(50);
    expect(entry.totalTokens).toBe(150);
    expect(entry.costUsd).toBe(0.01);
    expect(entry.cachedRequests).toBe(0);
    expect(entry.errorRequests).toBe(0);
  });

  it('accumulates into existing entry for same model', () => {
    const map = new Map<string, UsageByModel>();
    aggregateByModel(map, makeEntry());
    aggregateByModel(map, makeEntry({ tokens_in: 200, cost: 0.02 }));
    expect(map.size).toBe(1);
    const entry = map.get('gpt-4o')!;
    expect(entry.requests).toBe(2);
    expect(entry.inputTokens).toBe(300);
    expect(entry.costUsd).toBeCloseTo(0.03);
  });

  it('counts cached and error requests', () => {
    const map = new Map<string, UsageByModel>();
    aggregateByModel(map, makeEntry({ cached: true }));
    aggregateByModel(map, makeEntry({ success: false }));
    aggregateByModel(map, makeEntry());
    const entry = map.get('gpt-4o')!;
    expect(entry.cachedRequests).toBe(1);
    expect(entry.errorRequests).toBe(1);
    expect(entry.requests).toBe(3);
  });

  it('handles missing model as "unknown"', () => {
    const map = new Map<string, UsageByModel>();
    aggregateByModel(map, makeEntry({ model: '' }));
    expect(map.has('unknown')).toBe(true);
  });

  it('handles zero/undefined token values', () => {
    const map = new Map<string, UsageByModel>();
    aggregateByModel(map, makeEntry({ tokens_in: 0, tokens_out: 0, cost: 0 }));
    const entry = map.get('gpt-4o')!;
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.totalTokens).toBe(0);
    expect(entry.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateByDay
// ---------------------------------------------------------------------------

describe('aggregateByDay', () => {
  it('creates a new entry for a new day', () => {
    const map = new Map<string, UsageByDay>();
    aggregateByDay(map, makeEntry({ created_at: '2026-04-15T10:00:00Z' }));
    expect(map.size).toBe(1);
    const entry = map.get('2026-04-15')!;
    expect(entry.requests).toBe(1);
    expect(entry.costUsd).toBe(0.01);
  });

  it('accumulates entries for the same day', () => {
    const map = new Map<string, UsageByDay>();
    aggregateByDay(map, makeEntry({ created_at: '2026-04-15T08:00:00Z' }));
    aggregateByDay(map, makeEntry({ created_at: '2026-04-15T20:00:00Z', cost: 0.05 }));
    expect(map.size).toBe(1);
    const entry = map.get('2026-04-15')!;
    expect(entry.requests).toBe(2);
    expect(entry.costUsd).toBeCloseTo(0.06);
  });

  it('creates separate entries for different days', () => {
    const map = new Map<string, UsageByDay>();
    aggregateByDay(map, makeEntry({ created_at: '2026-04-15T10:00:00Z' }));
    aggregateByDay(map, makeEntry({ created_at: '2026-04-16T10:00:00Z' }));
    expect(map.size).toBe(2);
  });

  it('handles missing created_at as "unknown"', () => {
    const map = new Map<string, UsageByDay>();
    aggregateByDay(map, makeEntry({ created_at: '' }));
    expect(map.has('unknown')).toBe(true);
  });
});
