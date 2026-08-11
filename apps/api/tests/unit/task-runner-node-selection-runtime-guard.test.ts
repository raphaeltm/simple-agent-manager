import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { selectNodeWithExplanation } from '../../src/services/node-selector';

// Task-runner node reuse must never select cf-container (instant-session)
// nodes: the standalone vm-agent hosts exactly one lightweight workspace and
// rejects task-runner re-dispatch (no `lightweight` flag) with a 409 profile
// conflict. The canonical evaluator records this as a typed rejection on
// every reuse path, even if the row is present in the candidate query.

function makeDb() {
  const now = new Date().toISOString();
  const cfContainerNode = {
    id: 'instant-node',
    status: 'running',
    runtime: 'cf-container',
    vmSize: 'small',
    vmLocation: 'fsn1',
    healthStatus: 'healthy',
    lastHeartbeatAt: now,
    agentReadyAt: now,
    agentVersion: null,
    lastMetrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
    warmSince: now,
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === schema.nodes ? [cfContainerNode] : []),
      }),
    }),
  };
}

describe('TaskRunner runtime guards', () => {
  it('rejects cf-container nodes on both warm and capacity reuse paths', async () => {
    const result = await selectNodeWithExplanation(
      makeDb() as never,
      'user-1',
      { NODE_LIFECYCLE: {} as DurableObjectNamespace },
      { vmSize: 'small', vmLocation: 'fsn1', taskId: 'task-1' }
    );

    expect(result.node).toBeNull();
    expect(result.explanation.outcome).toBe('provisioned');
    expect(result.explanation.evaluatedNodes).toEqual([
      expect.objectContaining({
        path: 'warm',
        accepted: false,
        rejectionReasons: expect.arrayContaining(['wrong-runtime']),
      }),
      expect.objectContaining({
        path: 'capacity',
        accepted: false,
        rejectionReasons: expect.arrayContaining(['wrong-runtime']),
      }),
    ]);
  });
});
