import { listCCAttachments, listCCConfigurations, listCCCredentials } from '../../lib/api';
import type { AccountKind } from './provider-meta';

/**
 * The account a connect just created. Every connect path saves through a legacy
 * route whose cc sync replaces the scope's attachment with one pointing at a
 * fresh credential, so the active attachment for (consumer, scope) is the new
 * account. Returns null when nothing is attached (for example, the person
 * disconnected from inside the provider form instead).
 */
export async function findConnectedAccount(
  kind: AccountKind,
  target: string,
  projectId?: string
): Promise<{ credentialId: string; name: string } | null> {
  const [attachments, configurations, credentials] = await Promise.all([
    listCCAttachments(),
    listCCConfigurations(),
    listCCCredentials(),
  ]);
  const attachment = attachments.find(
    (att) =>
      att.consumerKind === kind &&
      att.consumerTarget === target &&
      att.isActive &&
      att.projectId === (projectId ?? null)
  );
  const configuration = configurations.find((cfg) => cfg.id === attachment?.configurationId);
  const credential = credentials.find((cred) => cred.id === configuration?.credentialId);
  return credential ? { credentialId: credential.id, name: credential.name } : null;
}
