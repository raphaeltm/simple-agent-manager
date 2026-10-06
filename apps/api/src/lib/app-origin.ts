/**
 * The web app's origin, and which pages may frame the documents the API serves
 * for it.
 */
import type { Env } from '../env';
import { isLocalDevelopmentBaseDomain, LOCAL_DEVELOPMENT_HOSTS } from './cors-origin';

export function getAppOrigin(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const baseDomain = env.BASE_DOMAIN?.trim().toLowerCase();
  if (!baseDomain) throw new Error('BASE_DOMAIN is required to build the app origin');
  return `https://app.${baseDomain}`;
}

/**
 * The CSP `frame-ancestors` directive for a document only the app may frame. The
 * app never shares an origin with those documents (library previews come from
 * `api.<domain>`, interactive previews from their own host), so `'self'` would
 * block it, and X-Frame-Options cannot name another origin at all. Local
 * development serves the app from a loopback port.
 */
export function appFrameAncestors(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const ancestors = [getAppOrigin(env)];
  if (isLocalDevelopmentBaseDomain(env.BASE_DOMAIN)) {
    ancestors.push(...LOCAL_DEVELOPMENT_HOSTS.map((host) => `http://${host}:*`));
  }
  return `frame-ancestors ${ancestors.join(' ')}`;
}
