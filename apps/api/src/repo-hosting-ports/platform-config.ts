import type { PlatformConfigPort } from '@simple-agent-manager/repo-hosting/ports';

import type { Env } from '../env';
import {
  getGitHubAppConfig,
  getGitHubOAuthConfig,
  getGitLabOAuthConfig,
} from '../services/platform-config';
import { resolveOutboundMaxRedirects } from '../services/outbound-fetch-settings';

/**
 * Repo hosting reads GitHub App and OAuth settings through the worker's platform-config
 * service, which resolves D1 overrides over env and caches them per isolate. The package
 * hands over its narrow env; the full worker env is what reached it.
 */
export const platformConfigPort: PlatformConfigPort = {
  githubApp: (env) => getGitHubAppConfig(env as Env),
  githubOAuth: (env) => getGitHubOAuthConfig(env as Env),
  gitlabOAuth: (env) => getGitLabOAuthConfig(env as Env),
  outboundMaxRedirects: (env) => resolveOutboundMaxRedirects(env as Env),
};
