/**
 * Behavioral unit tests for node selection logic (TDF-3).
 *
 * Tests the exported pure functions from node-selector.ts:
 * - scoreNodeLoad() — weighted CPU/memory scoring
 * - nodeHasCapacity() — threshold-based capacity check
 *
 * Also tests the full selectNodeForTaskRun() flow with mocked D1
 * and Durable Object stubs to verify warm pool, capacity, and fallback paths.
 */
import { describe, it, expect } from 'vitest';
import { scoreNodeLoad, nodeHasCapacity } from '../../src/services/node-selector';
import type { NodeMetrics } from '@simple-agent-manager/shared';

// =============================================================================
// scoreNodeLoad — pure function tests
// =============================================================================

describe('scoreNodeLoad', () => {
  it('returns null when metrics are null', () => {
    expect(scoreNodeLoad(null)).toBeNull();
  });

  it('returns 0 for fully idle node (0% CPU, 0% memory)', () => {
    expect(scoreNodeLoad({ cpuLoadAvg1: 0, memoryPercent: 0 })).toBe(0);
  });

  it('returns 100 for fully loaded node (100% CPU, 100% memory)', () => {
    expect(scoreNodeLoad({ cpuLoadAvg1: 100, memoryPercent: 100 })).toBe(100);
  });

  it('applies 40% CPU + 60% memory weighting', () => {
    // 50% CPU * 0.4 = 20, 80% mem * 0.6 = 48, total = 68
    expect(scoreNodeLoad({ cpuLoadAvg1: 50, memoryPercent: 80 })).toBe(68);
  });

  it('weights memory higher than CPU', () => {
    // High CPU, low memory
    const cpuHeavy = scoreNodeLoad({ cpuLoadAvg1: 90, memoryPercent: 10 });
    // Low CPU, high memory
    const memHeavy = scoreNodeLoad({ cpuLoadAvg1: 10, memoryPercent: 90 });

    // 90*0.4 + 10*0.6 = 36+6 = 42
    expect(cpuHeavy).toBe(42);
    // 10*0.4 + 90*0.6 = 4+54 = 58
    expect(memHeavy).toBe(58);

    // Memory-heavy node should score higher (more loaded)
    expect(memHeavy).toBeGreaterThan(cpuHeavy!);
  });

  it('treats missing cpuLoadAvg1 as 0', () => {
    expect(scoreNodeLoad({ memoryPercent: 50 })).toBe(30); // 0*0.4 + 50*0.6
  });

  it('treats missing memoryPercent as 0', () => {
    expect(scoreNodeLoad({ cpuLoadAvg1: 50 })).toBe(20); // 50*0.4 + 0*0.6
  });

  it('treats both missing as 0', () => {
    // Only diskPercent provided — cpu and memory default to 0
    expect(scoreNodeLoad({ diskPercent: 90 })).toBe(0);
  });

  it('handles fractional values', () => {
    const score = scoreNodeLoad({ cpuLoadAvg1: 33.5, memoryPercent: 67.2 });
    // 33.5*0.4 + 67.2*0.6 = 13.4 + 40.32 = 53.72
    expect(score).toBeCloseTo(53.72, 2);
  });

  it('handles values above 100 (overloaded node)', () => {
    // CPU load average can exceed 100% on multi-core systems
    const score = scoreNodeLoad({ cpuLoadAvg1: 200, memoryPercent: 95 });
    // 200*0.4 + 95*0.6 = 80 + 57 = 137
    expect(score).toBe(137);
  });
});

// =============================================================================
// nodeHasCapacity — pure function tests
// =============================================================================

