/**
 * SAM Website Analytics Tracker
 *
 * Lightweight, privacy-respecting page view tracker for the marketing site.
 * Sends events to the SAM analytics ingest endpoint (POST /api/t).
 *
 * Usage: <script src="/scripts/tracker.js" data-api="https://api.example.com/api/t" defer></script>
 */

interface AnalyticsEvent {
  event: string;
  page: string;
  referrer: string;
  host: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  sessionId: string;
  visitorId: string;
  entityId: string;
  durationMs: number;
  timestamp: string;
}

(function (): void {
  'use strict';

  const script = document.currentScript as HTMLScriptElement | null;
  const endpoint = script?.getAttribute('data-api');
  if (!endpoint) return;

  // Validate endpoint is a well-formed HTTPS URL
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:') return;
  } catch {
    return;
  }

  const host = location.hostname;
  const redactedSegment = '[redacted]';
  const emailRe = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/i;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ulidRe = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
  const hexTokenRe = /^[a-f0-9]{20,}$/i;
  const secretPrefixRe = /^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|sam_[a-z0-9]+_|eyJ)/i;
  const longOpaqueSegmentRe = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{24,}$/;
  const sensitiveMarkerRe = /^(?:token|tokens|oauth|callback|auth|login|setup|invite|invites|reset|verify|verification|code|codes|secret|secrets|key|keys|repo|repos|repository|repositories|workspace|workspaces|project|projects|task|tasks|session|sessions|node|nodes|file|files)$/i;
  const codebaseFileSegmentRe = /^[^/]+\.(?:git|ts|tsx|js|jsx|go|rs|py|java|rb|php|cs|cpp|c|h|hpp|swift|kt|md|mdx|json|ya?ml|toml|env|pem|key)$/i;
  let lastTrackedPage = '';

  function safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function isSensitiveSegment(segment: string, previousSegment?: string): boolean {
    const decoded = safeDecode(segment);
    return (
      emailRe.test(decoded) ||
      uuidRe.test(decoded) ||
      ulidRe.test(decoded) ||
      hexTokenRe.test(decoded) ||
      secretPrefixRe.test(decoded) ||
      longOpaqueSegmentRe.test(decoded) ||
      codebaseFileSegmentRe.test(decoded) ||
      (previousSegment !== undefined && sensitiveMarkerRe.test(previousSegment))
    );
  }

  function normalizePathname(pathname: string): string {
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return '/';
    const safeSegments = segments.map((segment, index) => {
      const previousSegment = index > 0 ? safeDecode(segments[index - 1] || '') : undefined;
      if (isSensitiveSegment(segment, previousSegment)) return redactedSegment;
      return encodeURIComponent(safeDecode(segment).slice(0, 80));
    });
    return `/${safeSegments.join('/')}`.replace(/\/+$/, '') || '/';
  }

  function toUrl(value: string): URL | null {
    try {
      return new URL(value);
    } catch (_) {
      try {
        return new URL(value, 'https://analytics.local');
      } catch (_) {
        return null;
      }
    }
  }

  function normalizePage(value: string): string {
    const url = toUrl(value);
    return url ? normalizePathname(url.pathname) : '';
  }

  function normalizeReferrer(value: string): string {
    const url = toUrl(value);
    if (!url || url.hostname === 'analytics.local') return normalizePage(value);
    const path = normalizePathname(url.pathname);
    return path === '/' ? url.origin : `${url.origin}${path}`;
  }

  function uid(store: Storage): string {
    try {
      const key = store === localStorage ? 'sam_analytics_visitor_id' : 'sam_analytics_session_id';
      const existing = store.getItem(key);
      if (existing) return existing;
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2);
      store.setItem(key, id);
      return id;
    } catch (_) {
      return '';
    }
  }

  const sessionId = uid(sessionStorage);
  const visitorId = uid(localStorage);

  function utmParam(name: string): string {
    try {
      return new URLSearchParams(location.search).get(name) ?? '';
    } catch (_) {
      return '';
    }
  }

  function send(events: AnalyticsEvent[]): void {
    const body = JSON.stringify({ events });
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(endpoint, blob);
    } else {
      fetch(endpoint, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
      }).catch(() => {});
    }
  }

  function trackPageView(): void {
    const page = normalizePage(location.pathname);
    if (!page || page === lastTrackedPage) return;
    lastTrackedPage = page;

    send([
      {
        event: 'page_view',
        page: page,
        referrer: normalizeReferrer(document.referrer || ''),
        host,
        utmSource: utmParam('utm_source'),
        utmMedium: utmParam('utm_medium'),
        utmCampaign: utmParam('utm_campaign'),
        sessionId,
        visitorId,
        entityId: '',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  // Track initial page view
  trackPageView();

  // Track Astro client-side navigations (View Transitions)
  document.addEventListener('astro:page-load', trackPageView);
})();
