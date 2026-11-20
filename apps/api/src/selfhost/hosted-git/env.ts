import type { Env } from '../../env';

/** celld-only bindings; Cloudflare never configures these. */
export interface HostedGitEnv extends Env {
  HOSTED_GIT?: DurableObjectNamespace;
  HOSTED_GIT_BACKEND?: string;
}
