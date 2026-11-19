/**
 * Which account each profile runs on, with that account's usage windows, for
 * the profile list. The account comes from the same resolution the profile
 * editor shows (`explainProfileAccount`: profile pin → project → my default →
 * SAM platform), and the usage is the `AccountView.usage` every account surface
 * reads, so the list cannot disagree with Settings.
 */
import type { AgentProfile, CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { useMemo } from 'react';

import { useAccountsData } from '../../hooks/useAccounts';
import { explainProfileAccount } from '../accounts/profile-account-resolution';

export type ProfileBudget =
  | {
      kind: 'account';
      /** The account's id (`cc_configurations.id`), the identity a run account is chosen by. */
      accountId?: string;
      label: string;
      usage: CredentialLimitCredentialSummary | null;
    }
  | { kind: 'platform' }
  | { kind: 'paused'; label: string | null }
  | { kind: 'none' };

/** Null while the account queries (and my profile pins) are still loading. */
export function useProfileBudgets(
  profiles: readonly Pick<AgentProfile, 'id' | 'agentType' | 'projectId'>[],
  /** `projectId`: the project the run happens in, for profiles not tied to one. */
  options?: { enabled?: boolean; projectId?: string }
): ReadonlyMap<string, ProfileBudget> | null {
  const { model, snapshot, profilePinsSettled } = useAccountsData({ enabled: options?.enabled });
  const runProjectId = options?.projectId;

  return useMemo(() => {
    // Until my pins load, a pinned profile would show my usual account by mistake.
    if (!model || !snapshot || !profilePinsSettled) return null;
    const budgets = new Map<string, ProfileBudget>();
    for (const profile of profiles) {
      const group = model.agents.find((agent) => agent.provider.id === profile.agentType);
      if (!group) {
        budgets.set(profile.id, { kind: 'none' });
        continue;
      }
      const { outcome } = explainProfileAccount(snapshot, group.accounts, {
        profileId: profile.id,
        agentType: profile.agentType,
        projectId: profile.projectId ?? runProjectId ?? null,
      });
      switch (outcome.kind) {
        case 'account':
          budgets.set(profile.id, {
            kind: 'account',
            accountId: outcome.account.id,
            label: outcome.account.label,
            usage: outcome.account.usage,
          });
          break;
        case 'halted':
          budgets.set(profile.id, { kind: 'paused', label: outcome.account?.label ?? null });
          break;
        default:
          budgets.set(profile.id, { kind: outcome.kind });
      }
    }
    return budgets;
  }, [model, snapshot, profilePinsSettled, profiles, runProjectId]);
}
