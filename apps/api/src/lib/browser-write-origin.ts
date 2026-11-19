/**
 * Cookie-authenticated writes that only the app's own pages should make (answering an agent's
 * interaction, supplying a secret) require the exact app origin. The credentialed CORS allowlist
 * also admits the marketing and docs hosts, and same-site workspace hosts still receive the
 * session cookie, so an origin check is the boundary rather than CORS alone.
 */
import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { isLocalDevelopmentBaseDomain, LOCAL_DEVELOPMENT_HOSTS } from './cors-origin';
import { getTrustedApiOrigin } from './trusted-origins';

/** `https://app.<BASE_DOMAIN>`, derived from the trusted API origin. */
export function exactAppOrigin(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const apiOrigin = getTrustedApiOrigin(env);
  const url = new URL(apiOrigin);
  if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`;
  return url.toString().replace(/\/$/u, '');
}

/**
 * Local development serves the app from a loopback port (Vite, `:5173`) while the API runs on
 * another (`BASE_DOMAIN=localhost:8787`), so the derived app origin cannot match there. Loopback
 * origins are admitted only when BASE_DOMAIN itself is local, the rule `appFrameAncestors` and
 * credentialed CORS already use.
 */
function isAppOrigin(origin: string, env: Pick<Env, 'BASE_DOMAIN'>): boolean {
  if (origin === exactAppOrigin(env)) return true;
  if (!isLocalDevelopmentBaseDomain(env.BASE_DOMAIN)) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOCAL_DEVELOPMENT_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

export function requireExactBrowserOrigin(
  c: { req: { header: (name: string) => string | undefined }; env: Env },
  what = 'interaction'
): void {
  const origin = c.req.header('Origin');
  const fetchSite = c.req.header('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') {
    throw errors.forbidden(`Cross-site ${what} writes are not allowed`);
  }
  if (!origin || !isAppOrigin(origin, c.env)) {
    throw errors.forbidden(`Untrusted ${what} write origin`);
  }
}

/**
 * Guard a cookie-authenticated write that is also available to non-browser API clients.
 * Browsers attach Origin to unsafe cross-origin requests and modern browsers also attach Fetch
 * Metadata; if either signal is present, require the exact app origin. Clients with neither
 * browser-controlled header retain their authenticated API path.
 */
export function requireTrustedWriteOrigin(
  what = 'state-changing'
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const fetchSite = c.req.header('Sec-Fetch-Site');
    // `undefined` is "header absent"; an empty Origin is still a browser signal to validate.
    if (origin !== undefined || fetchSite !== undefined) {
      requireExactBrowserOrigin(c, what);
    }
    await next();
  };
}
