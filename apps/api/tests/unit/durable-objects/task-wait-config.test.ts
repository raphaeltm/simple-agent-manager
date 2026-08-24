import { describe, expect, it } from 'vitest';

import { resolveTaskWaitConfig } from '../../../src/durable-objects/project-data/task-wait-config';

describe('task wait configuration', () => {
  it('uses bounded defaults', () => {
    expect(resolveTaskWaitConfig({})).toEqual({
      reconcileIntervalMs: 30_000,
      maxChildren: 20,
      maxActivePerProject: 100,
      maxDurationMs: 86_400_000,
      maxCandidatesPerAlarm: 10,
    });
  });

  it('rejects malformed configured limits', () => {
    expect(() => resolveTaskWaitConfig({ ORCHESTRATOR_WAIT_MAX_CHILDREN: '0' })).toThrow(
      'ORCHESTRATOR_WAIT_MAX_CHILDREN must be a positive safe integer'
    );
    expect(() =>
      resolveTaskWaitConfig({ ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS: 'invalid' })
    ).toThrow('ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS must be a positive safe integer');
    expect(() => resolveTaskWaitConfig({ ORCHESTRATOR_WAIT_MAX_CHILDREN: '91' })).toThrow(
      'ORCHESTRATOR_WAIT_MAX_CHILDREN must be at most 90'
    );
  });
});
