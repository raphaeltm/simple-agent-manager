/**
 * Shared plumbing for OAuth sign-in vertical slices: the production `/api/auth` routes mounted as
 * `src/index.ts` mounts them, a cookie jar that carries cookies across the OAuth redirects the way
 * a browser does, and the "click Sign in with <provider>" step.
 */
import { Hono } from 'hono';
import { expect } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';

export type AuthApp = Hono<{ Bindings: Env }>;
export type CookieJar = ReturnType<typeof createCookieJar>;

/** Mounted, and its errors handled, exactly as `src/index.ts` does. */
export function buildAuthApp(): AuthApp {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);
  return app;
}

/** Carries cookies between requests the way the browser does across the OAuth redirects. */
export function createCookieJar() {
  const cookies = new Map<string, string>();
  return {
    store(response: Response) {
      for (const setCookie of response.headers.getSetCookie()) {
        const pair = setCookie.split(';', 1)[0] ?? '';
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value === '' || /max-age=0/i.test(setCookie)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

/** Browser: click "Sign in with <provider>". Returns the provider authorize URL SAM redirects to. */
export async function startSocialSignIn(
  app: AuthApp,
  env: Env,
  jar: CookieJar,
  options: { apiOrigin: string; appOrigin: string; provider: string; callbackURL: string }
): Promise<URL> {
  const start = await app.request(
    `${options.apiOrigin}/api/auth/sign-in/social`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: options.appOrigin,
        cookie: jar.header(),
      },
      body: JSON.stringify({ provider: options.provider, callbackURL: options.callbackURL }),
    },
    env
  );
  expect(start.status).toBe(200);
  jar.store(start);
  const { url } = (await start.json()) as { url: string };
  return new URL(url);
}
