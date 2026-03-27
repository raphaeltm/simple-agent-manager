/**
 * Client-side analytics tracker.
 *
 * Lightweight, first-party tracker that batches events and sends them to
 * the platform's own `/api/t` endpoint. Same-domain call — invisible to
 * ad blockers. Fire-and-forget — never blocks or crashes the UI.
 *
 * Usage:
 *   initAnalytics(apiUrl)      // once at app startup
 *   track('page_view', { page: '/dashboard' })
 *   setUserId(user.id)         // after auth
 */

interface AnalyticsEvent {
  event: string;
  page: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  sessionId: string;
  visitorId: string;
  entityId: string;
  durationMs: number;
  timestamp: string;
}

export interface TrackProps {
  page?: string;
  referrer?: string;
  entityId?: string;
  durationMs?: number;
  [key: string]: string | number | undefined;
}

// --- Constants ---
const MAX_QUEUE_SIZE = 100;
const FLUSH_THRESHOLD = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const SESSION_ID_KEY = 'sam_analytics_session_id';
const VISITOR_ID_KEY = 'sam_analytics_visitor_id';
const UTM_KEY = 'sam_analytics_utm';

// --- Module state ---
let _apiUrl: string | null = null;
let _queue: AnalyticsEvent[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _isFlushing = false;
let _initialized = false;
let _userId: string | null = null;
let _sessionId: string = '';
let _visitorId: string = '';
let _utmSource: string = '';
let _utmMedium: string = '';
let _utmCampaign: string = '';
let _initialReferrer: string = '';

// ---------------------------------------------------------------------------
// Session & visitor ID management
// ---------------------------------------------------------------------------

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Get or create a session ID. Stored in sessionStorage so it persists
 * across route changes but resets when the tab closes.
 */
function getOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const id = generateId();
    sessionStorage.setItem(SESSION_ID_KEY, id);
    return id;
  } catch {
    // sessionStorage unavailable (private browsing, etc.)
    return generateId();
  }
}

/**
 * Get or create a visitor ID. Stored in localStorage so it persists
 * across sessions for unauthenticated funnel analysis.
 */
function getOrCreateVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;
    const id = generateId();
    localStorage.setItem(VISITOR_ID_KEY, id);
    return id;
  } catch {
    return generateId();
  }
}

// ---------------------------------------------------------------------------
// UTM capture
// ---------------------------------------------------------------------------

interface UtmParams {
  source: string;
  medium: string;
  campaign: string;
}

/**
 * Extract UTM parameters from the current URL search string.
 * Persists in sessionStorage so they're available across route changes.
 */
function captureUtmParams(): UtmParams {
  try {
    // Check sessionStorage first (already captured this session)
    const cached = sessionStorage.getItem(UTM_KEY);
    if (cached) {
      return JSON.parse(cached) as UtmParams;
    }

    // Extract from current URL
    const params = new URLSearchParams(window.location.search);
    const utm: UtmParams = {
      source: params.get('utm_source') ?? '',
      medium: params.get('utm_medium') ?? '',
      campaign: params.get('utm_campaign') ?? '',
    };

    // Only persist if we found UTM params
    if (utm.source || utm.medium || utm.campaign) {
      sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
    }

    return utm;
  } catch {
    return { source: '', medium: '', campaign: '' };
  }
}

// ---------------------------------------------------------------------------
// Flush logic
// ---------------------------------------------------------------------------

function flush(): void {
  if (_queue.length === 0 || _isFlushing || !_apiUrl) return;

  _isFlushing = true;
  const batch = _queue.splice(0, FLUSH_THRESHOLD);

  fetch(_apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ events: batch }),
    keepalive: true,
  })
    .catch(() => {
      // Silently drop — best-effort telemetry
    })
    .finally(() => {
      _isFlushing = false;
      // If there are more events queued, flush again
      if (_queue.length >= FLUSH_THRESHOLD) {
        flush();
      }
    });
}

function flushBeacon(): void {
  if (_queue.length === 0 || !_apiUrl) return;

  const batch = _queue.splice(0, MAX_QUEUE_SIZE);
  const blob = new Blob([JSON.stringify({ events: batch })], {
    type: 'application/json',
  });
  navigator.sendBeacon(_apiUrl, blob);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the analytics tracker. Call once at app startup.
 */
export function initAnalytics(apiUrl: string): void {
  if (_initialized) return;

  _apiUrl = apiUrl;
  _initialized = true;

  // Initialize session & visitor IDs
  _sessionId = getOrCreateSessionId();
  _visitorId = getOrCreateVisitorId();

  // Capture UTMs from landing URL
  const utm = captureUtmParams();
  _utmSource = utm.source;
  _utmMedium = utm.medium;
  _utmCampaign = utm.campaign;

  // Capture initial referrer
  _initialReferrer = document.referrer ?? '';

  // Periodic flush
  _flushTimer = setInterval(flush, DEFAULT_FLUSH_INTERVAL_MS);

  // Flush on page visibility change (tab hidden) and unload
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushBeacon();
    }
  });
  window.addEventListener('pagehide', flushBeacon);
}

/**
 * Set the authenticated user ID. Called after login.
 * Pass null on logout to reset to visitor mode.
 */
export function setUserId(userId: string | null): void {
  _userId = userId;
}

/**
 * Track an analytics event. Queues it for batched delivery.
 */
export function track(event: string, props?: TrackProps): void {
  if (!_initialized) return;

  const entry: AnalyticsEvent = {
    event,
    page: props?.page ?? (typeof window !== 'undefined' ? window.location.pathname : ''),
    referrer: props?.referrer ?? '',
    utmSource: _utmSource,
    utmMedium: _utmMedium,
    utmCampaign: _utmCampaign,
    sessionId: _sessionId,
    visitorId: _userId ?? _visitorId,
    entityId: props?.entityId ?? '',
    durationMs: props?.durationMs ?? 0,
    timestamp: new Date().toISOString(),
  };

  // Cap queue size — drop oldest if full
  if (_queue.length >= MAX_QUEUE_SIZE) {
    _queue.shift();
  }

  _queue.push(entry);

  // Flush immediately if threshold reached
  if (_queue.length >= FLUSH_THRESHOLD) {
    flush();
  }
}

/**
 * Convenience: track a UI click/interaction.
 */
export function trackClick(elementName: string, props?: TrackProps): void {
  track('ui_click', { ...props, entityId: props?.entityId ?? elementName });
}

/**
 * Tear down the analytics tracker. Used in tests.
 */
export function destroyAnalytics(): void {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  _queue = [];
  _apiUrl = null;
  _initialized = false;
  _isFlushing = false;
  _userId = null;
  _sessionId = '';
  _visitorId = '';
  _utmSource = '';
  _utmMedium = '';
  _utmCampaign = '';
  _initialReferrer = '';
}

/**
 * Get the initial document.referrer captured at analytics initialization.
 * Used by PageViewTracker for the first page view.
 */
export function getInitialReferrer(): string {
  return _initialReferrer;
}
