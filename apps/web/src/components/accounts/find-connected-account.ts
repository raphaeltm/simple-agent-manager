import type {
  CCAttachmentListItem,
  CCConfigurationListItem,
  CCCredentialListItem,
} from '../../lib/api';
import type { AccountKind } from './provider-meta';

export interface AccountRowLists {
  attachments: CCAttachmentListItem[];
  configurations: CCConfigurationListItem[];
  credentials: CCCredentialListItem[];
}

/**
 * The account a connect just created. Every connect path saves through a legacy
 * route whose cc sync replaces the scope's attachment with one pointing at a
 * fresh credential, so the newest active attachment for (consumer, scope) is
 * the new account. Returns null when nothing is attached (for example, the
 * person disconnected from inside the provider form instead).
 */
export function findConnectedAccount(
  lists: AccountRowLists,
  kind: AccountKind,
  target: string,
  projectId?: string
): { credentialId: string; name: string } | null {
  const attachment = lists.attachments
    .filter(
      (att) =>
        att.consumerKind === kind &&
        att.consumerTarget === target &&
        att.isActive &&
        att.projectId === (projectId ?? null)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const configuration = lists.configurations.find((cfg) => cfg.id === attachment?.configurationId);
  const credential = lists.credentials.find((cred) => cred.id === configuration?.credentialId);
  return credential ? { credentialId: credential.id, name: credential.name } : null;
}
