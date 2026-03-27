/**
 * SAM Website Analytics Tracker
 *
 * Lightweight, privacy-respecting page view tracker for the marketing site.
 * Sends events to the SAM analytics ingest endpoint (POST /api/t).
 *
 * Usage: <script src="/scripts/tracker.js" data-api="https://api.example.com/api/t" defer></script>
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var endpoint = script && script.getAttribute('data-api');
  if (!endpoint) return;

  var host = location.hostname;

  function uid(store) {
    try {
      var existing = store.getItem('sam_id');
      if (existing) return existing;
      var id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2);
      store.setItem('sam_id', id);
      return id;
    } catch (_) {
      return '';
    }
  }

  var sessionId = uid(sessionStorage);
  var visitorId = uid(localStorage);

  function utmParam(name) {
    try {
      return new URLSearchParams(location.search).get(name) || '';
    } catch (_) {
      return '';
    }
  }

  function send(events) {
    var body = JSON.stringify({ events: events });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, body);
    } else {
      fetch(endpoint, {
        method: 'POST',
        body: body,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
      }).catch(function () {});
    }
  }

  function trackPageView() {
    send([
      {
        event: 'page_view',
        page: location.pathname,
        referrer: document.referrer || '',
        host: host,
        utmSource: utmParam('utm_source'),
        utmMedium: utmParam('utm_medium'),
        utmCampaign: utmParam('utm_campaign'),
        sessionId: sessionId,
        visitorId: visitorId,
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
