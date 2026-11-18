import { describe, expect, it } from 'vitest';

import type { NodeLifecycleDecisionRow } from '../../../src/services/node-lifecycle-decisions';
import {
  type NodeLivenessFacts,
  nodeLivenessVerdict,
} from '../../../src/services/operations-node-liveness';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

function decision(
  overrides: Partial<NodeLifecycleDecisionRow> & Pick<NodeLifecycleDecisionRow, 'decision'>
): NodeLifecycleDecisionRow {
  return {
    id: `d-${overrides.decision}`,
    nodeId: 'node-1',
    source: 'node_lifecycle',
    reason: null,
    workspaceCount: 0,
    detail: null,
    createdAt: '2026-11-03T11:00:00.000Z',
    ...overrides,
  };
}

function facts(overrides: Partial<NodeLivenessFacts> = {}): NodeLivenessFacts {
  return {
    node: {
      id: 'node-1',
      userId: 'user-1',
      status: 'running',
      healthStatus: 'healthy',
      nodeClass: 'managed',
      nodeRole: 'workspace',
      runtime: 'vm',
      warmSince: null,
      lastHeartbeatAt: '2026-11-03T11:59:30.000Z',
      createdAt: '2026-11-03T08:00:00.000Z',
      cleanupBackoffUntil: null,
      cleanupBlockedSince: null,
      cleanupBlockedReason: null,
    },
    activeWorkspaceCount: 0,
    workspaceCountsByStatus: {},
    workspaces: [],
    lifecycle: null,
    decisions: [],
    ...overrides,
  };
}

describe('nodeLivenessVerdict', () => {
  it('a fresh heartbeat on an empty, non-warm node is not read as activity (rule 53)', () => {
    const result = nodeLivenessVerdict(
      facts({
        decisions: [
          decision({
            source: 'warm_handoff',
            decision: 'handoff_skipped',
            reason: 'no_teardown_provenance',
          }),
        ],
      }),
      NOW
    );
    expect(result.verdict).toContain('no active workspaces but not in the warm pool');
    expect(result.reasons.join(' ')).toContain('handoff_skipped (no_teardown_provenance)');
  });

  it('active workspaces keep the node alive even when heartbeats are stale', () => {
    const result = nodeLivenessVerdict(
      facts({
        node: {
          ...facts().node,
          lastHeartbeatAt: '2026-11-03T08:00:00.000Z',
          healthStatus: 'unhealthy',
        },
        activeWorkspaceCount: 2,
      }),
      NOW
    );
    expect(result.verdict).toBe('Kept alive by 2 active workspace(s).');
    expect(result.reasons[0]).toContain('health: unhealthy');
  });

  it('a warm node reports its teardown deadline, and overdue once it passes', () => {
    const warm = facts({
      lifecycle: {
        nodeId: 'node-1',
        status: 'warm',
        warmSince: '2026-11-03T11:30:00.000Z',
        claimedByTask: null,
      },
      decisions: [
        decision({
          decision: 'marked_warm',
          detail: { teardownDueAt: '2026-11-03T12:00:00.000Z', warmTimeoutMs: 1_800_000 },
        }),
      ],
    });
    expect(nodeLivenessVerdict(warm, NOW - 60_000).verdict).toContain(
      'kept for fast reuse until 2026-11-03T12:00:00.000Z'
    );
    expect(nodeLivenessVerdict(warm, NOW + 60_000).verdict).toContain('is overdue');
  });

  it('a claimed node names the claiming task', () => {
    const result = nodeLivenessVerdict(
      facts({
        lifecycle: {
          nodeId: 'node-1',
          status: 'active',
          warmSince: null,
          claimedByTask: 'task-9',
        },
      }),
      NOW
    );
    expect(result.verdict).toContain('task task-9');
  });

  it('a stopped node explains the last sweep decision, block and backoff', () => {
    const result = nodeLivenessVerdict(
      facts({
        node: {
          ...facts().node,
          status: 'stopped',
          cleanupBlockedSince: '2026-11-03T10:00:00.000Z',
          cleanupBlockedReason: 'unproven_workspace_deletion',
          cleanupBackoffUntil: '2026-11-03T12:05:00.000Z',
        },
        decisions: [
          decision({
            source: 'cleanup_sweep',
            decision: 'skipped',
            reason: 'unproven_workspace_deletion',
          }),
        ],
      }),
      NOW
    );
    expect(result.verdict).toContain('waiting for the cleanup sweep');
    expect(result.reasons).toEqual([
      expect.stringContaining('skipped (unproven_workspace_deletion)'),
      expect.stringContaining('blocked since 2026-11-03T10:00:00.000Z'),
      'The sweep retries after 2026-11-03T12:05:00.000Z.',
    ]);
  });

  it('user-owned, deployment and deleted nodes get their own verdicts', () => {
    expect(
      nodeLivenessVerdict(facts({ node: { ...facts().node, nodeClass: 'user-owned' } }), NOW)
        .verdict
    ).toContain('User-owned');
    expect(
      nodeLivenessVerdict(facts({ node: { ...facts().node, nodeRole: 'deployment' } }), NOW)
        .verdict
    ).toContain('deployment');
    expect(
      nodeLivenessVerdict(facts({ node: { ...facts().node, status: 'deleted' } }), NOW)
    ).toMatchObject({ alive: false, verdict: 'The node is deleted.' });
  });
});
