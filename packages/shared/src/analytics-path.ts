/**
 * Privacy normalization for analytics page and referrer values, shared by the web tracker
 * (apps/web/src/lib/analytics.ts) and the self-host D1 analytics sink
 * (apps/api/src/selfhost/analytics/d1-sink.ts), so both apply one definition of "sensitive".
 *
 * Contract: strip query strings, fragments, protocol, host and userinfo; keep non-sensitive
 * nested path shape; redact emails, UUIDs/ULIDs, long opaque tokens, common secret prefixes,
 * repository/code file identifiers, and values following sensitive route markers.
 */
const REDACTED_SEGMENT = '[redacted]';
const EMAIL_RE = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const HEX_TOKEN_RE = /^[a-f0-9]{20,}$/i;
const SECRET_PREFIX_RE = /^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|sam_[a-z0-9]+_|eyJ)/i;
const LONG_OPAQUE_SEGMENT_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{24,}$/;
const SENSITIVE_ROUTE_MARKER_RE =
  /^(?:token|tokens|oauth|callback|auth|login|setup|invite|invites|reset|verify|verification|code|codes|secret|secrets|key|keys|repo|repos|repository|repositories|workspace|workspaces|project|projects|task|tasks|session|sessions|node|nodes|file|files)$/i;
const CODEBASE_FILE_SEGMENT_RE =
  /^[^/]+\.(?:git|ts|tsx|js|jsx|go|rs|py|java|rb|php|cs|cpp|c|h|hpp|swift|kt|md|mdx|json|ya?ml|toml|env|pem|key)$/i;

function stripTrailingSlashes(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/, '') || '/';
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Whether one path segment must not be stored, given the segment before it. */
export function isSensitiveAnalyticsPathSegment(
  segment: string,
  previousSegment?: string
): boolean {
  const decoded = safeDecodeURIComponent(segment);
  return (
    EMAIL_RE.test(decoded) ||
    UUID_RE.test(decoded) ||
    ULID_RE.test(decoded) ||
    HEX_TOKEN_RE.test(decoded) ||
    SECRET_PREFIX_RE.test(decoded) ||
    LONG_OPAQUE_SEGMENT_RE.test(decoded) ||
    CODEBASE_FILE_SEGMENT_RE.test(decoded) ||
    (previousSegment !== undefined && SENSITIVE_ROUTE_MARKER_RE.test(previousSegment))
  );
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return '/';

  const safeSegments = segments.map((segment, index) => {
    const previousSegment =
      index > 0 ? safeDecodeURIComponent(segments[index - 1] ?? '') : undefined;
    if (isSensitiveAnalyticsPathSegment(segment, previousSegment)) return REDACTED_SEGMENT;
    return encodeURIComponent(safeDecodeURIComponent(segment).slice(0, 80));
  });

  return stripTrailingSlashes(`/${safeSegments.join('/')}`);
}

function toUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    try {
      return new URL(value, 'https://analytics.local');
    } catch {
      return null;
    }
  }
}

/**
 * Normalize analytics page values to a safe path-only contract.
 *
 * Contract:
 * - Strip query strings, fragments, protocol, host, and userinfo.
 * - Preserve non-sensitive nested path shape for aggregate reporting.
 * - Redact emails, UUIDs/ULIDs, long opaque tokens, common secret prefixes,
 *   repository/code file identifiers, and values following sensitive route markers.
 */
export function normalizeAnalyticsPath(value: string | undefined): string {
  if (!value) return '';
  const url = toUrl(value.trim());
  if (!url) return '';
  return normalizePathname(url.pathname);
}

/**
 * Normalize analytics referrers without sending full URLs.
 *
 * Referrers keep origin plus normalized path context. Search params, fragments,
 * credentials, and sensitive path segments are removed.
 */
export function normalizeAnalyticsReferrer(value: string | undefined): string {
  if (!value) return '';
  const url = toUrl(value.trim());
  if (!url || url.hostname === 'analytics.local') {
    return normalizeAnalyticsPath(value);
  }
  const path = normalizePathname(url.pathname);
  return path === '/' ? url.origin : `${url.origin}${path}`;
}
