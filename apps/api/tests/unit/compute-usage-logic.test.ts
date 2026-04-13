/**
 * Unit tests for compute usage pure logic functions.
 *
 * Tests getCurrentPeriodBounds and the vCPU-hours calculation logic
 * without requiring D1 bindings — these are behavioral tests that
 * verify the actual calculation results.
 */
import { describe, expect, it } from 'vitest';

import { calculateNodeVcpuHours, getCurrentPeriodBounds } from '../../src/services/compute-usage';

describe('getCurrentPeriodBounds', () => {
  it('returns start at the first day of the current month at midnight UTC', () => {
    const { start } = getCurrentPeriodBounds();
    const date = new Date(start);
    expect(date.getUTCDate()).toBe(1);
    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCMinutes()).toBe(0);
    expect(date.getUTCSeconds()).toBe(0);
  });

  it('returns end at the last day of the current month at 23:59:59 UTC', () => {
    const { end } = getCurrentPeriodBounds();
    const date = new Date(end);
    expect(date.getUTCHours()).toBe(23);
    expect(date.getUTCMinutes()).toBe(59);
    expect(date.getUTCSeconds()).toBe(59);
  });

  it('start and end are in the same month', () => {
    const { start, end } = getCurrentPeriodBounds();
    const startDate = new Date(start);
    const endDate = new Date(end);
    expect(startDate.getUTCMonth()).toBe(endDate.getUTCMonth());
    expect(startDate.getUTCFullYear()).toBe(endDate.getUTCFullYear());
  });

  it('returns valid ISO strings', () => {
    const { start, end } = getCurrentPeriodBounds();
    expect(new Date(start).toISOString()).toBe(start);
    expect(new Date(end).toISOString()).toBe(end);
  });

  it('end date is the last day of the month (not first of next)', () => {
    const { end } = getCurrentPeriodBounds();
    const endDate = new Date(end);
    const nextDay = new Date(endDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    // Next day should be in the next month
    expect(nextDay.getUTCMonth()).not.toBe(endDate.getUTCMonth());
  });
});

describe('vCPU-hours calculation logic', () => {
  const periodStart = new Date('2026-04-01T00:00:00.000Z');
  const periodEnd = new Date('2026-04-30T23:59:59.999Z');

  it('calculates correctly for session fully inside the period', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T02:00:00Z', vcpuCount: 4 }],
      periodStart,
      periodEnd
    );
    // 2 hours * 4 vCPUs = 8 vCPU-hours
    expect(result).toBe(8);
  });

  it('clamps session start to period start when session starts before period', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-03-28T00:00:00Z', endedAt: '2026-04-02T00:00:00Z', vcpuCount: 2 }],
      periodStart,
      periodEnd
    );
    // Clamped: 2026-04-01 to 2026-04-02 = 24 hours * 2 vCPUs = 48
    expect(result).toBe(48);
  });

  it('clamps session end to period end when session extends past period', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-04-29T00:00:00Z', endedAt: '2026-05-05T00:00:00Z', vcpuCount: 2 }],
      periodStart,
      periodEnd
    );
    // Clamped: 2026-04-29 to 2026-04-30T23:59:59.999Z ≈ ~48 hours * 2
    const expectedHours = (periodEnd.getTime() - new Date('2026-04-29T00:00:00Z').getTime()) / (1000 * 60 * 60);
    expect(result).toBeCloseTo(expectedHours * 2, 2);
  });

  it('returns zero for session entirely before the period', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-03-01T00:00:00Z', endedAt: '2026-03-15T00:00:00Z', vcpuCount: 4 }],
      periodStart,
      periodEnd
    );
    expect(result).toBe(0);
  });

  it('returns zero for session entirely after the period', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-05-01T00:00:00Z', endedAt: '2026-05-02T00:00:00Z', vcpuCount: 4 }],
      periodStart,
      periodEnd
    );
    expect(result).toBe(0);
  });

  it('uses current time for running sessions (null endedAt)', () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-04-15T10:00:00Z', endedAt: null, vcpuCount: 2 }],
      periodStart,
      periodEnd,
      now
    );
    // 2 hours * 2 vCPUs = 4
    expect(result).toBe(4);
  });

  it('counts overlapping sessions on different nodes independently', () => {
    const result = calculateNodeVcpuHours(
      [
        { nodeId: 'node-1', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T01:00:00Z', vcpuCount: 4 },
        { nodeId: 'node-2', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T01:00:00Z', vcpuCount: 8 },
      ],
      periodStart,
      periodEnd
    );
    // 1h * 4 + 1h * 8 = 12 vCPU-hours
    expect(result).toBe(12);
  });

  it('merges overlapping sessions on the same node', () => {
    const result = calculateNodeVcpuHours(
      [
        { nodeId: 'node-1', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T02:00:00Z', vcpuCount: 4 },
        { nodeId: 'node-1', startedAt: '2026-04-10T01:00:00Z', endedAt: '2026-04-10T03:00:00Z', vcpuCount: 4 },
      ],
      periodStart,
      periodEnd
    );

    expect(result).toBe(12);
  });

  it('does not double-count identical overlapping workspace sessions on one node', () => {
    const result = calculateNodeVcpuHours(
      [
        { nodeId: 'node-1', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T01:00:00Z', vcpuCount: 4 },
        { nodeId: 'node-1', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T01:00:00Z', vcpuCount: 4 },
      ],
      periodStart,
      periodEnd
    );

    expect(result).toBe(4);
  });

  it('returns zero for zero-duration session', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T00:00:00Z', vcpuCount: 4 }],
      periodStart,
      periodEnd
    );
    expect(result).toBe(0);
  });

  it('returns zero for empty sessions array', () => {
    const result = calculateNodeVcpuHours([], periodStart, periodEnd);
    expect(result).toBe(0);
  });

  it('handles session spanning entire period', () => {
    const result = calculateNodeVcpuHours(
      [{ nodeId: 'node-1', startedAt: '2026-03-15T00:00:00Z', endedAt: '2026-05-15T00:00:00Z', vcpuCount: 1 }],
      periodStart,
      periodEnd
    );
    const periodHours = (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60);
    expect(result).toBeCloseTo(periodHours, 2);
  });
});
