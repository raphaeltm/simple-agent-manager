import { describe, expect, it, vi } from 'vitest';
import {
  boundedLifecycleTimings,
  LIFECYCLE_PHASES,
  recordLifecycleTimings,
} from '../../../src/services/lifecycle-timings';
import { log } from '../../../src/lib/logger';

describe('bounded lifecycle summaries', () => {
  it('drops secrets, arbitrary labels, malformed numbers and duplicate phases', () => {
    const phases = boundedLifecycleTimings([
      { phase: 'home_upload', durationMs: 42, error: 'ghp_canary' },
      { phase: 'secret/path', durationMs: 5 },
      { phase: 'docker', durationMs: -1 },
      { phase: 'git_clone', durationMs: Infinity },
      { phase: 'home_upload', durationMs: 50 },
    ]);
    expect(phases).toEqual([{ phase: 'home_upload', durationMs: 50 }]);
    expect(boundedLifecycleTimings(undefined)).toEqual([]);
    expect(
      boundedLifecycleTimings(Array(1000).fill({ phase: 'docker', durationMs: 1 }))
    ).toHaveLength(1);
    expect(LIFECYCLE_PHASES.length).toBeLessThan(50);
  });
  it('emits only numeric summaries and trusted identity without persistence', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    recordLifecycleTimings('wake', [{ phase: 'home_restore', durationMs: 12, token: 'canary' }], {
      workspaceId: 'ws',
    });
    expect(info).toHaveBeenCalledWith('session_lifecycle.timings', {
      operation: 'wake',
      outcome: 'success',
      workspaceId: 'ws',
      phases: [{ phase: 'home_restore', durationMs: 12 }],
    });
    info.mockRestore();
  });
});
