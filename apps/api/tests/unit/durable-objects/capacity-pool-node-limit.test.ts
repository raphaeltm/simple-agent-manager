import { describe, expect, it } from 'vitest';

import { shouldProvisionSpreadNodeForCount } from '../../../src/durable-objects/task-runner/capacity-pool-node-limit';

describe('capacity pool node limit', () => {
  it('spreads onto separate nodes until the explicit pool limit, then packs', () => {
    expect(shouldProvisionSpreadNodeForCount('spread', 0, 3)).toBe(true);
    expect(shouldProvisionSpreadNodeForCount('spread', 1, 3)).toBe(true);
    expect(shouldProvisionSpreadNodeForCount('spread', 2, 3)).toBe(true);
    expect(shouldProvisionSpreadNodeForCount('spread', 3, 3)).toBe(false);
    expect(shouldProvisionSpreadNodeForCount('spread', 4, 3)).toBe(false);
  });

  it.each(['pack', 'smallest-fit', 'balanced'])('%s does not force another node', (strategy) => {
    expect(shouldProvisionSpreadNodeForCount(strategy, 0, 3)).toBe(false);
  });
});
