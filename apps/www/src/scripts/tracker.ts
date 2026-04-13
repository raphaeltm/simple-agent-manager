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
    send([
      {
        event: 'page_view',
        page: location.pathname,
        referrer: document.referrer || '',
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
