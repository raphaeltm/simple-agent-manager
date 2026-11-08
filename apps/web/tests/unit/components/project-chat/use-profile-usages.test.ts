import type { AgentProfile } from '@simple-agent-manager/shared';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProfileBudget } from '../../../../src/components/agent-profiles/useProfileBudgets';

// Cached account rows from an earlier new-chat visit stay in the query cache after the
// view closes; the hook must not hand them to an off-screen picker.
let budgets: ReadonlyMap<string, ProfileBudget> = new Map([['p1', { kind: 'platform' }]]);
const useProfileBudgets = vi.fn(() => budgets);
vi.mock('../../../../src/components/agent-profiles/useProfileBudgets', () => ({
  useProfileBudgets: (...args: unknown[]) => useProfileBudgets(...(args as [])),
}));

const { useProfileUsages } =
  await import('../../../../src/components/project-chat/profile-picker/usage');

const profiles = [{ id: 'p1', agentType: 'claude-code', projectId: 'proj' } as AgentProfile];

describe('useProfileUsages', () => {
  it('maps every profile while the picker is on screen', () => {
    const { result } = renderHook(() => useProfileUsages(profiles, 'proj', true));
    expect(result.current?.get('p1')?.state).toBe('platform');
    expect(useProfileBudgets).toHaveBeenLastCalledWith(profiles, {
      enabled: true,
      projectId: 'proj',
    });
  });

  it('returns nothing when disabled, even with cached account rows', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useProfileUsages(profiles, 'proj', enabled),
      {
        initialProps: { enabled: true },
      }
    );
    expect(result.current).not.toBeNull();
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(useProfileBudgets).toHaveBeenLastCalledWith(profiles, {
      enabled: false,
      projectId: 'proj',
    });
  });

  it('follows refreshed account rows, e.g. out until a poll shows the reset', () => {
    const now = Date.now();
    const account = (pct: number, level: 'ok' | 'rejected'): ProfileBudget => ({
      kind: 'account',
      label: 'Max',
      usage: {
        credentialReference: 'cc_credentials:max',
        credentialId: 'max',
        credentialName: 'Max',
        credentialSource: 'user',
        provider: 'anthropic',
        providerMode: 'direct',
        agentType: 'claude-code',
        level,
        observedAt: now,
        windows: [
          {
            windowType: 'claude.five_hour',
            provider: 'anthropic',
            source: 'test',
            status: level === 'ok' ? 'allowed' : 'rejected',
            level,
            utilizationPercent: pct,
            limitAmount: null,
            remainingAmount: null,
            windowMinutes: 300,
            resetsAt: now + 3_600_000,
            observedAt: now,
            updatedAt: now,
          },
        ],
      },
    });
    budgets = new Map([['p1', account(100, 'rejected')]]);
    const { result, rerender } = renderHook(() => useProfileUsages(profiles, 'proj', true));
    expect(result.current?.get('p1')).toMatchObject({ state: 'out', left: 0 });
    budgets = new Map([['p1', account(4, 'ok')]]);
    rerender();
    expect(result.current?.get('p1')).toMatchObject({ state: 'ok', left: 96 });
  });
});
