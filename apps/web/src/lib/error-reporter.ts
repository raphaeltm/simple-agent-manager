/**
 * Client-side error reporter.
 *
 * Batches errors and sends them to the control plane API so they appear
 * in Cloudflare Workers observability logs. Fire-and-forget — failed
 * reports are silently dropped.
 */

interface ErrorEntry {
  level: 'error' | 'warn' | 'info';
  message: string;
  source: string;
  stack?: string;
  url: string;
  userAgent: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface ErrorInfo {
  level?: 'error' | 'warn' | 'info';
  message: string;
  source: string;
  stack?: string;
  context?: Record<string, unknown>;
}

// --- Constants ---
const MAX_QUEUE_SIZE = 50;
const FLUSH_THRESHOLD = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_STACK_LENGTH = 4096;
const MAX_SOURCE_LENGTH = 256;

// --- Module state ---
let _apiUrl: string | null = null;
let _queue: ErrorEntry[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _isFlushing = false;
let _initialized = false;

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function enrich(info: ErrorInfo): ErrorEntry {
  return {
    level: info.level ?? 'error',
    message: truncate(info.message, MAX_MESSAGE_LENGTH),
    source: truncate(info.source, MAX_SOURCE_LENGTH),
    stack: info.stack ? truncate(info.stack, MAX_STACK_LENGTH) : undefined,
    url: typeof window !== 'undefined' ? window.location.href : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    timestamp: new Date().toISOString(),
    context: info.context,
  };
}

function flush(): void {
  if (_queue.length === 0 || _isFlushing || !_apiUrl) return;

  _isFlushing = true;
  const batch = _queue.splice(0, FLUSH_THRESHOLD);

  fetch(_apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ errors: batch }),
    keepalive: true,
  })
    .catch(() => {
      // Silently drop — best-effort telemetry
    })
    .finally(() => {
      _isFlushing = false;
    });
}

function flushBeacon(): void {
  if (_queue.length === 0 || !_apiUrl) return;

  const batch = _queue.splice(0, FLUSH_THRESHOLD);
  const blob = new Blob([JSON.stringify({ errors: batch })], {
    type: 'application/json',
  });
  navigator.sendBeacon(_apiUrl, blob);
}

function handleWindowError(event: ErrorEvent): void {
  reportError({
    level: 'error',
    message: event.message || 'Unknown error',
    source: 'window.onerror',
    stack: event.error?.stack,
    context: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
  });
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason = event.reason;
  reportError({
    level: 'error',
    message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled promise rejection'),
    source: 'unhandledrejection',
    stack: reason instanceof Error ? reason.stack : undefined,
  });
}

/**
 * Initialize the error reporter. Call once at app startup.
 */
export function initErrorReporter(apiUrl: string): void {
  if (_initialized) return;

  _apiUrl = apiUrl;
  _initialized = true;

  // Periodic flush
  _flushTimer = setInterval(flush, DEFAULT_FLUSH_INTERVAL_MS);

  // Flush remaining errors on page close
  window.addEventListener('beforeunload', flushBeacon);

  // Global error handlers
  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
}

/**
 * Report a client-side error. Queues the error for batched delivery.
 */
export function reportError(info: ErrorInfo): void {
  // Infinite loop guard: don't report errors from the reporter itself
  if (_isFlushing || info.source === 'error-reporter') return;
  if (!_initialized) return;

  const entry = enrich(info);

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
 * Convenience: report an Error object directly.
 */
export function reportRawError(
  error: Error,
  source: string,
  context?: Record<string, unknown>
): void {
  reportError({
    level: 'error',
    message: error.message,
    source,
    stack: error.stack,
    context,
  });
}

/**
 * Tear down the error reporter. Used in tests.
 */
export function destroyErrorReporter(): void {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  window.removeEventListener('beforeunload', flushBeacon);
  window.removeEventListener('error', handleWindowError);
  window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  _queue = [];
  _apiUrl = null;
  _initialized = false;
  _isFlushing = false;
}
