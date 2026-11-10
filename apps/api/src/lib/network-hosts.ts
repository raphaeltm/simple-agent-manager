/**
 * Host classification for operator-configured endpoints (the LLM endpoint, an S3 store).
 *
 * These URLs are set by an admin or the deployment, so the threat is a mistake or a compromised
 * admin, not an arbitrary user. Two rules:
 * - plain HTTP is allowed only to the operator's own network, so credentials never cross the
 *   internet unencrypted;
 * - cloud metadata services and link-local addresses are never a valid endpoint, over any scheme.
 */

/** Hostnames of instance metadata services on the major clouds. */
const METADATA_HOSTNAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data']);

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function ipv4Octets(host: string): number[] | null {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return octets;
}

/**
 * Link-local (169.254.0.0/16, fe80::/10, which includes the AWS and GCP metadata addresses), the
 * AWS IPv6 metadata address, the unspecified address and known metadata hostnames.
 */
export function isForbiddenEndpointHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (METADATA_HOSTNAMES.has(host)) return true;
  if (host.includes(':')) {
    return host === '::' || /^fe[89ab][0-9a-f]:/.test(host) || host === 'fd00:ec2::254';
  }
  const octets = ipv4Octets(host);
  return octets !== null && (octets[0] === 0 || (octets[0] === 169 && octets[1] === 254));
}

/**
 * Loopback, RFC 1918, IPv6 loopback and unique-local (fc00::/7), `.local`/`.internal` names and
 * single-label hosts (Docker service names) are on the operator's own network.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (isForbiddenEndpointHost(host)) return false;
  // Every IPv6 literal contains ':'; decide those here so the single-label rule below cannot
  // admit a public IPv6 (or IPv4-mapped) address.
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  if (host === 'localhost' || !host.includes('.')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a = -1, b = -1] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * An operator endpoint URL: HTTPS to any host except a forbidden one, or HTTP to a private host.
 * Never userinfo, query or fragment.
 */
export function isAcceptableOperatorEndpoint(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return !isForbiddenEndpointHost(url.hostname);
  return url.protocol === 'http:' && isPrivateNetworkHost(url.hostname);
}
