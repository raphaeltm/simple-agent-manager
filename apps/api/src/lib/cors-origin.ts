const CREDENTIALED_CORS_SUBDOMAINS = new Set(['api', 'app', 'docs', 'www']);

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** Hosts the app and the API run on during local development (`pnpm dev`). */
export const LOCAL_DEVELOPMENT_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * Local development leaves BASE_DOMAIN empty or points it at a loopback host, such
 * as `localhost:8787`. The host must match exactly: a real domain that merely
 * contains "localhost" is not local development.
 */
export function isLocalDevelopmentBaseDomain(baseDomainValue: string | undefined): boolean {
  const baseDomain = normalizeHostname(baseDomainValue || '');
  if (!baseDomain) return true;
  const host = baseDomain.replace(/:\d+$/, '');
  return LOCAL_DEVELOPMENT_HOSTS.includes(host) || host.endsWith('.localhost');
}

function isLocalDevelopmentOrigin(hostname: string, baseDomain: string): boolean {
  return isLocalDevelopmentBaseDomain(baseDomain) && LOCAL_DEVELOPMENT_HOSTS.includes(hostname);
}

export function resolveCredentialedCorsOrigin(
  origin: string | undefined,
  baseDomainValue: string | undefined
): string | null {
  if (!origin) return null;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const hostname = normalizeHostname(url.hostname);
  const baseDomain = normalizeHostname(baseDomainValue || '');

  if (isLocalDevelopmentOrigin(hostname, baseDomain)) return origin;
  if (url.protocol !== 'https:') return null;
  if (!baseDomain) return null;

  if (hostname === baseDomain) return origin;

  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return null;

  const subdomain = hostname.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes('.')) return null;

  return CREDENTIALED_CORS_SUBDOMAINS.has(subdomain) ? origin : null;
}
