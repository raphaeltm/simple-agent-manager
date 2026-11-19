import type { GcpTokenProvider, ProviderRequestContext } from '@simple-agent-manager/providers';
import type { CredentialSource, GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type { GcpAccessTokenOptions } from './gcp-sts';

/** Who a GCP token is minted for: the credential's owner and the SAM project it serves. */
export interface GcpTokenOwner {
  credentialSource: CredentialSource;
  userId: string;
  /** The SAM project the token acts for; null when the credential is not project-scoped. */
  projectId: string | null;
}

/**
 * The one way SAM mints GCP access tokens for a credential. Workload identity binds a project-scoped
 * credential to its SAM project (`assertion.project_id` in the provider's attribute condition), so
 * provisioning and catalog reads must derive the identity the same way or the exchange is refused.
 * A credential that is not project-scoped is bound to no SAM project and uses its GCP project id.
 */
export function createGcpTokenProvider(
  credential: GcpCredential,
  owner: GcpTokenOwner,
  env: Env,
  options: GcpAccessTokenOptions = {}
): GcpTokenProvider {
  const cacheUserId =
    owner.credentialSource === 'platform'
      ? `platform:${owner.userId}`
      : owner.credentialSource === 'project' && owner.projectId
        ? `project:${owner.projectId}:${owner.userId}`
        : owner.userId;
  const cacheProjectId = owner.projectId ?? credential.gcpProjectId;
  return async (context?: ProviderRequestContext) => {
    const { getGcpAccessToken } = await import('./gcp-sts');
    return options.scopes
      ? getGcpAccessToken(cacheUserId, cacheProjectId, credential, env, context, options)
      : getGcpAccessToken(cacheUserId, cacheProjectId, credential, env, context);
  };
}
