import type { AgentProfile } from '@simple-agent-manager/shared';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProfileBudget } from '../../../../src/components/agent-profiles/useProfileBudgets';

// Cached account rows from an earlier new-chat visit stay in the query cache after the
// view closes; the hook must not hand them to an off-screen picker.
const budgets = new Map<string, ProfileBudget>([['p1', { kind: 'platform' }]]);
const useProfileBudgets = vi.fn(() => budgets);
vi.mock('../../../../src/components/agent-profiles/useProfileBudgets', () => ({
  useProfileBudgets: (...args: unknown[]) => useProfileBudgets(...(args as [])),
}));

const { useProfileUsages } =
  await import('../../../../src/components/project-chat/profile-picker/usage');

const profiles = [{ id: 'p1', agentType: 'claude-code', projectId: 'proj' } as AgentProfile];

describe('useProfileUsages', () => {
  it('maps every profile while the picker is on screen', () => {
    const { result } = renderHook(() => useProfileUsages(profiles, true));
    expect(result.current?.get('p1')?.state).toBe('platform');
    expect(useProfileBudgets).toHaveBeenLastCalledWith(profiles, { enabled: true });
  });

  it('returns nothing when disabled, even with cached account rows', () => {
    const { result, rerender } = renderHook(({ enabled }) => useProfileUsages(profiles, enabled), {
      initialProps: { enabled: true },
    });
    expect(result.current).not.toBeNull();
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(useProfileBudgets).toHaveBeenLastCalledWith(profiles, { enabled: false });
  });
});
