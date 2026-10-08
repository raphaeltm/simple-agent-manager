import { describe, expect, it, vi } from 'vitest';

import { log } from '../../../src/lib/logger';
import {
  boundedLifecycleTimings,
  LIFECYCLE_PHASES,
  recordLifecycleTimings,
} from '../../../src/services/lifecycle-timings';

describe('bounded lifecycle summaries', () => {
  it('preserves every fixed phase through the real logger without exposing extra fields', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      recordLifecycleTimings(
        'workspace',
        LIFECYCLE_PHASES.map((phase) => ({
          phase,
          durationMs: 12,
          token: 'sam_pat_canary-secret',
        })),
        { workspaceId: 'ws' }
      );
      const serialized = output.mock.calls[0]?.[0] as string;
      const entry = JSON.parse(serialized);
      expect(entry.phases).toEqual(
        LIFECYCLE_PHASES.map((phase) => ({
          phase: phase === 'sam_env' ? 'platform_environment' : phase,
          durationMs: 12,
        }))
      );
      expect(serialized).not.toContain('canary');
      expect(serialized).not.toContain('[REDACTED]');
    } finally {
      output.mockRestore();
    }
  });
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
