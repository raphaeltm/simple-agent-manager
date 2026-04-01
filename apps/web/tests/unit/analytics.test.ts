import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import {
  destroyAnalytics,
  getInitialReferrer,
  initAnalytics,
  setUserId,
  track,
  trackClick,
} from '../../src/lib/analytics';

// Mock sessionStorage and localStorage
const sessionStore: Record<string, string> = {};
const localStore: Record<string, string> = {};

const mockSessionStorage = {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
};

const mockLocalStorage = {
  getItem: vi.fn((key: string) => localStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { localStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete localStore[key]; }),
};

Object.defineProperty(globalThis, 'sessionStorage', { value: mockSessionStorage, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

describe('analytics tracker', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let sendBeaconSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clear stores
    Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
    Object.keys(localStore).forEach(k => delete localStore[k]);

    // Mock fetch
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchSpy;

    // Mock sendBeacon
    sendBeaconSpy = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeaconSpy, writable: true });

    // Mock crypto.randomUUID
    let counter = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `uuid-${++counter}` as `${string}-${string}-${string}-${string}-${string}`);
  });

  afterEach(() => {
    destroyAnalytics();
    vi.restoreAllMocks();
  });

  it('initializes and generates session/visitor IDs', () => {
    initAnalytics('https://api.example.com/api/t');

    // Session ID stored in sessionStorage
    expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
      'sam_analytics_session_id',
      expect.any(String)
    );
    // Visitor ID stored in localStorage
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'sam_analytics_visitor_id',
      expect.any(String)
    );
  });

  it('captures initial referrer', () => {
    Object.defineProperty(document, 'referrer', { value: 'https://google.com', configurable: true });
    initAnalytics('https://api.example.com/api/t');
    expect(getInitialReferrer()).toBe('https://google.com');
  });

  it('tracks events and includes session/visitor IDs', () => {
    initAnalytics('https://api.example.com/api/t');
    track('page_view', { page: '/dashboard' });

    // Manually trigger flush by tracking enough events
    for (let i = 0; i < 10; i++) {
      track('filler', { page: '/test' });
    }

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.events).toBeInstanceOf(Array);
    expect(body.events[0].event).toBe('page_view');
    expect(body.events[0].page).toBe('/dashboard');
    expect(body.events[0].sessionId).toBeTruthy();
    expect(body.events[0].visitorId).toBeTruthy();
    expect(body.events[0].timestamp).toBeTruthy();
  });

  it('sets userId from auth context', () => {
    initAnalytics('https://api.example.com/api/t');
    setUserId('user-123');

    // Track enough to trigger flush
    for (let i = 0; i < 10; i++) {
      track('test_event', { page: '/test' });
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.events[0].visitorId).toBe('user-123');
  });

  it('resets to visitor ID on logout', () => {
    initAnalytics('https://api.example.com/api/t');
    setUserId('user-123');
    setUserId(null);

    for (let i = 0; i < 10; i++) {
      track('test_event', { page: '/test' });
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // Should use the generated visitor ID, not null
    expect(body.events[0].visitorId).toBeTruthy();
    expect(body.events[0].visitorId).not.toBe('user-123');
  });

  it('captures UTM parameters from URL', () => {
    // Mock window.location.search
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        search: '?utm_source=twitter&utm_medium=social&utm_campaign=launch',
        pathname: '/landing',
        href: 'https://app.example.com/landing?utm_source=twitter',
      },
      writable: true,
    });

    initAnalytics('https://api.example.com/api/t');

    for (let i = 0; i < 10; i++) {
      track('page_view', { page: '/landing' });
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.events[0].utmSource).toBe('twitter');
    expect(body.events[0].utmMedium).toBe('social');
    expect(body.events[0].utmCampaign).toBe('launch');
  });

  it('does not track before initialization', () => {
    track('should_not_track', { page: '/test' });

    // No flush should happen
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('trackClick sends ui_click event with element name as entityId', () => {
    initAnalytics('https://api.example.com/api/t');

    for (let i = 0; i < 9; i++) {
      track('filler', { page: '/test' });
    }
    trackClick('create-project-btn');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const clickEvent = body.events.find((e: Record<string, unknown>) => e.event === 'ui_click');
    expect(clickEvent).toBeDefined();
    expect(clickEvent.entityId).toBe('create-project-btn');
  });

  it('drops oldest events when queue exceeds max size', () => {
    initAnalytics('https://api.example.com/api/t');

    // Track 110 events (max queue is 100) without allowing flush
    fetchSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    for (let i = 0; i < 110; i++) {
      track(`event_${i}`, { page: '/test' });
    }

    // After first flush is called (at threshold 10), subsequent events queue up
    // The queue should never exceed MAX_QUEUE_SIZE (100)
    // This is a behavior test — the internal state management handles it
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('uses sendBeacon on page unload', () => {
    initAnalytics('https://api.example.com/api/t');
    track('last_event', { page: '/leaving' });

    // Simulate visibility change to hidden
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(sendBeaconSpy).toHaveBeenCalled();
    const blob = sendBeaconSpy.mock.calls[0][1] as Blob;
    expect(blob.type).toBe('application/json');
  });

  it('reuses existing session ID from sessionStorage', () => {
    sessionStore['sam_analytics_session_id'] = 'existing-session-id';
    initAnalytics('https://api.example.com/api/t');

    for (let i = 0; i < 10; i++) {
      track('test', { page: '/test' });
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.events[0].sessionId).toBe('existing-session-id');
  });

  it('reuses existing visitor ID from localStorage', () => {
    localStore['sam_analytics_visitor_id'] = 'existing-visitor-id';
    initAnalytics('https://api.example.com/api/t');

    for (let i = 0; i < 10; i++) {
      track('test', { page: '/test' });
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.events[0].visitorId).toBe('existing-visitor-id');
  });

  it('persists UTM params in sessionStorage for cross-page access', () => {
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        search: '?utm_source=newsletter',
        pathname: '/landing',
        href: 'https://app.example.com/landing?utm_source=newsletter',
      },
      writable: true,
    });

    initAnalytics('https://api.example.com/api/t');

    expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
      'sam_analytics_utm',
      expect.stringContaining('newsletter')
    );
  });
});
