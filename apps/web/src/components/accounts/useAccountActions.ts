/**
 * Account mutations, each routed through the endpoint that already owns that
 * operation so the legacy `credentials` table and the cc_* tables stay in sync:
 *
 * - Pin an existing account to projects → `POST /api/cc/attachments` with a
 *   projectId, which replaces that project's previous pin in one batch. One
 *   account can be pinned to any number of projects.
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
  createCCAttachment,
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

/**
 * Whether an account can be pinned to projects from the account views: an
 * active, non-default agent account whose pins the legacy routes can remove.
 * Pinning a default changes nothing, and a paused account would halt the project.
 */
export function canPinToProjects(account: AccountView): boolean {
  return (
    account.kind === 'agent' &&
    account.role !== 'default' &&
    account.active &&
    canUseLegacyRoutes(account)
  );
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

/** Move one project off its pinned account, onto the default. */
async function unpinProject(account: AccountView, projectId: string): Promise<void> {
  if (account.kind === 'compute') {
    await deleteProjectCloudCredential(projectId, account.target);
    return;
  }
  const kind = legacyAgentKind(account.credentialKind);
  if (!kind) throw new Error('This pin can only be removed from Advanced settings.');
  await deleteProjectAgentCredential(projectId, account.target, kind);
}

/** Projects to pin to an account, and projects to move back to the default. */
export interface ProjectPinChanges {
  pin: string[];
  unpin: string[];
}

export function describePinChanges(label: string, changes: ProjectPinChanges): string {
  const projects = (n: number) => `${n} project${n === 1 ? '' : 's'}`;
  const pinned = `${projects(changes.pin.length)} now ${changes.pin.length === 1 ? 'uses' : 'use'} ${label}`;
  const unpinned = `${projects(changes.unpin.length)} moved back to your default`;
  if (changes.unpin.length === 0) return pinned;
  if (changes.pin.length === 0) return unpinned;
  return `${pinned}; ${unpinned}`;
}

export interface AccountActions {
  rename: (account: AccountView, name: string) => Promise<boolean>;
  disconnectDefault: (account: AccountView) => Promise<boolean>;
  removePin: (account: AccountView, projectId: string) => Promise<boolean>;
  removeUnattached: (account: AccountView) => Promise<boolean>;
  updateProjectPins: (account: AccountView, changes: ProjectPinChanges) => Promise<boolean>;
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
        () => unpinProject(account, projectId),
        'The project now uses your default account',
        'Failed to remove the project account'
      ),
    [run]
  );

  const updateProjectPins = useCallback(
    (account: AccountView, changes: ProjectPinChanges) =>
      run(
        async () => {
          // One request per project: each pin replaces that project's previous
          // pin atomically on the server, so a failure part-way leaves every
          // project on exactly one account.
          for (const projectId of changes.pin) {
            await createCCAttachment({ configurationId: account.configurationId, projectId });
          }
          for (const projectId of changes.unpin) await unpinProject(account, projectId);
        },
        describePinChanges(account.label, changes),
        'Failed to update the projects using this account'
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

  return { rename, disconnectDefault, removePin, removeUnattached, updateProjectPins };
}
