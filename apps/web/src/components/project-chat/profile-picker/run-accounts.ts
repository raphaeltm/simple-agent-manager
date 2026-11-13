/**
 * The accounts a new chat can run on, for the account control beside To and the low-usage
 * nudge. A chat picks its account per run (`agentConfigurationId`), so one profile serves
 * every account instead of one profile per account.
 */
import { useMemo } from 'react';

import { useAccountsData } from '../../../hooks/useAccounts';
import { type ProfileUsage, profileUsage } from './usage';

export interface RunAccount {
  /** `cc_configurations.id`: what the chat sends as `agentConfigurationId`. */
  id: string;
  label: string;
  usage: ProfileUsage;
}

/**
 * The caller's active accounts for `agentType`, with their usage; null while they load.
 * Paused accounts are left out: the API refuses them (`validateRunAgentConfiguration`).
 */
export function useRunAccounts(agentType: string | null, enabled: boolean): RunAccount[] | null {
  const { model } = useAccountsData({ enabled: enabled && Boolean(agentType) });
  return useMemo(() => {
    if (!model || !agentType) return null;
    const group = model.agents.find((agent) => agent.provider.id === agentType);
    const now = Date.now();
    return (group?.accounts ?? [])
      .filter((account) => account.active)
      .map((account) => ({
        id: account.id,
        label: account.label,
        usage: profileUsage(
          { kind: 'account', accountId: account.id, label: account.label, usage: account.usage },
          now
        ),
      }));
  }, [model, agentType]);
}

/**
 * The account with the most room, other than `currentId`, to offer when the current one
 * is nearly or fully used. Room is what is left on the window that stops it first, so a
 * fresh 5h on a nearly spent week does not win. Accounts without a reading are not offered:
 * "it might have room" is not worth switching for.
 */
export function roomiestAccount(
  accounts: readonly RunAccount[] | null,
  currentId: string | null
): RunAccount | null {
  let best: RunAccount | null = null;
  for (const account of accounts ?? []) {
    if (account.id === currentId) continue;
    const { usage } = account;
    if (usage.urgent || usage.left === null || usage.state === 'out') continue;
    if (usage.state !== 'ok' && usage.state !== 'low') continue;
    if (!best || usage.left > (best.usage.left ?? 0)) best = account;
  }
  return best;
}
