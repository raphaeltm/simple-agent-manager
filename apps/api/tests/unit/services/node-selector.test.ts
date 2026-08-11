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
import type { NodeMetrics } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import * as nodeLifecycle from '../../../src/services/node-lifecycle';
import {
  nodeHasCapacity,
  scoreNodeLoad,
  selectNodeForTaskRun,
  selectNodeWithExplanation,
} from '../../../src/services/node-selector';

vi.mock('../../../src/services/node-lifecycle', () => ({
  tryClaim: vi.fn(),
}));

type MockNode = {
  id: string;
  userId: string;
  status: string;
  healthStatus: string;
  vmSize: string;
  vmLocation: string;
  lastMetrics: string | null;
  runtime: string;
  lastHeartbeatAt: string;
  agentReadyAt: string;
  agentVersion: string | null;
  warmSince: string | null;
};

function createMockDb({
  nodes,
  warmNodes = [],
  workspaceCount = 0,
  freshNodes,
  freshWorkspaceCount,
}: {
  nodes: MockNode[];
  warmNodes?: MockNode[];
  workspaceCount?: number;
  freshNodes?: MockNode[];
  freshWorkspaceCount?: number;
}) {
  let nodeReadCount = 0;
  let workspaceReadCount = 0;
  return {
    select(_selection?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === schema.workspaces) {
                const count =
                  workspaceReadCount++ > 0 && freshWorkspaceCount !== undefined
                    ? freshWorkspaceCount
                    : workspaceCount;
                return Promise.resolve(
                  Array.from({ length: count }, (_, index) => ({
                    id: `workspace-${index}`,
                    nodeId: (nodes[0] ?? warmNodes[0])?.id ?? null,
                  }))
                );
              }

              if (table === schema.nodes) {
                const initialNodes = nodes.length > 0 ? nodes : warmNodes;
                return Promise.resolve(
                  nodeReadCount++ > 0 && freshNodes !== undefined ? freshNodes : initialNodes
                );
              }

              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
}

function node(overrides: Partial<MockNode>): MockNode {
  return {
    id: 'node-default',
    userId: 'user-1',
    status: 'running',
    healthStatus: 'healthy',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    lastMetrics: JSON.stringify({ cpuLoadAvg1: 5, memoryPercent: 10 }),
    runtime: 'vm',
    lastHeartbeatAt: new Date().toISOString(),
    agentReadyAt: new Date().toISOString(),
    agentVersion: null,
    warmSince: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(nodeLifecycle.tryClaim).mockReset();
});

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

  describe('null metrics handling', () => {
    it('returns true when metrics are null (node may still be starting up)', () => {
      expect(nodeHasCapacity(null, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });
  });

  describe('CPU threshold checks', () => {
    it('returns true when CPU is below threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 79, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 80, defaultMemThreshold)).toBe(true);
    });

    it('returns false when CPU is at threshold (>= means no capacity)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 80, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 80, defaultMemThreshold)).toBe(false);
    });

    it('returns false when CPU is above threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 81, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 80, defaultMemThreshold)).toBe(false);
    });

    it('passes at CPU 79% and fails at 80% (boundary test)', () => {
      const metricsPass: NodeMetrics = { cpuLoadAvg1: 79, memoryPercent: 0 };
      const metricsFail: NodeMetrics = { cpuLoadAvg1: 80, memoryPercent: 0 };
      expect(nodeHasCapacity(metricsPass, 80, 100)).toBe(true);
      expect(nodeHasCapacity(metricsFail, 80, 100)).toBe(false);
    });
  });

  describe('memory threshold checks', () => {
    it('returns true when memory is below threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 79 };
      expect(nodeHasCapacity(metrics, defaultCpuThreshold, 80)).toBe(true);
    });

    it('returns false when memory is at threshold (>= means no capacity)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 80 };
      expect(nodeHasCapacity(metrics, defaultCpuThreshold, 80)).toBe(false);
    });

    it('returns false when memory is above threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 81 };
      expect(nodeHasCapacity(metrics, defaultCpuThreshold, 80)).toBe(false);
    });

    it('passes at memory 79% and fails at 80% (boundary test)', () => {
      const metricsPass: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 79 };
      const metricsFail: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 80 };
      expect(nodeHasCapacity(metricsPass, 100, 80)).toBe(true);
      expect(nodeHasCapacity(metricsFail, 100, 80)).toBe(false);
    });
  });

  describe('combined threshold checks', () => {
    it('returns false when both CPU and memory exceed thresholds', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 90, memoryPercent: 90 };
      expect(nodeHasCapacity(metrics, 80, 80)).toBe(false);
    });

    it('returns false when only CPU exceeds threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 90, memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, 80, 80)).toBe(false);
    });

    it('returns false when only memory exceeds threshold', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 90 };
      expect(nodeHasCapacity(metrics, 80, 80)).toBe(false);
    });

    it('returns true when both are below thresholds', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 70, memoryPercent: 70 };
      expect(nodeHasCapacity(metrics, 80, 80)).toBe(true);
    });
  });

  describe('missing metric fields', () => {
    it('treats missing cpuLoadAvg1 as 0 (passes CPU check)', () => {
      const metrics: NodeMetrics = { memoryPercent: 50 };
      expect(nodeHasCapacity(metrics, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('treats missing memoryPercent as 0 (passes memory check)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 50 };
      expect(nodeHasCapacity(metrics, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });

    it('treats metrics with only diskPercent as having 0 CPU and 0 memory', () => {
      const metrics: NodeMetrics = { diskPercent: 95 };
      expect(nodeHasCapacity(metrics, defaultCpuThreshold, defaultMemThreshold)).toBe(true);
    });
  });

  describe('custom thresholds', () => {
    it('works with very low CPU threshold (10%)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 9, memoryPercent: 0 };
      expect(nodeHasCapacity(metrics, 10, 100)).toBe(true);
      const metricsHigh: NodeMetrics = { cpuLoadAvg1: 10, memoryPercent: 0 };
      expect(nodeHasCapacity(metricsHigh, 10, 100)).toBe(false);
    });

    it('works with 100% thresholds (allows any load below 100)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 99, memoryPercent: 99 };
      expect(nodeHasCapacity(metrics, 100, 100)).toBe(true);
    });

    it('works with 0% thresholds (rejects everything)', () => {
      const metrics: NodeMetrics = { cpuLoadAvg1: 0, memoryPercent: 0 };
      // 0 < 0 is false, so nothing passes
      expect(nodeHasCapacity(metrics, 0, 0)).toBe(false);
    });
  });
});

// =============================================================================
// parseMetrics (internal, exercised via selectNodeForTaskRun's returned
// lastMetrics) — schema-validated parsing of the nodes.last_metrics column
// =============================================================================

describe('parseMetrics via selectNodeForTaskRun.lastMetrics', () => {
  it('treats a metrics object with a mistyped field as absent metrics, not NaN-poisoned', async () => {
    // Regression: the old guard only required *one* of the three fields to
    // be a number, then blindly cast the whole object. cpuLoadAvg1 here is a
    // string, which used to slip through and later produce
    // `"not-a-number" * 0.4` -> NaN in scoreNodeLoad's sort comparator.
    const db = createMockDb({
      nodes: [
        node({
          id: 'node-mistyped',
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 'not-a-number', memoryPercent: 50 }),
        }),
      ],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {});

    expect(selected?.id).toBe('node-mistyped');
    expect(selected?.lastMetrics).toBeNull();
  });

  it('treats metrics with no recognized numeric fields as absent (same as before)', async () => {
    const db = createMockDb({
      nodes: [node({ id: 'node-empty', lastMetrics: JSON.stringify({ foo: 'bar' }) })],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {});

    expect(selected?.id).toBe('node-empty');
    expect(selected?.lastMetrics).toBeNull();
  });

  it('treats a JSON array metrics column as absent (same as before)', async () => {
    const db = createMockDb({
      nodes: [node({ id: 'node-array', lastMetrics: JSON.stringify([1, 2, 3]) })],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {});

    expect(selected?.id).toBe('node-array');
    expect(selected?.lastMetrics).toBeNull();
  });

  it('treats invalid JSON as absent (same as before)', async () => {
    const db = createMockDb({
      nodes: [node({ id: 'node-badjson', lastMetrics: '{not valid json' })],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {});

    expect(selected?.id).toBe('node-badjson');
    expect(selected?.lastMetrics).toBeNull();
  });

  it('still parses well-formed metrics', async () => {
    const db = createMockDb({
      nodes: [
        node({
          id: 'node-good',
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 12.5, memoryPercent: 40 }),
        }),
      ],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {});

    expect(selected?.lastMetrics).toEqual({ cpuLoadAvg1: 12.5, memoryPercent: 40 });
  });
});

// =============================================================================
// selectNodeForTaskRun — VM size minimum behavior
// =============================================================================

describe('selectNodeForTaskRun VM size minimum behavior', () => {
  it('reuses a healthy compatible medium hel1 node with 2 of 5 workspaces and low load', async () => {
    const requiredVersion = '2'.repeat(40);
    const db = createMockDb({
      nodes: [
        node({
          id: '01KZR2JAP92AK3SKW951E4H21M',
          vmSize: 'medium',
          vmLocation: 'hel1',
          agentVersion: requiredVersion,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 3, memoryPercent: 18 }),
        }),
      ],
      workspaceCount: 2,
    });

    const result = await selectNodeWithExplanation(
      db as never,
      'user-1',
      { VM_AGENT_REQUIRED_VERSION: requiredVersion },
      {
        vmSize: 'medium',
        vmLocation: 'hel1',
        limits: { maxWorkspacesPerNode: 5 },
      }
    );

    expect(result.node?.id).toBe('01KZR2JAP92AK3SKW951E4H21M');
    expect(result.explanation).toMatchObject({
      outcome: 'reused',
      selectionPath: 'capacity',
      selectedNodeId: '01KZR2JAP92AK3SKW951E4H21M',
      evaluatedNodes: [
        {
          accepted: true,
          snapshot: { activeWorkspaceCount: 2, agentVersionCompatible: true },
        },
      ],
    });
  });

  it('rejects smaller regular nodes for larger requested sizes', async () => {
    const db = createMockDb({
      nodes: [
        node({ id: 'node-small', vmSize: 'small' }),
        node({ id: 'node-medium', vmSize: 'medium' }),
      ],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {}, undefined, 'large');

    expect(selected).toBeNull();
  });

  it('records and excludes a warm node after a concurrent claim loss', async () => {
    vi.mocked(nodeLifecycle.tryClaim).mockResolvedValue({ claimed: false } as never);
    const db = createMockDb({
      nodes: [node({ id: 'warm-lost', warmSince: new Date().toISOString() })],
    });

    const result = await selectNodeWithExplanation(
      db as never,
      'user-1',
      { NODE_LIFECYCLE: {} as DurableObjectNamespace },
      { vmSize: 'medium', vmLocation: 'fsn1', taskId: 'task-1' }
    );

    expect(result.node).toBeNull();
    expect(result.explanation.outcome).toBe('provisioned');
    expect(
      result.explanation.evaluatedNodes.filter((evaluation) =>
        evaluation.rejectionReasons.includes('warm-claim-lost')
      )
    ).toHaveLength(2);
  });

  it.each([
    ['status', { status: 'stopped' }, undefined, 'not-running'],
    ['heartbeat', { lastHeartbeatAt: new Date(0).toISOString() }, undefined, 'heartbeat-stale'],
    ['agent version', { agentVersion: 'b'.repeat(40) }, undefined, 'agent-version-mismatch'],
    ['workspace count', {}, 5, 'workspace-limit'],
  ] as const)(
    'does not consume the warm claim when the fresh %s check rejects the node',
    async (_change, freshOverrides, freshWorkspaceCount, expectedReason) => {
      const requiredVersion = 'a'.repeat(40);
      const initialNode = node({
        id: 'warm-changed',
        warmSince: new Date().toISOString(),
        agentVersion: requiredVersion,
      });
      const db = createMockDb({
        nodes: [initialNode],
        freshNodes: [node({ ...initialNode, ...freshOverrides })],
        freshWorkspaceCount,
      });

      const result = await selectNodeWithExplanation(
        db as never,
        'user-1',
        {
          VM_AGENT_REQUIRED_VERSION: requiredVersion,
          NODE_LIFECYCLE: {} as DurableObjectNamespace,
        },
        {
          vmSize: 'medium',
          vmLocation: 'fsn1',
          taskId: 'task-1',
          limits: { maxWorkspacesPerNode: 5 },
        }
      );

      expect(nodeLifecycle.tryClaim).not.toHaveBeenCalled();
      expect(result.node).toBeNull();
      expect(result.explanation.evaluatedNodes[0]?.rejectionReasons).toContain(expectedReason);
      expect(result.explanation.evaluatedNodes[0]?.rejectionReasons).not.toContain(
        'warm-claim-lost'
      );
    }
  );

  it('selects a compatible node over a lower-load incompatible node', async () => {
    const requiredVersion = 'a'.repeat(40);
    const db = createMockDb({
      nodes: [
        node({
          id: 'incompatible-idle',
          agentVersion: 'b'.repeat(40),
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 0, memoryPercent: 0 }),
        }),
        node({
          id: 'compatible-busier',
          agentVersion: requiredVersion,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 30, memoryPercent: 30 }),
        }),
      ],
    });

    const result = await selectNodeWithExplanation(
      db as never,
      'user-1',
      { VM_AGENT_REQUIRED_VERSION: requiredVersion },
      { vmSize: 'medium', vmLocation: 'fsn1' }
    );

    expect(result.node?.id).toBe('compatible-busier');
    expect(
      result.explanation.evaluatedNodes.find((evaluation) =>
        evaluation.rejectionReasons.includes('agent-version-mismatch')
      )?.rejectionReasons
    ).toContain('agent-version-mismatch');
    expect(JSON.stringify(result.explanation)).not.toContain('incompatible-idle');
    expect(result.explanation.evaluatedNodes[0]?.nodeId).toBe('candidate-1');
  });

  it('never persists a rejected request node ID or unsafe location canary', async () => {
    const canary = 'CANARY_SECRET\n'.repeat(20);
    const result = await selectNodeWithExplanation(
      createMockDb({ nodes: [] }) as never,
      'user-1',
      {},
      {
        vmSize: 'medium',
        vmLocation: canary,
        preferredNodeId: canary,
        preferredOnly: true,
      }
    );

    const serialized = JSON.stringify(result.explanation);
    expect(result.node).toBeNull();
    expect(result.explanation.summary).toBe('The preferred node was rejected.');
    expect(result.explanation.request.vmLocation).toBe('unknown');
    expect(result.explanation.evaluatedNodes[0]?.nodeId).toBe('candidate-1');
    expect(serialized).not.toContain('CANARY_SECRET');
  });

  it.each([
    ['capacity', undefined],
    ['trial', 'trial'],
  ] as const)(
    'keeps only the selected real node ID on the %s path',
    async (_path, selectionPath) => {
      const db = createMockDb({
        nodes: [
          node({ id: 'selected-node', lastMetrics: JSON.stringify({ cpuLoadAvg1: 1 }) }),
          node({ id: 'other-eligible-node', lastMetrics: JSON.stringify({ cpuLoadAvg1: 10 }) }),
        ],
      });

      const result = await selectNodeWithExplanation(
        db as never,
        'user-1',
        {},
        {
          vmSize: 'medium',
          vmLocation: 'fsn1',
          ...(selectionPath ? { selectionPath } : {}),
        }
      );

      expect(result.node?.id).toBe('selected-node');
      expect(result.explanation.selectedNodeId).toBe('selected-node');
      expect(JSON.stringify(result.explanation)).not.toContain('other-eligible-node');
      expect(result.explanation.evaluatedNodes.map((evaluation) => evaluation.nodeId)).toEqual([
        'selected-node',
        'candidate-1',
      ]);
    }
  );

  it('keeps only the claimed real node ID when several warm nodes qualify', async () => {
    vi.mocked(nodeLifecycle.tryClaim).mockResolvedValue({ claimed: true });
    const warmSince = new Date().toISOString();
    const db = createMockDb({
      nodes: [
        node({
          id: 'selected-warm-node',
          warmSince,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 1 }),
        }),
        node({
          id: 'other-eligible-warm-node',
          warmSince,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 10 }),
        }),
      ],
    });

    const result = await selectNodeWithExplanation(
      db as never,
      'user-1',
      { NODE_LIFECYCLE: {} as DurableObjectNamespace },
      { vmSize: 'medium', vmLocation: 'fsn1', taskId: 'task-1' }
    );

    expect(result.node?.id).toBe('selected-warm-node');
    expect(result.explanation.selectedNodeId).toBe('selected-warm-node');
    expect(JSON.stringify(result.explanation)).not.toContain('other-eligible-warm-node');
    expect(result.explanation.evaluatedNodes.map((evaluation) => evaluation.nodeId)).toEqual([
      'selected-warm-node',
      'candidate-1',
    ]);
  });

  it.each([
    ['preferred', { preferredNodeId: 'incompatible-node' }],
    [
      'manual',
      { preferredNodeId: 'incompatible-node', preferredOnly: true, selectionPath: 'manual' },
    ],
    ['trial', { selectionPath: 'trial' }],
  ] as const)('records exact incompatibility on the %s selection path', async (path, options) => {
    const requiredVersion = 'c'.repeat(40);
    const db = createMockDb({
      nodes: [node({ id: 'incompatible-node', agentVersion: 'd'.repeat(40) })],
    });

    const result = await selectNodeWithExplanation(
      db as never,
      'user-1',
      { VM_AGENT_REQUIRED_VERSION: requiredVersion },
      { vmSize: 'medium', vmLocation: 'hel1', ...options }
    );

    expect(result.node).toBeNull();
    expect(result.explanation.evaluatedNodes).toEqual([
      expect.objectContaining({
        path,
        accepted: false,
        rejectionReasons: expect.arrayContaining(['agent-version-mismatch']),
      }),
    ]);
  });

  it('records exact incompatibility on both warm and capacity evaluations', async () => {
    const requiredVersion = 'e'.repeat(40);
    const db = createMockDb({
      nodes: [
        node({
          id: 'incompatible-warm',
          agentVersion: 'f'.repeat(40),
          warmSince: new Date().toISOString(),
        }),
      ],
    });

    const result = await selectNodeWithExplanation(
      db as never,
      'user-1',
      {
        VM_AGENT_REQUIRED_VERSION: requiredVersion,
        NODE_LIFECYCLE: {} as DurableObjectNamespace,
      },
      { vmSize: 'medium', vmLocation: 'hel1', taskId: 'task-incompatible' }
    );

    expect(nodeLifecycle.tryClaim).not.toHaveBeenCalled();
    expect(result.explanation.evaluatedNodes).toEqual([
      expect.objectContaining({
        path: 'warm',
        rejectionReasons: expect.arrayContaining(['agent-version-mismatch']),
      }),
      expect.objectContaining({
        path: 'capacity',
        rejectionReasons: expect.arrayContaining(['agent-version-mismatch']),
      }),
    ]);
  });

  it('allows larger regular nodes to satisfy smaller requested sizes', async () => {
    const db = createMockDb({
      nodes: [
        node({
          id: 'node-large',
          vmSize: 'large',
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 20, memoryPercent: 20 }),
        }),
      ],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {}, undefined, 'small');

    expect(selected?.id).toBe('node-large');
    expect(selected?.vmSize).toBe('large');
  });

  it('prefers exact regular size matches over larger satisfying nodes', async () => {
    const db = createMockDb({
      nodes: [
        node({
          id: 'node-large',
          vmSize: 'large',
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
        }),
        node({
          id: 'node-medium',
          vmSize: 'medium',
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 30, memoryPercent: 30 }),
        }),
      ],
    });

    const selected = await selectNodeForTaskRun(db as never, 'user-1', {}, undefined, 'medium');

    expect(selected?.id).toBe('node-medium');
  });

  it('does not try to claim undersized warm nodes for larger requested sizes', async () => {
    vi.mocked(nodeLifecycle.tryClaim).mockResolvedValue({ claimed: true });
    const db = createMockDb({
      nodes: [],
      warmNodes: [
        node({ id: 'warm-small', vmSize: 'small', warmSince: new Date().toISOString() }),
        node({ id: 'warm-medium', vmSize: 'medium', warmSince: new Date().toISOString() }),
      ],
    });

    const selected = await selectNodeForTaskRun(
      db as never,
      'user-1',
      { NODE_LIFECYCLE: {} as DurableObjectNamespace },
      undefined,
      'large',
      'task-1'
    );

    expect(selected).toBeNull();
    expect(nodeLifecycle.tryClaim).not.toHaveBeenCalled();
  });

  it('claims a larger warm node for a smaller requested size', async () => {
    vi.mocked(nodeLifecycle.tryClaim).mockResolvedValue({ claimed: true });
    const db = createMockDb({
      nodes: [],
      warmNodes: [node({ id: 'warm-large', vmSize: 'large', warmSince: new Date().toISOString() })],
    });

    const selected = await selectNodeForTaskRun(
      db as never,
      'user-1',
      { NODE_LIFECYCLE: {} as DurableObjectNamespace },
      undefined,
      'small',
      'task-1'
    );

    expect(selected?.id).toBe('warm-large');
    expect(selected?.vmSize).toBe('large');
    expect(nodeLifecycle.tryClaim).toHaveBeenCalledWith(expect.any(Object), 'warm-large', 'task-1');
  });
});