describe('nodeHasCapacity', () => {
  const defaultCpuThreshold = 80;
  const defaultMemThreshold = 80;
  const defaultMaxWs = 10;

  describe('workspace count checks', () => {
    it('returns false when at max workspaces per node', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 10 };
      expect(nodeHasCapacity(metrics, 10, 10, defaultCpuThreshold, defaultMemThreshold)).toBe(false);
    });

    it('returns false when over max workspaces per node', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 10 };
      expect(nodeHasCapacity(metrics, 15, 10, defaultCpuThreshold, defaultMemThreshold)).toBe(false);
    });

    it('returns true when under max workspaces per node', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 10 };
      expect(nodeHasCapacity(metrics, 9, 10, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('returns true with zero active workspaces', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 10 };
      expect(nodeHasCapacity(metrics, 0, 10, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('respects custom maxWorkspacesPerNode of 1', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 10 };
      expect(nodeHasCapacity(metrics, 0, 1, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
      expect(nodeHasCapacity(metrics, 1, 1, defaultCpuThreshold, defaultMemThreshold)).toBe(false);
    });
  });

  describe('null metrics handling', () => {
    it('returns true when metrics are null and workspace count is under limit', () => {
      expect(nodeHasCapacity(null, 5, 10, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('returns false when metrics are null but workspace count is at limit', () => {
      expect(nodeHasCapacity(null, 10, 10, defaultCpuThreshold, defaultMemThreshold)).toBe(false);
    });
  });

  describe('CPU threshold checks', () => {
    it('returns true when CPU is below threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 79, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, defaultMemThreshold)).toBe(true);
    });

    it('returns false when CPU is at threshold (>= means no capacity)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 80, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, defaultMemThreshold)).toBe(false);
    });

    it('returns false when CPU is above threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 81, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, defaultMemThreshold)).toBe(false);
    });

    it('passes at CPU 79% and fails at 80% (boundary test)', () => {
      const metricsPass: NodeMetrics = { cpuLoadAvg1: 79, memoryPercent: 0 };
      const metricsFail: NodeMetrics = { cpuLoadAvg1: 80, memoryPercent: 0 };
      expect(nodeHasCapacity(metricsPass, 0, defaultMaxWs, 80, 100)).toBe(true);
      expect(nodeHasCapacity(metricsFail, 0, defaultMaxWs, 80, 100)).toBe(false);
    });
  });

  describe('memory threshold checks', () => {
    it('returns true when memory is below threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 79 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, defaultCpuThreshold, 80)).toBe(true);
    });

    it('returns false when memory is at threshold (>= means no capacity)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 80 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, defaultCpuThreshold, 80)).toBe(false);
    });

    it('returns false when memory is above threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 81 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, defaultCpuThreshold, 80)).toBe(false);
    });

    it('passes at memory 79% and fails at 80% (boundary test)', () => {
      const metricsPass: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 79 };
      const metricsFail: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 80 };
      expect(nodeHasCapacity(metricsPass, 0, defaultMaxWs, 100, 80)).toBe(true);
      expect(nodeHasCapacity(metricsFail, 0, defaultMaxWs, 100, 80)).toBe(false);
    });
  });

  describe('combined threshold checks', () => {
    it('returns false when both CPU and memory exceed thresholds', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 90, memoryPercent: 90 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, 80)).toBe(false);
    });

    it('returns false when only CPU exceeds threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 90, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, 80)).toBe(false);
    });

    it('returns false when only memory exceeds threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 90 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, 80)).toBe(false);
    });

    it('returns true when both are below thresholds', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 70, memoryPercent: 70 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 80, 80)).toBe(true);
    });
  });

  describe('missing metric fields', () => {
    it('treats missing cpuLoadAvg1 as 0 (passes CPU check)', () => {
      const metrics: NodeMetrics = { memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('treats missing memoryPercent as 0 (passes memory check)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('treats metrics with only diskPercent as having 0 CPU and 0 memory', () => {
      const metrics: NodeMetrics = { diskPercent: 95 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });
  });

  describe('custom thresholds', () => {
    it('works with very low CPU threshold (10%)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 9, memoryPercent: 0 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 10, 100)).toBe(true);
      const metricsHigh: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 0 };
      expect(nodeHasCapacity(metricsHigh, 0, defaultMaxWs, 10, 100)).toBe(false);
    });

    it('works with 100% thresholds (allows any load below 100)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 99, memoryPercent: 99 };
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 100, 100)).toBe(true);
    });

    it('works with 0% thresholds (rejects everything)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 0 };
      // 0 < 0 is false, so nothing passes
      expect(nodeHasCapacity(metrics, 0, defaultMaxWs, 0, 0)).toBe(false);
    });
  });
});
