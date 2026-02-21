import { describe, expect, it } from 'vitest';
import { scoreNodeLoad, nodeHasCapacity } from '../../../src/services/node-selector';
import type { NodeMetrics } from '@simple-agent-manager/shared';

describe('node-selector', () => {
  describe('scoreNodeLoad', () => {
    it('returns null for null metrics', () => {
      expect(scoreNodeLoad(null)).toBeNull();
    });

    it('returns 0 for fully idle node', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 0 };
      expect(scoreNodeLoad(metrics)).toBe(0);
    });

    it('returns 100 for fully loaded node', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 100, memoryPercent: 100 };
      expect(scoreNodeLoad(metrics)).toBe(100);
    });

    it('weights memory higher than CPU (60/40 split)', () => {
      const cpuHeavy: NodeMetrics = { cpuLoadAvg1: 80, memoryPercent: 20 };
      const memHeavy: NodeMetrics = { cpuLoadAvg1: 20, memoryPercent: 80 };

      const cpuScore = scoreNodeLoad(cpuHeavy)!;
      const memScore = scoreNodeLoad(memHeavy)!;

      // CPU heavy: 80*0.4 + 20*0.6 = 32 + 12 = 44
      expect(cpuScore).toBe(44);
      // Memory heavy: 20*0.4 + 80*0.6 = 8 + 48 = 56
      expect(memScore).toBe(56);
      // Memory-heavy node should score higher (more loaded)
      expect(memScore).toBeGreaterThan(cpuScore);
    });

    it('handles partial metrics (CPU only)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50 };
      const score = scoreNodeLoad(metrics)!;
      // 50*0.4 + 0*0.6 = 20
      expect(score).toBe(20);
    });

    it('handles partial metrics (memory only)', () => {
      const metrics: NodeMetrics = { memoryPercent: 50 };
      const score = scoreNodeLoad(metrics)!;
      // 0*0.4 + 50*0.6 = 30
      expect(score).toBe(30);
    });

    it('handles disk-only metrics (no CPU or memory)', () => {
      const metrics: NodeMetrics = { diskPercent: 90 };
      const score = scoreNodeLoad(metrics)!;
      // 0*0.4 + 0*0.6 = 0 (disk not used in scoring)
      expect(score).toBe(0);
    });
  });

  describe('nodeHasCapacity', () => {
    const cpuThreshold = 80;
    const memoryThreshold = 80;
    const maxWorkspaces = 5;

    it('returns true for idle node with no workspaces', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 20 };
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(true);
    });

    it('returns false when workspace limit reached', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 20 };
      expect(nodeHasCapacity(metrics, 5, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('returns false when workspace limit exceeded', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 20 };
      expect(nodeHasCapacity(metrics, 10, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('returns false when CPU exceeds threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 85, memoryPercent: 20 };
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('returns false when memory exceeds threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 85 };
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('returns false when both CPU and memory exceed threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 90, memoryPercent: 90 };
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('returns true when resources are exactly at threshold', () => {
      // At threshold but not exceeding
      const metrics: NodeMetrics = { cpuLoadAvg1: 79.9, memoryPercent: 79.9 };
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(true);
    });

    it('returns false when CPU equals threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 80, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('returns true when metrics are null (allows by workspace count only)', () => {
      expect(nodeHasCapacity(null, 0, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(true);
    });

    it('returns false when metrics are null but workspace limit reached', () => {
      expect(nodeHasCapacity(null, 5, maxWorkspaces, cpuThreshold, memoryThreshold)).toBe(false);
    });

    it('respects custom thresholds', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 50 };
      // With threshold of 40, 50% usage should be rejected
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, 40, 40)).toBe(false);
      // With threshold of 60, 50% usage should be accepted
      expect(nodeHasCapacity(metrics, 0, maxWorkspaces, 60, 60)).toBe(true);
    });
  });
});
