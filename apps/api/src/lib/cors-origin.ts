const CREDENTIALED_CORS_SUBDOMAINS = new Set(['api', 'app', 'docs', 'www']);

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function isLocalDevelopmentOrigin(hostname: string, baseDomain: string): boolean {
  const isDevEnvironment = !baseDomain || baseDomain.includes('localhost');
  return isDevEnvironment && (hostname === 'localhost' || hostname === '127.0.0.1');
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
