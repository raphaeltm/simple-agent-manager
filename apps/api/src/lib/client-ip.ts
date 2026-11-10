/**
 * The client IP address the trusted ingress reported, or null when it reported none.
 *
 * One rule for every caller (rate-limit keys, stored diagnostics, heartbeat IP backfill,
 * forwarded-for on the VM hop):
 *
 * - Only `CF-Connecting-IP` is trusted. On Cloudflare the edge always sets it and overwrites any
 *   value a client sent; the self-hosted ingress (deploy/selfhost Caddy) does the same from the
 *   TCP peer address. `X-Forwarded-For` is never read: wherever the trusted header is missing,
 *   nothing guarantees who wrote `X-Forwarded-For`, so a key taken from it is a bypass.
 * - A well-formed value is returned exactly as received, so Cloudflare rate-limit keys and stored
 *   addresses stay byte-identical to what SAM produced before this helper existed.
 * - A missing or malformed value (anything that is not an IP literal, or an oversized value)
 *   yields null. Callers that key a rate limit then use ONE shared bucket (`?? 'unknown'`): a
 *   request with no trusted address can only come through a misconfigured or bypassed ingress,
 *   and a shared bucket fails closed for exactly that traffic, where a client-chosen key (another
 *   header, the User-Agent) would let it mint a fresh bucket per request.
 */
export function clientIpFromHeaders(
  header: (name: string) => string | null | undefined
): string | null {
  const connecting = header('CF-Connecting-IP')?.trim();
  return connecting && isIpLiteral(connecting) ? connecting : null;
}

/** Longest textual IPv6 form (IPv4-mapped, fully expanded). */
const MAX_IP_LITERAL_LENGTH = 45;

/** Whether `value` is an IPv4 or IPv6 literal (no port, zone id or brackets). */
function isIpLiteral(value: string): boolean {
  if (value.length > MAX_IP_LITERAL_LENGTH) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255);
  }
  // The character check keeps zone ids and anything bracketed out; the URL parser then accepts
  // only a well-formed IPv6 address (so "1.2.3.4:80" or "ab:cd" are rejected).
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  return URL.canParse(`http://[${value}]/`);
}
