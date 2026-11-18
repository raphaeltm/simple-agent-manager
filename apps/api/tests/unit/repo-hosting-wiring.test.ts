// The worker entry is the only production code that installs the repo-hosting ports
// (`src/repo-hosting-wiring.ts`). Test setup installs them too, so without this test a dropped
// install would leave every other test green while production throws on the first GitHub call.
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';

// The entry pulls in the container runtime packages, which import `cloudflare:` modules Node
// cannot load; the routing tests that load the entry stub them the same way.
vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
}));

const workerFns = vi.hoisted(() => ({
  getGitHubAppConfig: vi.fn(),
  getGitHubOAuthConfig: vi.fn(),
  getGitLabOAuthConfig: vi.fn(),
  getBetterAuthAccessTokenForProvider: vi.fn(),
}));

vi.mock('../../src/services/platform-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/platform-config')>()),
  getGitHubAppConfig: workerFns.getGitHubAppConfig,
  getGitHubOAuthConfig: workerFns.getGitHubOAuthConfig,
  getGitLabOAuthConfig: workerFns.getGitLabOAuthConfig,
}));
vi.mock('../../src/services/better-auth-access-token', () => ({
  getBetterAuthAccessTokenForProvider: workerFns.getBetterAuthAccessTokenForProvider,
}));

const PORTS_KEY = Symbol.for('sam.repo-hosting.ports');

describe('repo-hosting port wiring', () => {
  it('installs both worker ports when the worker entry loads, and they delegate to the worker', async () => {
    delete (globalThis as Record<symbol, unknown>)[PORTS_KEY];
    vi.resetModules();
    const { repoHostingPorts } = await import('@simple-agent-manager/repo-hosting/ports');
    // Liveness: the registry really is empty before the entry loads.
    expect(() => repoHostingPorts().platformConfig).toThrow(
      /port "platformConfig" is not configured/
    );
    expect(() => repoHostingPorts().auth).toThrow(/port "auth" is not configured/);

    await import('../../src/index');

    const { platformConfigPort } = await import('../../src/repo-hosting-ports/platform-config');
    const { authPort } = await import('../../src/repo-hosting-ports/auth');
    const installed = repoHostingPorts();
    expect(installed.platformConfig).toBe(platformConfigPort);
    expect(installed.auth).toBe(authPort);

    // Each port method reaches the worker service with the env and arguments it was given.
    const env = { KV: {} } as unknown as Env;
    const app = { appId: '1', privateKey: 'k', slug: 'sam' };
    const githubOAuth = { clientId: 'gh', clientSecret: 's' };
    const gitlabOAuth = {
      host: 'https://gitlab.example.com',
      apiBaseUrl: 'https://gitlab.example.com/api/v4',
      clientId: 'gl',
      clientSecret: 's',
    };
    const token = { accessToken: 'token', accessTokenExpiresAt: null };
    workerFns.getGitHubAppConfig.mockResolvedValue(app);
    workerFns.getGitHubOAuthConfig.mockResolvedValue(githubOAuth);
    workerFns.getGitLabOAuthConfig.mockResolvedValue(gitlabOAuth);
    workerFns.getBetterAuthAccessTokenForProvider.mockResolvedValue(token);

    await expect(installed.platformConfig.githubApp(env)).resolves.toBe(app);
    await expect(installed.platformConfig.githubOAuth(env)).resolves.toBe(githubOAuth);
    await expect(installed.platformConfig.gitlabOAuth(env)).resolves.toBe(gitlabOAuth);
    const headers = new Headers({ cookie: 'session=1' });
    await expect(installed.auth.getAccessToken(env, headers, 'user-1', 'gitlab')).resolves.toBe(
      token
    );

    expect(workerFns.getGitHubAppConfig).toHaveBeenCalledWith(env);
    expect(workerFns.getGitHubOAuthConfig).toHaveBeenCalledWith(env);
    expect(workerFns.getGitLabOAuthConfig).toHaveBeenCalledWith(env);
    expect(workerFns.getBetterAuthAccessTokenForProvider).toHaveBeenCalledWith(
      env,
      headers,
      'user-1',
      'gitlab'
    );
  }, 120_000);
});
