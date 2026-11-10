/**
 * The client IP address the ingress reported, or null when it reported none.
 *
 * On Cloudflare the edge always sets `CF-Connecting-IP` and overwrites any value a client sent.
 * A self-hosted ingress must do the same: set `CF-Connecting-IP` from the TCP peer address on
 * every request and drop client-supplied `CF-Connecting-IP`, `True-Client-IP` and
 * `X-Forwarded-For`. The `X-Forwarded-For` fallback (first entry) is only reached when no
 * ingress set the header, and is client-controlled there.
 *
 * Only an IP literal is returned, in canonical form: these values key rate limits, so anything
 * else (an injected `:`-separated string, an oversized value) is treated as absent, and two
 * spellings of one address (`::1` and `0:0:0:0:0:0:0:1`, `010.1.1.1` and `10.1.1.1`) share a key.
 */
export function clientIpFromHeaders(
  header: (name: string) => string | null | undefined
): string | null {
  const connecting = canonicalIp(header('CF-Connecting-IP')?.trim());
  if (connecting) return connecting;
  return canonicalIp(header('X-Forwarded-For')?.split(',')[0]?.trim());
}

/** Longest textual IPv6 form (IPv4-mapped, fully expanded). */
const MAX_IP_LITERAL_LENGTH = 45;

/** The canonical text of an IP literal, or null for anything else. */
function canonicalIp(value: string | undefined): string | null {
  if (!value || value.length > MAX_IP_LITERAL_LENGTH) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split('.').map(Number);
    return octets.every((octet) => octet <= 255) ? octets.join('.') : null;
  }
  // The character check keeps zone ids and anything bracketed out; the URL parser then accepts
  // only a well-formed IPv6 address (so "1.2.3.4:80" or "ab:cd" are rejected) and compresses it.
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}
