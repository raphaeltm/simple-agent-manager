import type { ArtifactsBackendPort } from '@simple-agent-manager/repo-hosting/ports';

import type { Env } from '../env';
import { resolveArtifactsBackend } from '../services/hosted-git/backend';
import { artifactsRemoteFetch, isLocalHostedGitActive } from '../services/hosted-git/local-backend';

/**
 * Repo hosting resolves the SAM-native repository backend through the worker's hosted-git seam:
 * the Cloudflare Artifacts binding, or the backend a self-host build registered. The package hands
 * over its narrow env; the full worker env is what reached it.
 */
export const artifactsPort: ArtifactsBackendPort = {
  resolve: (env) => resolveArtifactsBackend(env as Env),
  // SAM-hosted repositories (self-host only) are read in-process, not through the public ingress.
  localRemoteFetch: (env) =>
    isLocalHostedGitActive(env as Env) ? artifactsRemoteFetch(env as Env) : null,
};
