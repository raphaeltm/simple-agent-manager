/**
 * SAM's own git server as an Artifacts backend (self-host only).
 *
 * `backend.ts` is the seam: it selects the Cloudflare Artifacts binding, else the fallback a
 * self-host build registered. This module is that fallback: the four `Env.ARTIFACTS` methods SAM
 * calls, implemented against the `HostedGitRepo` Durable Object (`durable-objects/hosted-git-repo.ts`)
 * through the `HOSTED_GIT` namespace binding only. It never imports the class. The self-host build
 * registers it (`selfhost/hosted-git.ts`); only that build sets `HOSTED_GIT_BACKEND` and binds the
 * class (`scripts/selfhost/celld-config.ts`, `selfhost-durable-objects.ts`), so on Cloudflare
 * `isLocalHostedGitActive` is always false.
 */
import type { Env } from '../../env';
import type { ArtifactsBackend } from './backend';
import { handleHostedGitRequest, HOSTED_GIT_PATH_PREFIX } from './http';
import { clampHostedGitTokenTtl, type HostedGitScope, mintHostedGitToken } from './tokens';

type BackendEnv = Pick<
  Env,
  'ARTIFACTS' | 'ARTIFACTS_ENABLED' | 'HOSTED_GIT' | 'HOSTED_GIT_BACKEND' | 'BASE_DOMAIN'
> &
  Partial<Pick<Env, 'ENCRYPTION_KEY' | 'DATABASE'>>;

export function isHostedGitBackendConfigured(
  env: Pick<Env, 'HOSTED_GIT' | 'HOSTED_GIT_BACKEND'>
): boolean {
  return env.HOSTED_GIT_BACKEND?.trim() === 'durable-object' && !!env.HOSTED_GIT;
}

/** Base URL of hosted repositories; a repository's remote is `<base><name>.git`. */
export function hostedGitBaseUrl(env: Pick<Env, 'BASE_DOMAIN'>): string {
  return `https://api.${env.BASE_DOMAIN}${HOSTED_GIT_PATH_PREFIX}`;
}

export function hostedGitRemote(env: Pick<Env, 'BASE_DOMAIN'>, repo: string): string {
  return `${hostedGitBaseUrl(env)}${repo}.git`;
}

/** Host git clients use for hosted repositories (`api.<BASE_DOMAIN>`). */
export function hostedGitHost(env: Pick<Env, 'BASE_DOMAIN'>): string {
  return `api.${env.BASE_DOMAIN}`;
}

function repoStub(env: BackendEnv, name: string): DurableObjectStub {
  if (!env.HOSTED_GIT) throw new Error('HOSTED_GIT binding is missing');
  return env.HOSTED_GIT.get(env.HOSTED_GIT.idFromName(name));
}

function requireEncryptionKey(env: BackendEnv): Pick<Env, 'ENCRYPTION_KEY'> {
  if (!env.ENCRYPTION_KEY)
    throw new Error('ENCRYPTION_KEY is required for SAM-hosted repositories');
  return { ENCRYPTION_KEY: env.ENCRYPTION_KEY };
}

/** The local implementation of the four `Env.ARTIFACTS` methods SAM calls. */
export function createDurableObjectArtifactsBackend(env: BackendEnv): ArtifactsBackend {
  const keyEnv = () => requireEncryptionKey(env);
  return {
    async create(name, opts) {
      const defaultBranch = opts?.setDefaultBranch || 'main';
      const res = await repoStub(env, name).fetch('https://hosted-git/init', {
        method: 'PUT',
        body: JSON.stringify({ defaultBranch }),
      });
      if (!res.ok) throw new Error(`Hosted repository init failed: HTTP ${res.status}`);
      const { token } = await mintHostedGitToken(keyEnv(), { repo: name, scope: 'write' });
      return {
        id: name,
        name,
        remote: hostedGitRemote(env, name),
        token,
        default_branch: defaultBranch,
      };
    },
    async delete(name) {
      const res = await repoStub(env, name).fetch('https://hosted-git/', { method: 'DELETE' });
      return res.ok;
    },
    async get(name) {
      const res = await repoStub(env, name).fetch('https://hosted-git/info');
      const info = res.ok ? ((await res.json()) as { head?: string }) : {};
      const defaultBranch = (info.head ?? 'refs/heads/main').replace(/^refs\/heads\//, '');
      return {
        id: name,
        name,
        remote: hostedGitRemote(env, name),
        defaultBranch,
        async createToken(scope?: HostedGitScope, ttl?: number) {
          const minted = await mintHostedGitToken(keyEnv(), {
            repo: name,
            scope: scope ?? 'read',
            ttlSeconds: clampHostedGitTokenTtl(ttl),
          });
          return {
            id: name,
            plaintext: minted.token,
            scope: scope ?? 'read',
            expiresAt: minted.expiresAt,
          };
        },
      };
    },
  };
}

/**
 * The fallback the self-host build registers with `registerArtifactsBackendFallback`: SAM's own git
 * server when this install configured it, else none.
 */
export function localHostedGitBackendFallback(env: Env): ArtifactsBackend | null {
  return isHostedGitBackendConfigured(env) ? createDurableObjectArtifactsBackend(env) : null;
}

/** Whether this install serves SAM-native repositories from its own Durable Object git server. */
export function isLocalHostedGitActive(env: BackendEnv): boolean {
  return env.ARTIFACTS_ENABLED === 'true' && !env.ARTIFACTS && isHostedGitBackendConfigured(env);
}

/** Whether `remote` is a repository on this install's own git server. */
export function isHostedGitRemote(env: Pick<Env, 'BASE_DOMAIN'>, remote: string): boolean {
  return !!env.BASE_DOMAIN && remote.startsWith(hostedGitBaseUrl(env));
}

/**
 * A fetch for SAM's own calls to a repository remote (README seeding, browsing). Requests to the
 * hosted git server are served in-process through the same authenticated handler external git
 * clients reach, instead of leaving the Worker and coming back through the ingress (no hairpin
 * through Caddy, no egress-fence exception). Anything else uses the global fetch.
 */
export function artifactsRemoteFetch(env: BackendEnv): typeof fetch {
  // eslint-disable-next-line sam/no-unguarded-outbound-fetch -- SAM creates the repository remote URLs supplied by its Artifacts backend
  if (!isLocalHostedGitActive(env)) return fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    if (!isHostedGitRemote(env, request.url) || !env.DATABASE || !env.ENCRYPTION_KEY) {
      // eslint-disable-next-line sam/no-unguarded-outbound-fetch -- SAM creates the repository remote URLs supplied by its Artifacts backend
      return fetch(request);
    }
    const response = await handleHostedGitRequest(
      request,
      { DATABASE: env.DATABASE, ENCRYPTION_KEY: env.ENCRYPTION_KEY, HOSTED_GIT: env.HOSTED_GIT },
      { trustedInternalCaller: true }
    );
    return response ?? new Response('not found\n', { status: 404 });
  };
}
