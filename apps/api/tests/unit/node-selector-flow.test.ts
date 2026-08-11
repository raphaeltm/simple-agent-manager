import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { nodeHasCapacity, scoreNodeLoad } from '../../src/services/node-selector';

const selectorSource = readFileSync(
  resolve(process.cwd(), 'src/services/node-selector.ts'),
  'utf8'
);
const evaluatorSource = readFileSync(
  resolve(process.cwd(), 'src/services/placement-explanation.ts'),
  'utf8'
);
const taskRunnerSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner/node-steps.ts'),
  'utf8'
);

describe('canonical node selector flow', () => {
  it('keeps the weighted load helpers stable', () => {
    expect(scoreNodeLoad({ cpuLoadAvg1: 25, memoryPercent: 50 })).toBe(40);
    expect(nodeHasCapacity({ cpuLoadAvg1: 49, memoryPercent: 49 }, 50, 50)).toBe(true);
    expect(nodeHasCapacity({ cpuLoadAvg1: 50, memoryPercent: 10 }, 50, 50)).toBe(false);
  });

  it('uses shared scaling defaults', () => {
    expect(DEFAULT_MAX_WORKSPACES_PER_NODE).toBe(3);
    expect(DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT).toBe(50);
    expect(DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT).toBe(50);
    expect(evaluatorSource).toContain('DEFAULT_MAX_WORKSPACES_PER_NODE');
  });

  it('centralizes TaskRunner selection and persists the explanation immediately', () => {
    expect(taskRunnerSource).toContain('selectNodeWithExplanation(');
    expect(taskRunnerSource).toContain('persistTaskPlacement(state, rc, placement.explanation)');
    expect(taskRunnerSource).not.toContain('findNodeWithCapacity');
    expect(taskRunnerSource).not.toContain('tryClaimWarmNode');
  });

  it('evaluates preferred, warm, and capacity paths in the shared selector', () => {
    expect(selectorSource).toContain("evaluatePlacementNode(node, request, 'warm'");
    expect(selectorSource).toContain("'capacity'");
    expect(selectorSource).toContain('options.preferredNodeId');
  });

  it('records warm claim loss and prevents immediate capacity reuse', () => {
    expect(selectorSource).toContain("evaluation.rejectionReasons.push('warm-claim-lost')");
    expect(selectorSource).toContain('warmExclusions.get(evaluation.nodeId)');
  });
});
