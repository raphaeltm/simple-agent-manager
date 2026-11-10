/**
 * The client IP address the ingress reported, or null when it reported none.
 *
 * On Cloudflare the edge always sets `CF-Connecting-IP` and overwrites any value a client sent.
 * A self-hosted ingress must do the same: set `CF-Connecting-IP` from the TCP peer address on
 * every request and drop client-supplied `CF-Connecting-IP`, `True-Client-IP` and
 * `X-Forwarded-For`. The `X-Forwarded-For` fallback (first entry) is only reached when no
 * ingress set the header, and is client-controlled there.
 */
export function clientIpFromHeaders(
  header: (name: string) => string | null | undefined
): string | null {
  const connecting = header('CF-Connecting-IP')?.trim();
  if (connecting) return connecting;
  const forwarded = header('X-Forwarded-For')?.split(',')[0]?.trim();
  return forwarded || null;
}
