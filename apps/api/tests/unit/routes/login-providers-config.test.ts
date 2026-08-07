/**
 * Regression test for GET /api/config/login-providers.
 *
 * The login surfaces gate their provider buttons on this endpoint. Google here
 * MUST reflect the LOGIN client (getGoogleLoginOAuthConfig / GOOGLE_LOGIN_*),
 * NOT the infra/GCP client (GOOGLE_CLIENT_*). Otherwise a "Sign in with Google"
 * button appears for a client whose redirect URI is not registered for login,
 * producing Error 400: redirect_uri_mismatch on click.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { getGitHubOAuthConfig, getGitLabOAuthConfig, getGoogleLoginOAuthConfig } from '../../../src/services/platform-config';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  // Replicate the exact handler from src/index.ts
  app.get('/api/config/login-providers', async (c) => {
    const [github, google, gitlab] = await Promise.all([
      getGitHubOAuthConfig(c.env),
      getGoogleLoginOAuthConfig(c.env),
      getGitLabOAuthConfig(c.env),
    ]);
    return c.json({ github: github !== null, google: google !== null, gitlab: gitlab !== null });
  });
  return app;
}

async function get(env: Partial<Env>) {
  const res = await createApp().request('/api/config/login-providers', {}, env as Env);
  expect(res.status).toBe(200);
  return (await res.json()) as { github: boolean; google: boolean; gitlab: boolean };
}

describe('GET /api/config/login-providers', () => {
  it('reports both false when nothing is configured', async () => {
    expect(await get({})).toEqual({ github: false, google: false, gitlab: false });
  });

  it('reports github true when GitHub OAuth is configured', async () => {
    expect(
      await get({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' })
    ).toEqual({ github: true, google: false, gitlab: false });
  });

  it('reports google true from the LOGIN client env vars', async () => {
    expect(
      await get({ GOOGLE_LOGIN_CLIENT_ID: 'login-id', GOOGLE_LOGIN_CLIENT_SECRET: 'login-secret' })
    ).toEqual({ github: false, google: true, gitlab: false });
  });

  it('reports gitlab true when GitLab OAuth is configured', async () => {
    expect(
      await get({
        GITLAB_HOST: 'https://gitlab.example.com',
        GITLAB_CLIENT_ID: 'gitlab-client-id',
        GITLAB_CLIENT_SECRET: 'gitlab-client-secret',
      })
    ).toEqual({ github: false, google: false, gitlab: true });
  });

  it('reports google FALSE when only the infra/GCP Google client is set', async () => {
    // GOOGLE_CLIENT_ID/SECRET are the infra client — they must NOT enable the
    // Google login button.
    expect(
      await get({ GOOGLE_CLIENT_ID: 'infra-id', GOOGLE_CLIENT_SECRET: 'infra-secret' })
    ).toEqual({ github: false, google: false, gitlab: false });
  });
});
