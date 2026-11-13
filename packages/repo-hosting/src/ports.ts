/**
 * Ports: what repo hosting needs from other areas of the worker. The worker installs its
 * implementation once at module load (`apps/api/src/repo-hosting-wiring.ts`, which the entry
 * imports). Methods take the narrow env; the worker widens it at that one boundary.
 */
import type { ArtifactsBinding, Env } from './env';
import type { UserAccessTokenResult } from './user-access-token';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  slug: string | null;
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface GitLabOAuthConfig {
  host: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * `integration.gitlab.allowPrivateNetwork`. A host on the private network is refused unless
   * this is on (gitlab-host-policy.ts); it is never inferred from the host itself.
   */
  allowPrivateNetwork: boolean;
}

/** Platform settings (D1 + env), resolved and cached by the worker's platform-config service. */
export interface PlatformConfigPort {
  githubApp(env: Env): Promise<GitHubAppConfig | null>;
  githubOAuth(env: Env): Promise<GitHubOAuthConfig | null>;
  gitlabOAuth(env: Env): Promise<GitLabOAuthConfig | null>;
  /** Admin setting `outbound.maxRedirects`: redirect hops a guarded outbound fetch may follow. */
  outboundMaxRedirects(env: Env): Promise<number>;
}

/** Better Auth owns OAuth token encryption and refresh; the worker constructs it. */
export interface AuthPort {
  /** The user's provider access token through Better Auth, or null when no account is linked. */
  getAccessToken(
    env: Env,
    headers: Headers | undefined,
    userId: string,
    providerId: 'github' | 'gitlab'
  ): Promise<(UserAccessTokenResult & { tokenType?: string | null }) | null>;
}

/**
 * The SAM-native repository backend (`ARTIFACTS`). On Cloudflare it is the Artifacts binding; on
 * a self-hosted install it can be SAM's own git server (the worker's `hosted-git/backend.ts`).
 */
export interface ArtifactsBackendPort {
  /** The backend this install uses for SAM-native repositories, or null when it has none. */
  resolve(env: Env): ArtifactsBinding | null;
  /**
   * A fetch that serves this install's own hosted repositories in-process, or null when
   * repositories are read over the network (Cloudflare Artifacts).
   */
  localRemoteFetch(env: Env): typeof fetch | null;
}

export interface RepoHostingPorts {
  platformConfig: PlatformConfigPort;
  auth: AuthPort;
  artifacts: ArtifactsBackendPort;
}

/**
 * Held on `globalThis` so a module-registry reset (`vi.resetModules()` in worker tests) cannot
 * leave an unconfigured copy behind.
 */
const PORTS_KEY = Symbol.for('sam.repo-hosting.ports');

interface PortsHolder {
  [PORTS_KEY]?: Registry;
}

interface Registry {
  installed: Partial<RepoHostingPorts>;
  /** Built once per registry: token and OAuth paths read a port on every call. */
  view: RepoHostingPorts;
}

function createRegistry(installed: Partial<RepoHostingPorts>): Registry {
  return {
    installed,
    view: {
      get platformConfig() {
        return requirePort(installed, 'platformConfig');
      },
      get auth() {
        return requirePort(installed, 'auth');
      },
      get artifacts() {
        return requirePort(installed, 'artifacts');
      },
    },
  };
}

function registry(): Registry {
  const holder = globalThis as PortsHolder;
  return (holder[PORTS_KEY] ??= createRegistry({}));
}

/** Install the worker's implementation, replacing any earlier one. The worker entry calls this once. */
export function configureRepoHostingPorts(ports: RepoHostingPorts): void {
  (globalThis as PortsHolder)[PORTS_KEY] = createRegistry({ ...ports });
}

/**
 * Install one port. Worker unit tests use this so a test whose mocks break one port's module
 * graph still gets the other port.
 */
export function configureRepoHostingPort<K extends keyof RepoHostingPorts>(
  name: K,
  port: RepoHostingPorts[K]
): void {
  registry().installed[name] = port;
}

/** The configured ports; reading one the worker never installed throws, naming it. */
export function repoHostingPorts(): RepoHostingPorts {
  return registry().view;
}

function requirePort<K extends keyof RepoHostingPorts>(
  installed: Partial<RepoHostingPorts>,
  name: K
): RepoHostingPorts[K] {
  const port = installed[name];
  if (!port) {
    throw new Error(
      `Repo hosting port "${name}" is not configured: call configureRepoHostingPorts() from the worker entry`
    );
  }
  return port;
}
