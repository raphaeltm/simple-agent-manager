import type { GcpTokenProvider, ProviderRequestContext } from '@simple-agent-manager/providers';
import type { CredentialSource, GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type { GcpAccessTokenOptions, GcpTokenRequester } from './gcp-sts';

/** Who a GCP token is minted for: the credential's owner and the SAM project it serves. */
export interface GcpTokenOwner {
  credentialSource: CredentialSource;
  userId: string;
  /** The SAM project the token acts for; null when the credential is not project-scoped. */
  projectId: string | null;
  /**
   * The user who stored the credential, when it differs from `userId`: a project-scoped
   * credential one member saved and another member's run uses. Defaults to `userId`.
   * Ignored for platform credentials, which the installation owns.
   */
  credentialOwnerUserId?: string;
}

/** The token identity and pool owner for a credential resolved for `owner`. */
export function gcpTokenRequester(owner: GcpTokenOwner): GcpTokenRequester {
  const cacheUserId =
    owner.credentialSource === 'platform'
      ? `platform:${owner.userId}`
      : owner.credentialSource === 'project' && owner.projectId
        ? `project:${owner.projectId}:${owner.userId}`
        : owner.userId;
  return {
    cacheUserId,
    poolOwner:
      owner.credentialSource === 'platform'
        ? { kind: 'platform' }
        : { kind: 'user', userId: owner.credentialOwnerUserId ?? owner.userId },
  };
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
  const requester = gcpTokenRequester(owner);
  const cacheProjectId = owner.projectId ?? credential.gcpProjectId;
  return async (context?: ProviderRequestContext) => {
    const { getGcpAccessToken } = await import('./gcp-sts');
    return options.scopes
      ? getGcpAccessToken(requester, cacheProjectId, credential, env, context, options)
      : getGcpAccessToken(requester, cacheProjectId, credential, env, context);
  };
}
