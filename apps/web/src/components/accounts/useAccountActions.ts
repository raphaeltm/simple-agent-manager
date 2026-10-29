/**
 * Account mutations, each routed through the endpoint that already owns that
 * operation so the legacy `credentials` table and the cc_* tables stay in sync:
 *
 * - Disconnect a default / remove a project pin → the legacy delete routes,
 *   which also detach the cc_* attachments (`disconnect*FromCC`). A disconnected
 *   default with no project pins then has its cc_* records removed too, so it
 *   does not linger as an "Unattached" account.
 * - Rename → `PATCH /api/cc/credentials/:id` (the name is display-only).
 * - Remove an unattached account → delete its configuration first (cascading any
 *   inert attachments), then the credential if nothing else references it.
 *   Deleting the credential alone would leave a configuration with a NULL
 *   credential, which the resolver treats as a platform binding.
 */
import { useCallback } from 'react';

import { useInvalidateAccounts } from '../../hooks/useAccounts';
import { useToast } from '../../hooks/useToast';
import {
  deleteAgentCredentialByKind,
  deleteCCConfiguration,
  deleteCCCredential,
  deleteCredential,
  deleteProjectAgentCredential,
  deleteProjectCloudCredential,
  listCCConfigurations,
  updateCCCredential,
} from '../../lib/api';
import type { AccountView } from './account-model';

/** The legacy credential kind an agent account was saved under, when it has one. */
export function legacyAgentKind(credentialKind: string): 'api-key' | 'oauth-token' | null {
  if (credentialKind === 'api-key') return 'api-key';
  if (credentialKind === 'oauth-token' || credentialKind === 'auth-json') return 'oauth-token';
  return null;
}

/** Whether the legacy routes can disconnect or unpin this account. */
export function canUseLegacyRoutes(account: AccountView): boolean {
  return account.kind === 'compute' || legacyAgentKind(account.credentialKind) !== null;
}

/** Delete an account's configuration, then its credential once nothing references it. */
async function deleteAccountRecords(account: AccountView): Promise<void> {
  await deleteCCConfiguration(account.configurationId);
  const remaining = await listCCConfigurations();
  if (!remaining.some((cfg) => cfg.credentialId === account.credentialId)) {
    await deleteCCCredential(account.credentialId);
  }
}

export interface AccountActions {
  rename: (account: AccountView, name: string) => Promise<boolean>;
  disconnectDefault: (account: AccountView) => Promise<boolean>;
  removePin: (account: AccountView, projectId: string) => Promise<boolean>;
  removeUnattached: (account: AccountView) => Promise<boolean>;
}

export function useAccountActions(): AccountActions {
  const toast = useToast();
  const invalidate = useInvalidateAccounts();

  const run = useCallback(
    async (work: () => Promise<unknown>, success: string, failure: string) => {
      try {
        await work();
        toast.success(success);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : failure);
        return false;
      } finally {
        await invalidate();
      }
    },
    [toast, invalidate]
  );

  const rename = useCallback(
    (account: AccountView, name: string) =>
      run(
        () => updateCCCredential(account.credentialId, { name: name.trim() }),
        `Renamed to ${name.trim()}`,
        'Failed to rename account'
      ),
    [run]
  );

  const disconnectDefault = useCallback(
    (account: AccountView) =>
      run(
        async () => {
          if (account.kind === 'compute') {
            await deleteCredential(account.target);
          } else {
            const kind = legacyAgentKind(account.credentialKind);
            if (!kind) throw new Error('This account can only be removed from Advanced settings.');
            await deleteAgentCredentialByKind(account.target, kind);
          }
          // Deleting the configuration would cascade to project pins, so an
          // account that projects still pin keeps its records.
          if (account.pinnedProjectIds.length === 0 && account.pausedProjectIds.length === 0) {
            await deleteAccountRecords(account);
          }
        },
        `${account.label} disconnected`,
        'Failed to disconnect account'
      ),
    [run]
  );

  const removePin = useCallback(
    (account: AccountView, projectId: string) =>
      run(
        () => {
          if (account.kind === 'compute') {
            return deleteProjectCloudCredential(projectId, account.target);
          }
          const kind = legacyAgentKind(account.credentialKind);
          if (!kind) throw new Error('This pin can only be removed from Advanced settings.');
          return deleteProjectAgentCredential(projectId, account.target, kind);
        },
        'The project now uses your default account',
        'Failed to remove the project account'
      ),
    [run]
  );

  const removeUnattached = useCallback(
    (account: AccountView) =>
      run(
        () => deleteAccountRecords(account),
        `${account.label} removed`,
        'Failed to remove account'
      ),
    [run]
  );

  return { rename, disconnectDefault, removePin, removeUnattached };
}
