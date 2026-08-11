import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const selectorSource = readFileSync(
  resolve(process.cwd(), 'src/services/node-selector.ts'),
  'utf8'
);

describe('warm node selection contract', () => {
  it('uses the canonical evaluated-node list and NodeLifecycle claim', () => {
    expect(selectorSource).toContain("evaluatePlacementNode(node, request, 'warm'");
    expect(selectorSource).toContain('nodeLifecycle.tryClaim');
    expect(selectorSource).toContain('options.taskId');
    expect(selectorSource).toContain('env.NODE_LIFECYCLE');
  });

  it('tries another path after failed claims without silently accepting the lost node', () => {
    expect(selectorSource).toContain('for (const evaluation of warmEvaluations');
    expect(selectorSource).toContain('catch {');
    expect(selectorSource).toContain("'warm-claim-lost'");
    expect(selectorSource).toContain('warmExclusions');
  });

  it('retains the optional lifecycle binding contract', () => {
    expect(selectorSource).toContain('NODE_LIFECYCLE?: DurableObjectNamespace');
  });
});
