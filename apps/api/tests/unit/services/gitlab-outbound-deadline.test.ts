/**
 * GitLab API calls are bounded by one deadline for the whole call (GITLAB_API_TIMEOUT_MS), not
 * per redirect hop: before the fix each hop had its own timeout, so the worst case was the
 * timeout times (hops + 1). Real HTTP server and real fetch; the server holds every hop until
 * the test answers it and only setTimeout/clearTimeout are faked, so the deadline lands exactly
 * between the hops the test chooses, whatever the machine load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { verifyGitLabProjectAccess } from '../../../src/services/gitlab';
import { type HeldHttpServer, settled, startHeldHttpServer } from '../../helpers/held-http-server';

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

let server: HeldHttpServer;

beforeEach(async () => {
  server = await startHeldHttpServer();
  platformConfig.getGitLabOAuthConfig.mockResolvedValue({
    host: server.base,
    apiBaseUrl: `${server.base}/api/v4`,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    allowPrivateNetwork: true,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await server.close();
});

/** Answers hops 0 and 1 with a redirect after `hopMs` each; returns the third request. */
async function twoSlowRedirects(hopMs: number) {
  for (const next of ['/api/v4/projects/1?hop=1', '/api/v4/projects/1?hop=2']) {
    const request = await server.nextRequest();
    vi.advanceTimersByTime(hopMs);
    request.respond(302, { location: next });
  }
  return server.nextRequest();
}

describe('GitLab API deadline', () => {
  it('a redirect chain cannot stretch one call past GITLAB_API_TIMEOUT_MS', async () => {
    // Each hop takes 400 ms of a 1000 ms deadline: no hop outlasts it, the chain does.
    const env = { GITLAB_API_TIMEOUT_MS: '1000' } as Env;
    const call = verifyGitLabProjectAccess(env, 'glpat', 1).catch((err: unknown) => err);
    await twoSlowRedirects(400);
    expect(await settled(call)).toBe(false);
    vi.advanceTimersByTime(400);
    expect(await settled(call)).toBe(true);
    expect(await call).toMatchObject({ statusCode: 504, error: 'GITLAB_TIMEOUT' });
    expect(server.count()).toBe(3);
  });

  it('control: the same chain completes within a deadline it fits in', async () => {
    const env = { GITLAB_API_TIMEOUT_MS: '3000' } as Env;
    const call = verifyGitLabProjectAccess(env, 'glpat', 1);
    const last = await twoSlowRedirects(400);
    vi.advanceTimersByTime(400);
    last.respond(200, { 'content-type': 'application/json' }, JSON.stringify(PROJECT));
    await expect(call).resolves.toMatchObject({ gitlabProjectId: 1 });
  });
});
