/**
 * A profile shared across projects (projectId null) resolves in the project the chat
 * runs in: that project's pinned account wins over the default, through the real
 * account model and resolver.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  type AccountsSnapshot,
  buildAccountsModel,
} from '../../../../src/components/accounts/account-model';
import { accountRows, mergeRows } from '../accounts/fixtures';

const rows = mergeRows(
  accountRows({
    id: 'default',
    name: 'Default Max',
    kind: 'agent',
    target: 'claude-code',
    isDefault: true,
  }),
  accountRows({
    id: 'proj',
    name: 'Project Max',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-web'],
  })
);
const snapshot: AccountsSnapshot = {
  ...rows,
  profilePins: [],
  projects: [{ id: 'p-web', name: 'Web' }],
  resolution: [],
  limits: [],
};

vi.mock('../../../../src/hooks/useAccounts', () => ({
  useAccountsData: () => ({
    model: buildAccountsModel(snapshot),
    snapshot,
    profilePinsSettled: true,
  }),
}));

const { useProfileBudgets } =
  await import('../../../../src/components/agent-profiles/useProfileBudgets');

const shared = { id: 'shared', agentType: 'claude-code', projectId: null } as AgentProfile;
const owned = { id: 'owned', agentType: 'claude-code', projectId: 'p-web' } as AgentProfile;

function label(budgets: ReturnType<typeof useProfileBudgets>, id: string) {
  const budget = budgets?.get(id);
  return budget?.kind === 'account' ? budget.label : budget?.kind;
}

describe('useProfileBudgets in a project', () => {
  it('resolves a shared profile to the project the chat runs in', () => {
    const { result } = renderHook(() => useProfileBudgets([shared, owned], { projectId: 'p-web' }));
    expect(label(result.current, 'shared')).toBe('Project Max');
    expect(label(result.current, 'owned')).toBe('Project Max');
  });

  it('falls back to the default account without a project to run in', () => {
    const { result } = renderHook(() => useProfileBudgets([shared]));
    expect(label(result.current, 'shared')).toBe('Default Max');
  });
});
