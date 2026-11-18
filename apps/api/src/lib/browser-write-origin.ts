/**
 * Cookie-authenticated writes that only the app's own pages should make (answering an agent's
 * interaction, supplying a secret) require the exact app origin. The credentialed CORS allowlist
 * also admits the marketing and docs hosts, and same-site workspace hosts still receive the
 * session cookie, so an origin check is the boundary rather than CORS alone.
 */
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { getTrustedApiOrigin } from './trusted-origins';

/** `https://app.<BASE_DOMAIN>`, derived from the trusted API origin. */
export function exactAppOrigin(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const apiOrigin = getTrustedApiOrigin(env);
  const url = new URL(apiOrigin);
  if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`;
  return url.toString().replace(/\/$/u, '');
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
  if (!origin || origin !== exactAppOrigin(c.env)) {
    throw errors.forbidden(`Untrusted ${what} write origin`);
  }
}
