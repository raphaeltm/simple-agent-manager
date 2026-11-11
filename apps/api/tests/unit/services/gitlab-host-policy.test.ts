/**
 * GitLab API host policy (self-host T5 follow-up, item 8): a private GitLab host needs the
 * explicit admin opt-in, metadata hosts are refused always, and a request the guarded fetch
 * refuses mid-flight reaches the client as a 502 with a stable code, never a 500.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { verifyGitLabProjectAccess } from '../../../src/services/gitlab';

const platformConfig = vi.hoisted(() => ({ getGitLabOAuthConfig: vi.fn() }));
vi.mock('../../../src/services/platform-config', () => platformConfig);

const PROJECT = {
  id: 5,
  path_with_namespace: 'g/p',
  name: 'p',
  visibility: 'private',
  default_branch: 'main',
  web_url: null,
  http_url_to_repo: 'https://gitlab.example.com/g/p.git',
  permissions: { project_access: { access_level: 40 } },
};

function configure(host: string, allowPrivateNetwork: boolean) {
  platformConfig.getGitLabOAuthConfig.mockResolvedValue({
    host,
    apiBaseUrl: `${host}/api/v4`,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    allowPrivateNetwork,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json(PROJECT));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitLab host policy', () => {
  it('refuses a private GitLab host without the admin opt-in, before any request', async () => {
    configure('http://192.168.1.20', false);
    await expect(verifyGitLabProjectAccess({} as Env, 'glpat', 5)).rejects.toMatchObject({
      statusCode: 400,
      error: 'GITLAB_PRIVATE_NETWORK_NOT_ALLOWED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: with integration.gitlab.allowPrivateNetwork on, the private host is called', async () => {
    configure('http://192.168.1.20', true);
    await expect(verifyGitLabProjectAccess({} as Env, 'glpat', 5)).resolves.toMatchObject({
      gitlabProjectId: 5,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refuses a metadata host even with the opt-in', async () => {
    configure('http://169.254.169.254', true);
    await expect(verifyGitLabProjectAccess({} as Env, 'glpat', 5)).rejects.toMatchObject({
      statusCode: 400,
      error: 'GITLAB_HOST_NOT_ALLOWED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a cross-origin public redirect without the token, and succeeds', async () => {
    configure('https://gitlab.example.com', false);
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: 'https://gitlab-cdn.example.net/api/v4/projects/5' },
      })
    );
    await expect(verifyGitLabProjectAccess({} as Env, 'glpat-secret', 5)).resolves.toMatchObject({
      gitlabProjectId: 5,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://gitlab.example.com/api/v4/projects/5',
      'https://gitlab-cdn.example.net/api/v4/projects/5',
    ]);
    const first = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const hop = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    expect(first.get('authorization')).toBe('Bearer glpat-secret');
    expect(hop.get('authorization')).toBeNull();
    expect(hop.get('private-token')).toBeNull();
    expect(hop.get('accept')).toBe('application/json');
  });

  it('a redirect chain longer than the hop limit is a 502 after exactly limit + 1 requests', async () => {
    configure('https://gitlab.example.com', false);
    let hop = 0;
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://gitlab.example.com/api/v4/loop/${(hop += 1)}` },
        })
    );
    await expect(verifyGitLabProjectAccess({} as Env, 'glpat', 5)).rejects.toMatchObject({
      statusCode: 502,
      error: 'GITLAB_REQUEST_REFUSED',
    });
    // outbound.maxRedirects defaults to 3 (settings unreadable here, so the default applies).
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a redirect to a refused host is a 502 GITLAB_REQUEST_REFUSED through the app error handler', async () => {
    configure('https://gitlab.example.com', false);
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:7001/v1/state' } })
    );
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.get('/probe', async (c) => c.json(await verifyGitLabProjectAccess(c.env, 'glpat', 5)));
    const response = await app.request('/probe', {}, {} as Env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'GITLAB_REQUEST_REFUSED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
