import { classifyHost } from './classify';

/** Link-local, metadata, unspecified, multicast and reserved hosts. */
export function isForbiddenEndpointHost(hostname: string): boolean {
  return classifyHost(hostname) === 'forbidden';
}

/** Loopback, private ranges and private-network names. */
export function isPrivateNetworkHost(hostname: string): boolean {
  return classifyHost(hostname) === 'private';
}

/**
 * An operator endpoint URL (LLM endpoint, S3 store): HTTPS to any host except a forbidden one,
 * or HTTP to a private host. Never userinfo, query or fragment. Whether a private host may be
 * reached at use time is a separate operator opt-in (`OutboundPolicy.allowPrivateNetwork`).
 */
export function isAcceptableOperatorEndpoint(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  const hostClass = classifyHost(url.hostname);
  if (url.protocol === 'https:') return hostClass !== 'forbidden';
  return url.protocol === 'http:' && hostClass === 'private';
}
