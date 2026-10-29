/**
 * Account mutations, each routed through the endpoint that already owns that
 * operation so the legacy `credentials` table and the cc_* tables stay in sync:
 *
 * - Disconnect a default / remove a project pin → the legacy delete routes,
 *   which also detach the cc_* attachments (`disconnect*FromCC`). A disconnected
 *   default that no project uses then has its cc_* records removed too, so it
 *   does not linger as an "Unattached" account.
 * - Rename → `PATCH /api/cc/credentials/:id` (the name is display-only).
 * - Remove an unattached account → delete its configuration first, then the
 *   credential if nothing else references it. Deleting the credential alone
 *   would leave a configuration with a NULL credential, which the resolver
 *   treats as a platform binding.
 *
 * Deleting a configuration cascades to every attachment, so the "nothing uses
 * it" check is re-read from the server right before the delete rather than
 * trusted from the cached view (another tab may have pinned a project since).
 */
import { useCallback } from 'react';

import { useInvalidateAccounts } from '../../hooks/useAccounts';
import { useToast } from '../../hooks/useToast';
import {
  ApiClientError,
  deleteAgentCredentialByKind,
  deleteCCAttachment,
  deleteCCConfiguration,
  deleteCCCredential,
  deleteCredential,
  deleteProjectAgentCredential,
  deleteProjectCloudCredential,
  listAgentCredentials,
  listCCAttachments,
  listCCConfigurations,
  listCCCredentials,
  updateCCCredential,
} from '../../lib/api';
import type { AccountView } from './account-model';
import { legacyAgentKind } from './provider-meta';

/** Whether the legacy routes can disconnect or unpin this account. */
export function canUseLegacyRoutes(account: AccountView): boolean {
  return account.kind === 'compute' || legacyAgentKind(account.credentialKind) !== null;
}

/** An account a project still uses, discovered only at delete time. */
class AccountInUseError extends Error {
  constructor() {
    super('A project started using this account. Refresh and try again.');
  }
}

/**
 * Delete an account's configuration, then its credential once nothing
 * references it. Refuses when any attachment still points at the
 * configuration, because the delete would silently cascade it away.
 */
async function deleteAccountRecords(account: AccountView): Promise<void> {
  const attachments = await listCCAttachments();
  if (attachments.some((att) => att.configurationId === account.configurationId)) {
    throw new AccountInUseError();
  }
  await deleteCCConfiguration(account.configurationId);
  const remaining = await listCCConfigurations();
  if (!remaining.some((cfg) => cfg.credentialId === account.credentialId)) {
    await deleteCCCredential(account.credentialId);
  }
}

/**
 * The legacy route can promote another saved key of the same agent when the
 * active one goes. A removed account must not come back that way, so its
 * inactive legacy copy goes too. An active copy is the current default's
 * source and is never touched from here.
 *
 * That route also detaches every default of the same credential kind
 * (`disconnectAgentCredentialFromCC`), so it is skipped when the current
 * default shares the kind.
 */
async function deleteInactiveLegacyCopy(account: AccountView): Promise<void> {
  const kind = legacyAgentKind(account.credentialKind);
  if (account.kind !== 'agent' || !kind) return;
  const [{ credentials }, attachments, configurations, ccCredentials] = await Promise.all([
    listAgentCredentials(),
    listCCAttachments(),
    listCCConfigurations(),
    listCCCredentials(),
  ]);
  const legacy = credentials.find(
    (cred) => cred.agentType === account.target && cred.credentialKind === kind
  );
  if (!legacy || legacy.isActive) return;
  const defaultSharesKind = attachments.some((att) => {
    if (att.projectId !== null || att.consumerTarget !== account.target) return false;
    const cfg = configurations.find((candidate) => candidate.id === att.configurationId);
    const cred = ccCredentials.find((candidate) => candidate.id === cfg?.credentialId);
    return cred !== undefined && legacyAgentKind(cred.kind) === kind;
  });
  if (!defaultSharesKind) await deleteAgentCredentialByKind(account.target, kind);
}

/** Detach a cloud default that only exists in cc_* (there is no legacy row to delete). */
async function detachCloudDefault(account: AccountView): Promise<void> {
  const attachments = await listCCAttachments();
  for (const att of attachments) {
    if (att.configurationId === account.configurationId && att.projectId === null) {
      await deleteCCAttachment(att.id);
    }
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
            try {
              await deleteCredential(account.target);
            } catch (err) {
              if (!(err instanceof ApiClientError && err.status === 404)) throw err;
              await detachCloudDefault(account);
            }
          } else {
            const kind = legacyAgentKind(account.credentialKind);
            if (!kind) throw new Error('This account can only be removed from Advanced settings.');
            await deleteAgentCredentialByKind(account.target, kind);
          }
          // The default is already disconnected; tidying its records is best
          // effort and stops if a project turns out to use the account.
          try {
            await deleteAccountRecords(account);
          } catch (err) {
            if (!(err instanceof AccountInUseError)) throw err;
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
        async () => {
          await deleteAccountRecords(account);
          await deleteInactiveLegacyCopy(account);
        },
        `${account.label} removed`,
        'Failed to remove account'
      ),
    [run]
  );

  return { rename, disconnectDefault, removePin, removeUnattached };
}
