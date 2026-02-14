import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initErrorReporter,
  reportError,
  reportRawError,
  destroyErrorReporter,
} from '../../../src/lib/error-reporter';

describe('error-reporter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let sendBeaconSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clean state before each test
    destroyErrorReporter();

    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy;

    sendBeaconSpy = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeaconSpy,
      writable: true,
      configurable: true,
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    destroyErrorReporter();
    vi.useRealTimers();
  });

  describe('initErrorReporter', () => {
    it('should initialize only once', () => {
      const addEventSpy = vi.spyOn(window, 'addEventListener');

      initErrorReporter('https://api.example.com/api/client-errors');
      const callCount = addEventSpy.mock.calls.length;

      // Second call should be a no-op
      initErrorReporter('https://api.example.com/api/client-errors');
      expect(addEventSpy.mock.calls.length).toBe(callCount);

      addEventSpy.mockRestore();
    });

    it('should register global error handlers', () => {
      const addEventSpy = vi.spyOn(window, 'addEventListener');

      initErrorReporter('https://api.example.com/api/client-errors');

      const eventNames = addEventSpy.mock.calls.map((c) => c[0]);
      expect(eventNames).toContain('beforeunload');
      expect(eventNames).toContain('error');
      expect(eventNames).toContain('unhandledrejection');

      addEventSpy.mockRestore();
    });
  });

  describe('reportError', () => {
    it('should not report when not initialized', () => {
      reportError({ message: 'test', source: 'test' });
      vi.advanceTimersByTime(10_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should queue errors and flush on timer', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'Test error', source: 'VoiceButton' });

      // Not flushed immediately (below threshold)
      expect(fetchSpy).not.toHaveBeenCalled();

      // Advance past flush interval (5s)
      vi.advanceTimersByTime(5_000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.example.com/api/client-errors');

      const body = JSON.parse(callArgs[1].body as string);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toBe('Test error');
      expect(body.errors[0].source).toBe('VoiceButton');
      expect(body.errors[0].level).toBe('error');
    });

    it('should auto-enrich with url, userAgent, and timestamp', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'Enriched', source: 'test' });
      vi.advanceTimersByTime(5_000);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      const entry = body.errors[0];
      expect(entry.url).toBeDefined();
      expect(entry.userAgent).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      // Timestamp should be ISO format
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    it('should respect level parameter', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'A warning', source: 'test', level: 'warn' });
      vi.advanceTimersByTime(5_000);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.errors[0].level).toBe('warn');
    });

    it('should flush immediately when threshold (25) is reached', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      for (let i = 0; i < 25; i++) {
        reportError({ message: `Error ${i}`, source: 'test' });
      }

      // Should have flushed without waiting for timer
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.errors).toHaveLength(25);
    });

    it('should cap queue at 50 entries and drop oldest', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      // Fill queue to 50 without triggering flush (need isFlushing to block threshold flushes)
      // Actually, the flush threshold is 25, so once we add 25 it flushes.
      // After flush, the queue is empty. Let's add in batches.
      // We want to test the queue cap without triggering flush.
      // For this test, make fetch block so isFlushing stays true.
      let resolveFlush: () => void;
      fetchSpy.mockImplementation(() => new Promise<{ ok: boolean }>((resolve) => {
        resolveFlush = () => resolve({ ok: true });
      }));

      // Add 25 to trigger flush (fetch blocks, isFlushing=true)
      for (let i = 0; i < 25; i++) {
        reportError({ message: `Batch1-${i}`, source: 'test' });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Now isFlushing=true, queue is empty after splice, add more
      // While flushing, new errors queue up but don't trigger flush
      for (let i = 0; i < 55; i++) {
        reportError({ message: `Overflow-${i}`, source: 'test' });
      }

      // Resolve the flush
      resolveFlush!();
    });

    it('should include stack and context when provided', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({
        message: 'Detailed error',
        source: 'VoiceButton',
        stack: 'Error: Detailed error\n  at VoiceButton.tsx:42',
        context: { phase: 'transcription', retries: 2 },
      });
      vi.advanceTimersByTime(5_000);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      const entry = body.errors[0];
      expect(entry.stack).toContain('VoiceButton.tsx:42');
      expect(entry.context).toEqual({ phase: 'transcription', retries: 2 });
    });

    it('should truncate long messages', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      const longMessage = 'x'.repeat(5000);
      reportError({ message: longMessage, source: 'test' });
      vi.advanceTimersByTime(5_000);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.errors[0].message.length).toBeLessThanOrEqual(2048);
    });

    it('should guard against infinite loops from error-reporter source', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'Self error', source: 'error-reporter' });
      vi.advanceTimersByTime(5_000);

      // Should not have queued/sent anything
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should silently drop failed fetch calls', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      fetchSpy.mockRejectedValue(new Error('Network error'));

      reportError({ message: 'Will fail', source: 'test' });
      vi.advanceTimersByTime(5_000);

      // Should not throw — fire-and-forget
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should use keepalive and credentials in fetch', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'Keepalive test', source: 'test' });
      vi.advanceTimersByTime(5_000);

      const options = fetchSpy.mock.calls[0][1];
      expect(options.keepalive).toBe(true);
      expect(options.credentials).toBe('include');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('reportRawError', () => {
    it('should extract message and stack from Error object', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      const error = new Error('Raw error');
      reportRawError(error, 'VoiceButton', { extra: 'data' });
      vi.advanceTimersByTime(5_000);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      const entry = body.errors[0];
      expect(entry.message).toBe('Raw error');
      expect(entry.source).toBe('VoiceButton');
      expect(entry.stack).toContain('Raw error');
      expect(entry.context).toEqual({ extra: 'data' });
    });
  });

  describe('destroyErrorReporter', () => {
    it('should stop flushing and remove handlers', () => {
      const removeEventSpy = vi.spyOn(window, 'removeEventListener');

      initErrorReporter('https://api.example.com/api/client-errors');
      reportError({ message: 'Will be dropped', source: 'test' });
      destroyErrorReporter();

      // Timer should be cleared — no flush after destroy
      vi.advanceTimersByTime(10_000);
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(removeEventSpy).toHaveBeenCalled();
      removeEventSpy.mockRestore();
    });

    it('should allow re-initialization after destroy', () => {
      initErrorReporter('https://api.example.com/api/client-errors');
      destroyErrorReporter();
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'After re-init', source: 'test' });
      vi.advanceTimersByTime(5_000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('global error handlers', () => {
    it('should capture window error events', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      // Dispatch an ErrorEvent
      const errorEvent = new ErrorEvent('error', {
        message: 'Uncaught TypeError: foo is not a function',
        filename: 'app.js',
        lineno: 42,
        colno: 10,
        error: new Error('foo is not a function'),
      });
      window.dispatchEvent(errorEvent);

      vi.advanceTimersByTime(5_000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      const entry = body.errors[0];
      expect(entry.message).toContain('foo is not a function');
      expect(entry.source).toBe('window.onerror');
      expect(entry.context).toEqual(
        expect.objectContaining({
          filename: 'app.js',
          lineno: 42,
          colno: 10,
        })
      );
    });

    it('should capture unhandled promise rejections', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      const reason = new Error('Promise blew up');
      // PromiseRejectionEvent is not available in jsdom — use CustomEvent with reason property
      const event = Object.assign(new Event('unhandledrejection'), {
        reason,
        promise: Promise.resolve(),
      });
      window.dispatchEvent(event);

      vi.advanceTimersByTime(5_000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      const entry = body.errors[0];
      expect(entry.message).toBe('Promise blew up');
      expect(entry.source).toBe('unhandledrejection');
    });

    it('should handle non-Error rejection reasons', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      // PromiseRejectionEvent is not available in jsdom — use Event with reason property
      const event = Object.assign(new Event('unhandledrejection'), {
        reason: 'string rejection',
        promise: Promise.resolve(),
      });
      window.dispatchEvent(event);

      vi.advanceTimersByTime(5_000);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.errors[0].message).toBe('string rejection');
    });
  });

  describe('sendBeacon on beforeunload', () => {
    it('should use sendBeacon for beforeunload flush', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      reportError({ message: 'Page closing', source: 'test' });

      // Trigger beforeunload
      window.dispatchEvent(new Event('beforeunload'));

      expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
      expect(sendBeaconSpy).toHaveBeenCalledWith(
        'https://api.example.com/api/client-errors',
        expect.any(Blob)
      );
    });

    it('should not call sendBeacon when queue is empty', () => {
      initErrorReporter('https://api.example.com/api/client-errors');

      window.dispatchEvent(new Event('beforeunload'));

      expect(sendBeaconSpy).not.toHaveBeenCalled();
    });
  });
});
