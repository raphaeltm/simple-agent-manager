import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { verifyGitLabProjectAccess } from '../../../src/services/gitlab';

const platformConfig = vi.hoisted(() => ({
  getGitLabOAuthConfig: vi.fn(),
}));

vi.mock('../../../src/services/platform-config', () => platformConfig);

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
