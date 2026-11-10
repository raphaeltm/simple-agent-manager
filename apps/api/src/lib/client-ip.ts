/**
 * The client IP address the ingress reported, or null when it reported none.
 *
 * On Cloudflare the edge always sets `CF-Connecting-IP` and overwrites any value a client sent.
 * A self-hosted ingress must do the same: set `CF-Connecting-IP` from the TCP peer address on
 * every request and drop client-supplied `CF-Connecting-IP`, `True-Client-IP` and
 * `X-Forwarded-For`. The `X-Forwarded-For` fallback (first entry) is only reached when no
 * ingress set the header, and is client-controlled there.
 *
 * Only an IP literal is returned: these values key rate limits, so anything else (an injected
 * `:`-separated string, an oversized value) is treated as absent.
 */
export function clientIpFromHeaders(
  header: (name: string) => string | null | undefined
): string | null {
  const connecting = header('CF-Connecting-IP')?.trim();
  if (connecting && isIpLiteral(connecting)) return connecting;
  const forwarded = header('X-Forwarded-For')?.split(',')[0]?.trim();
  return forwarded && isIpLiteral(forwarded) ? forwarded : null;
}

/** Longest textual IPv6 form (IPv4-mapped, fully expanded). */
const MAX_IP_LITERAL_LENGTH = 45;

function isIpLiteral(value: string): boolean {
  if (value.length > MAX_IP_LITERAL_LENGTH) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255);
  }
  // The character check keeps zone ids and anything bracketed out; the URL parser then
  // accepts only a well-formed IPv6 address (so "1.2.3.4:80" or "ab:cd" are rejected).
  return value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value) && isIpv6Literal(value);
}

function isIpv6Literal(value: string): boolean {
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}
