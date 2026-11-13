import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { verifyGitLabProjectAccess } from '../../src/gitlab';
import { configureRepoHostingPort } from '../../src/ports';

const platformConfig = {
  getGitLabOAuthConfig: vi.fn(),
};

// The worker resolves GitLab OAuth settings through its platform-config port.
configureRepoHostingPort('platformConfig', {
  githubApp: vi.fn(),
  githubOAuth: vi.fn(),
  gitlabOAuth: (env) => platformConfig.getGitLabOAuthConfig(env),
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  platformConfig.getGitLabOAuthConfig.mockResolvedValue({
    host: 'https://gitlab.example.com/',
    apiBaseUrl: 'https://gitlab.example.com/api/v4',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('verifyGitLabProjectAccess', () => {
  it('returns VM-facing bare host metadata and a valid HTTPS clone fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123,
          path_with_namespace: 'group/project',
          name: 'project',
          visibility: 'private',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/group/project',
          permissions: {
            project_access: { access_level: 30 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    globalThis.fetch = fetchMock;

    const metadata = await verifyGitLabProjectAccess({} as Env, 'gl_token', 123);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/123',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
    expect(metadata).toEqual({
      host: 'gitlab.example.com',
      gitlabProjectId: 123,
      pathWithNamespace: 'group/project',
      webUrl: 'https://gitlab.example.com/group/project',
      httpUrlToRepo: 'https://gitlab.example.com/group/project.git',
      defaultBranch: 'main',
    });
  });

  it('rejects a project when the user has less than Developer access', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123,
          path_with_namespace: 'group/project',
          name: 'project',
          visibility: 'private',
          default_branch: 'main',
          // Reporter (20) is below the Developer (30) write threshold.
          permissions: { project_access: { access_level: 20 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(verifyGitLabProjectAccess({} as Env, 'gl_token', 123)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('surfaces a 404 from GitLab as a not-found error, not a 500', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"404 Project Not Found"}', { status: 404 }));

    await expect(verifyGitLabProjectAccess({} as Env, 'gl_token', 999)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('inherits group access when project access is below the threshold', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123,
          path_with_namespace: 'group/project',
          name: 'project',
          visibility: 'private',
          default_branch: 'main',
          permissions: {
            project_access: { access_level: 10 },
            group_access: { access_level: 40 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const metadata = await verifyGitLabProjectAccess({} as Env, 'gl_token', 123);
    expect(metadata.gitlabProjectId).toBe(123);
  });
});

describe('GitLab API requests (self-host SSRF, T5)', () => {
  const projectJson = JSON.stringify({
    id: 123,
    path_with_namespace: 'group/project',
    name: 'project',
    visibility: 'private',
    default_branch: 'main',
    web_url: 'https://gitlab.example.com/group/project',
    permissions: { project_access: { access_level: 30 } },
  });

  it('refuses a redirect from the GitLab host to an internal address, never sending the token there', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:7001/state' } })
    );
    globalThis.fetch = fetchMock;

    await expect(verifyGitLabProjectAccess({} as Env, 'gl_token', 123)).rejects.toMatchObject({
      statusCode: 502,
      error: 'GITLAB_REQUEST_REFUSED',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a redirect within the configured host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { Location: 'https://gitlab.example.com/api/v4/projects/123?moved=1' },
        })
      )
      .mockResolvedValueOnce(
        new Response(projectJson, { status: 200, headers: { 'content-type': 'application/json' } })
      );
    globalThis.fetch = fetchMock;

    await expect(verifyGitLabProjectAccess({} as Env, 'gl_token', 123)).resolves.toMatchObject({
      gitlabProjectId: 123,
    });
    expect(
      new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get('authorization')
    ).toBe('Bearer gl_token');
  });

  it('control: a self-managed GitLab the admin configured on the private network still works', async () => {
    platformConfig.getGitLabOAuthConfig.mockResolvedValue({
      host: 'http://localhost:8929',
      apiBaseUrl: 'http://localhost:8929/api/v4',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      // The explicit admin opt-in (integration.gitlab.allowPrivateNetwork).
      allowPrivateNetwork: true,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(projectJson, { status: 200, headers: { 'content-type': 'application/json' } })
    );
    globalThis.fetch = fetchMock;

    await expect(verifyGitLabProjectAccess({} as Env, 'gl_token', 123)).resolves.toMatchObject({
      gitlabProjectId: 123,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8929/api/v4/projects/123');
  });

  it('a public GitLab cannot redirect into the private network', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { Location: 'https://10.0.0.8/api/v4/x' } })
    );
    globalThis.fetch = fetchMock;

    await expect(verifyGitLabProjectAccess({} as Env, 'gl_token', 123)).rejects.toMatchObject({
      statusCode: 502,
      error: 'GITLAB_REQUEST_REFUSED',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
