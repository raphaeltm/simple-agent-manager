/**
 * GitLab API calls are bounded by one deadline for the whole call (GITLAB_API_TIMEOUT_MS), not
 * per redirect hop: before the fix each hop had its own timeout, so the worst case was the
 * timeout times (hops + 1). Real HTTP server, real fetch.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { verifyGitLabProjectAccess } from '../../../src/services/gitlab';

const platformConfig = vi.hoisted(() => ({ getGitLabOAuthConfig: vi.fn() }));
vi.mock('../../../src/services/platform-config', () => platformConfig);

const PROJECT = {
  id: 1,
  path_with_namespace: 'g/p',
  name: 'p',
  visibility: 'private',
  default_branch: 'main',
  web_url: null,
  http_url_to_repo: 'https://gitlab.example.com/g/p.git',
  permissions: { project_access: { access_level: 40 } },
};

let server: Server;
let requests = 0;

beforeEach(async () => {
  requests = 0;
  server = createServer((req, res) => {
    requests += 1;
    const hop = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('hop') ?? '0');
    setTimeout(() => {
      if (hop >= 2) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(PROJECT));
        return;
      }
      res.writeHead(302, { location: `/api/v4/projects/1?hop=${hop + 1}` });
      res.end();
    }, 300);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  platformConfig.getGitLabOAuthConfig.mockResolvedValue({
    host,
    apiBaseUrl: `${host}/api/v4`,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    allowPrivateNetwork: true,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GitLab API deadline', () => {
  it('a redirect chain cannot stretch one call past GITLAB_API_TIMEOUT_MS', async () => {
    // Three 300 ms responses: each fits in 700 ms on its own, the call as a whole does not.
    const env = { GITLAB_API_TIMEOUT_MS: '700' } as Env;
    const started = Date.now();
    await expect(verifyGitLabProjectAccess(env, 'glpat', 1)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(950);
    expect(requests).toBe(3);
  });

  it('control: the same chain completes within a deadline it fits in', async () => {
    const env = { GITLAB_API_TIMEOUT_MS: '3000' } as Env;
    await expect(verifyGitLabProjectAccess(env, 'glpat', 1)).resolves.toMatchObject({
      gitlabProjectId: 1,
    });
  });
});
