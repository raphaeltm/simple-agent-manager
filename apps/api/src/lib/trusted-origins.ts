import type { Env } from '../env';

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('BASE_DOMAIN is required to derive trusted origins');
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host;
  } catch {
    throw new Error('BASE_DOMAIN must be a valid host to derive trusted origins');
  }
}

function isLocalhostHost(host: string): boolean {
  const parsed = new URL(`http://${host}`);
  return LOCALHOST_HOSTS.has(parsed.hostname);
}

/**
 * Returns the trusted public API origin for callback/webhook/setup URLs.
 *
 * Production deployments derive from BASE_DOMAIN as https://api.{BASE_DOMAIN}.
 * Local development keeps the historical localhost origin so tests/dev flows that
 * set BASE_DOMAIN=localhost[:port] do not need an api.localhost hostname.
 */
export function getTrustedApiOrigin(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const host = normalizeHost(env.BASE_DOMAIN);
  if (isLocalhostHost(host)) return `http://${host}`;
  return `https://api.${host}`;
}

export function buildTrustedApiUrl(env: Pick<Env, 'BASE_DOMAIN'>, path: string): string {
  return new URL(path, getTrustedApiOrigin(env)).toString();
}
