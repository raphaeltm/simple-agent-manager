/**
 * My account choice for one agent profile: the accounts I could run it on, the
 * explanation of which one runs now, and the setter. Shares the accounts queries
 * with every other account surface (TanStack Query dedupes them).
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { useCallback, useMemo, useState } from 'react';

import { useAccountsData } from '../../hooks/useAccounts';
import type { AccountView, ProviderAccounts } from './account-model';
import {
  explainProfileAccount,
  type ProfileAccountExplanation,
} from './profile-account-resolution';
import { useAccountActions } from './useAccountActions';

export interface ProfileAccountState {
  group: ProviderAccounts | null;
  explanation: ProfileAccountExplanation | null;
  isLoading: boolean;
  error: string | null;
  saving: boolean;
  /** Run the profile on `account`, or on my usual account when null. */
  choose: (account: AccountView | null) => Promise<void>;
}

export function useProfileAccount(
  profile: Pick<AgentProfile, 'id' | 'agentType' | 'projectId'> | null
): ProfileAccountState {
  const { model, snapshot, profilePinsSettled, isLoading, error } = useAccountsData();
  const actions = useAccountActions();
  const [saving, setSaving] = useState(false);

  const group = useMemo(
    () => model?.agents.find((candidate) => candidate.provider.id === profile?.agentType) ?? null,
    [model, profile?.agentType]
  );
  const explanation = useMemo(() => {
    // Until my pins load, "usual account" would be shown as the choice by mistake.
    if (!profile || !snapshot || !group || !profilePinsSettled) return null;
    return explainProfileAccount(snapshot, group.accounts, {
      profileId: profile.id,
      agentType: profile.agentType,
      projectId: profile.projectId,
    });
  }, [profile, snapshot, group, profilePinsSettled]);

  const currentPinId = explanation?.pin?.id ?? null;
  const profileId = profile?.id ?? null;
  const choose = useCallback(
    async (account: AccountView | null) => {
      if (!profileId) return;
      setSaving(true);
      await actions.setProfileAccount(profileId, account, currentPinId);
      setSaving(false);
    },
    [actions, profileId, currentPinId]
  );

  return {
    group,
    explanation,
    isLoading: isLoading || (snapshot !== null && !profilePinsSettled),
    error,
    saving,
    choose,
  };
}
