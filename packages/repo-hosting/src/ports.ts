/**
 * Ports: what repo hosting needs from other areas of the worker. The worker installs its
 * implementation once at module load (`apps/api/src/repo-hosting-wiring.ts`, which the entry
 * imports). Methods take the narrow env; the worker widens it at that one boundary.
 */
import type { Env, RepoHostingEnv } from './env';
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
}

/** Platform settings (D1 + env), resolved and cached by the worker's platform-config service. */
export interface PlatformConfigPort {
  githubApp(env: Env): Promise<GitHubAppConfig | null>;
  githubOAuth(env: Env): Promise<GitHubOAuthConfig | null>;
  gitlabOAuth(env: Env): Promise<GitLabOAuthConfig | null>;
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

export interface RepoHostingPorts {
  platformConfig: PlatformConfigPort;
  auth: AuthPort;
}

/** Held on `globalThis` so a module-registry reset cannot leave an unconfigured copy behind. */
const PORTS_KEY = Symbol.for('sam.repo-hosting.ports');

interface PortsHolder {
  [PORTS_KEY]?: Partial<RepoHostingPorts>;
}

function portsHolder(): Partial<RepoHostingPorts> {
  const holder = globalThis as PortsHolder;
  return (holder[PORTS_KEY] ??= {});
}

/** Install the worker's implementation. The worker entry calls this once at module load. */
export function configureRepoHostingPorts(ports: RepoHostingPorts): void {
  Object.assign(portsHolder(), ports);
}

/**
 * Install one port. Worker unit tests use this so a test whose mocks break one port's
 * module graph still gets the other port.
 */
export function configureRepoHostingPort<K extends keyof RepoHostingPorts>(
  name: K,
  port: RepoHostingPorts[K]
): void {
  portsHolder()[name] = port;
}

/** The configured ports; reading one the worker never installed throws, naming it. */
export function repoHostingPorts(): RepoHostingPorts {
  const ports = portsHolder();
  return {
    get platformConfig() {
      return requirePort(ports, 'platformConfig');
    },
    get auth() {
      return requirePort(ports, 'auth');
    },
  };
}

function requirePort<K extends keyof RepoHostingPorts>(
  ports: Partial<RepoHostingPorts>,
  name: K
): RepoHostingPorts[K] {
  const port = ports[name];
  if (!port) {
    throw new Error(
      `Repo hosting port "${name}" is not configured: call configureRepoHostingPorts() from the worker entry`
    );
  }
  return port;
}

export type { RepoHostingEnv };
