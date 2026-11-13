import type { ArtifactsBackendPort } from '@simple-agent-manager/repo-hosting/ports';

import type { Env } from '../env';
import {
  artifactsRemoteFetch,
  isLocalHostedGitActive,
  resolveArtifactsBackend,
} from '../services/hosted-git/backend';

/**
 * Repo hosting resolves the SAM-native repository backend through the worker's hosted-git
 * module: the Cloudflare Artifacts binding when present, otherwise SAM's own git server when
 * the self-host deploy configured it. A Cloudflare deployment always gets its binding.
 */
export const artifactsPort: ArtifactsBackendPort = {
  resolve: (env) => resolveArtifactsBackend(env as Env),
  // SAM-hosted repositories are read in-process, not through the public ingress.
  localRemoteFetch: (env) =>
    isLocalHostedGitActive(env as Env) ? artifactsRemoteFetch(env as Env) : null,
};
