import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoScroll } from './useAutoScroll';

// =============================================================================
// Test helpers — jsdom doesn't implement layout/scrolling, so we mock geometry
// =============================================================================

function createMockScrollContainer(opts: {
  scrollHeight?: number;
  clientHeight?: number;
  scrollTop?: number;
} = {}): HTMLDivElement {
  const el = document.createElement('div');

  let _scrollTop = opts.scrollTop ?? 0;
  let _scrollHeight = opts.scrollHeight ?? 1000;
  const _clientHeight = opts.clientHeight ?? 500;

  Object.defineProperty(el, 'scrollHeight', {
    get: () => _scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    get: () => _clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: (val: number) => { _scrollTop = val; },
    configurable: true,
  });

  // Expose a setter for tests to simulate content growth
  (el as ScrollMock).__setScrollHeight = (h: number) => { _scrollHeight = h; };
  (el as ScrollMock).__setScrollTop = (v: number) => { _scrollTop = v; };

  return el;
}

interface ScrollMock extends HTMLDivElement {
  __setScrollHeight: (h: number) => void;
  __setScrollTop: (v: number) => void;
}

// =============================================================================
// Mock ResizeObserver & MutationObserver
// =============================================================================

type ROInstance = { callback: ResizeObserverCallback; elements: Element[]; trigger(): void; disconnect(): void };
type MOInstance = { callback: MutationCallback; trigger(mutations: Partial<MutationRecord>[]): void; disconnect(): void };

let roInstances: ROInstance[] = [];
let moInstances: MOInstance[] = [];

class MockResizeObserver {
  callback: ResizeObserverCallback;
  elements: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    roInstances.push(this as unknown as ROInstance);
  }
  observe(el: Element) { this.elements.push(el); }
  unobserve() {}
  disconnect() { this.elements = []; }
  trigger() { this.callback([] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
}

class MockMutationObserver {
  callback: MutationCallback;
  constructor(callback: MutationCallback) {
    this.callback = callback;
    moInstances.push(this as unknown as MOInstance);
  }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
  trigger(mutations: Partial<MutationRecord>[]) {
    this.callback(mutations as MutationRecord[], this as unknown as MutationObserver);
  }
}

// =============================================================================
// Test suite
// =============================================================================

describe('useAutoScroll', () => {
  let origRO: typeof ResizeObserver;
  let origMO: typeof MutationObserver;
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    origRO = globalThis.ResizeObserver;
    origMO = globalThis.MutationObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;
    roInstances = [];
    moInstances = [];
    rafCallbacks = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = origRO;
    globalThis.MutationObserver = origMO;
    vi.restoreAllMocks();
  });

  function flushRaf() {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) cb(performance.now());
  }

  /** Attach a container to the hook via the callback ref */
  function attach(result: { current: ReturnType<typeof useAutoScroll> }, el: HTMLDivElement) {
    act(() => { result.current.scrollRef(el); });
  }

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  it('returns isAtBottom=true initially', () => {
    const { result } = renderHook(() => useAutoScroll());
    expect(result.current.isAtBottom).toBe(true);
  });

  it('returns a scrollRef callback', () => {
    const { result } = renderHook(() => useAutoScroll());
    expect(typeof result.current.scrollRef).toBe('function');
  });

  it('returns a scrollToBottom function', () => {
    const { result } = renderHook(() => useAutoScroll());
    expect(typeof result.current.scrollToBottom).toBe('function');
  });

  // ---------------------------------------------------------------------------
  // Scroll position tracking
  // ---------------------------------------------------------------------------

  it('detects when user scrolls away from bottom', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    attach(result, el);

    // Currently at bottom (1000 - 500 - 500 = 0)
    expect(result.current.isAtBottom).toBe(true);

    // User scrolls up
    act(() => {
      el.__setScrollTop(100);
      el.dispatchEvent(new Event('scroll'));
    });

    // distance = 1000 - 100 - 500 = 400 > 50
    expect(result.current.isAtBottom).toBe(false);
  });

  it('detects when user scrolls back to bottom', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500 }) as ScrollMock;
    attach(result, el);

    // Scroll up
    act(() => {
      el.__setScrollTop(100);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    // Scroll back to bottom
    act(() => {
      el.__setScrollTop(500);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);
  });

  it('uses threshold for near-bottom detection', () => {
    const { result } = renderHook(() => useAutoScroll({ bottomThreshold: 50 }));
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500 }) as ScrollMock;
    attach(result, el);

    // Within threshold: distance = 1000 - 460 - 500 = 40 <= 50
    act(() => {
      el.__setScrollTop(460);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);

    // Outside threshold: distance = 1000 - 440 - 500 = 60 > 50
    act(() => {
      el.__setScrollTop(440);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);
  });

  it('respects custom bottomThreshold', () => {
    const { result } = renderHook(() => useAutoScroll({ bottomThreshold: 100 }));
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500 }) as ScrollMock;
    attach(result, el);

    // Within 100px: distance = 1000 - 410 - 500 = 90 <= 100
    act(() => {
      el.__setScrollTop(410);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);

    // Outside: distance = 1000 - 390 - 500 = 110 > 100
    act(() => {
      el.__setScrollTop(390);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);
  });

  it('handles exactly-at-threshold scroll position', () => {
    const { result } = renderHook(() => useAutoScroll({ bottomThreshold: 50 }));
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500 }) as ScrollMock;
    attach(result, el);

    // Exactly at: distance = 1000 - 450 - 500 = 50 <= 50
    act(() => {
      el.__setScrollTop(450);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);

    // One pixel beyond: distance = 51 > 50
    act(() => {
      el.__setScrollTop(449);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // scrollToBottom
  // ---------------------------------------------------------------------------

  it('scrollToBottom scrolls the container and sets isAtBottom=true', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500 }) as ScrollMock;
    attach(result, el);

    // Scroll up
    act(() => {
      el.__setScrollTop(100);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    // scrollToBottom
    act(() => { result.current.scrollToBottom(); });

    expect(el.scrollTop).toBe(1000);
    expect(result.current.isAtBottom).toBe(true);
  });

  it('scrollToBottom is a no-op when no element is attached', () => {
    const { result } = renderHook(() => useAutoScroll());
    // No element attached — should not throw
    act(() => { result.current.scrollToBottom(); });
    expect(result.current.isAtBottom).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Auto-scroll on content growth (ResizeObserver)
  // ---------------------------------------------------------------------------

  it('auto-scrolls when content grows and user is at bottom', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    const child = document.createElement('div');
    el.appendChild(child);
    attach(result, el);

    // User is at bottom (distance = 0)
    // Content grows
    el.__setScrollHeight(1200);

    act(() => {
      roInstances[0]?.trigger();
      flushRaf();
    });

    expect(el.scrollTop).toBe(1200);
  });

  it('does NOT auto-scroll when content grows and user is scrolled up', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 100 }) as ScrollMock;
    const child = document.createElement('div');
    el.appendChild(child);
    attach(result, el);

    // Mark scrolled up
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    // Content grows
    el.__setScrollHeight(1200);
    act(() => {
      roInstances[0]?.trigger();
      flushRaf();
    });

    // Should NOT have scrolled
    expect(el.scrollTop).toBe(100);
  });

  // ---------------------------------------------------------------------------
  // Auto-scroll on new children (MutationObserver)
  // ---------------------------------------------------------------------------

  it('auto-scrolls when new child elements are added and user is at bottom', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    attach(result, el);

    // Content grows due to new message
    el.__setScrollHeight(1300);
    const newChild = document.createElement('div');

    act(() => {
      moInstances[0]?.trigger([{
        addedNodes: [newChild] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      }]);
      flushRaf();
    });

    expect(el.scrollTop).toBe(1300);
  });

  it('does NOT auto-scroll on mutation when user is scrolled up', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 100 }) as ScrollMock;
    attach(result, el);

    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(result.current.isAtBottom).toBe(false);

    el.__setScrollHeight(1300);
    const newChild = document.createElement('div');

    act(() => {
      moInstances[0]?.trigger([{
        addedNodes: [newChild] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      }]);
      flushRaf();
    });

    expect(el.scrollTop).toBe(100);
  });

  it('observes the container (not individual children) with ResizeObserver', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    attach(result, el);

    // ResizeObserver should observe the container element itself
    expect(roInstances[0]?.elements).toContain(el);
    // Only one element should be observed (the container)
    expect(roInstances[0]?.elements).toHaveLength(1);
  });

  it('ignores non-Element nodes in MutationObserver (text nodes)', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    attach(result, el);

    const textNode = document.createTextNode('hello');

    // Should not throw
    act(() => {
      moInstances[0]?.trigger([{
        addedNodes: [textNode] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      }]);
      flushRaf();
    });

    // Auto-scroll still works (at bottom)
    expect(el.scrollTop).toBe(1000);
  });

  // ---------------------------------------------------------------------------
  // Re-engagement after scrollToBottom
  // ---------------------------------------------------------------------------

  it('re-engages auto-scroll after scrollToBottom', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 100 }) as ScrollMock;
    const child = document.createElement('div');
    el.appendChild(child);
    attach(result, el);

    // Scrolled up
    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(result.current.isAtBottom).toBe(false);

    // User clicks "scroll to bottom"
    act(() => { result.current.scrollToBottom(); });
    expect(result.current.isAtBottom).toBe(true);

    // Content grows
    el.__setScrollHeight(1500);
    act(() => {
      roInstances[0]?.trigger();
      flushRaf();
    });

    // Should auto-scroll again
    expect(el.scrollTop).toBe(1500);
  });

  // ---------------------------------------------------------------------------
  // Multiple rapid scroll events
  // ---------------------------------------------------------------------------

  it('handles multiple rapid scroll events correctly', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    attach(result, el);

    // Rapid scroll up (momentum scrolling)
    act(() => {
      el.__setScrollTop(400); el.dispatchEvent(new Event('scroll'));
      el.__setScrollTop(300); el.dispatchEvent(new Event('scroll'));
      el.__setScrollTop(200); el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    // Rapid scroll back to bottom
    act(() => {
      el.__setScrollTop(300); el.dispatchEvent(new Event('scroll'));
      el.__setScrollTop(400); el.dispatchEvent(new Event('scroll'));
      el.__setScrollTop(500); el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('handles container with no overflow (content fits)', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({
      scrollHeight: 300, // smaller than clientHeight
      clientHeight: 500,
      scrollTop: 0,
    }) as ScrollMock;
    attach(result, el);

    act(() => { el.dispatchEvent(new Event('scroll')); });

    // distance = 300 - 0 - 500 = -200 <= 50 → at bottom
    expect(result.current.isAtBottom).toBe(true);
  });

  it('cleans up observers when element changes', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el1 = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    const child1 = document.createElement('div');
    el1.appendChild(child1);
    attach(result, el1);

    const ro1 = roInstances[0]!;
    const disconnectSpy = vi.fn();
    ro1.disconnect = disconnectSpy;

    // Attach a different element — old observers should disconnect
    const el2 = createMockScrollContainer({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 }) as ScrollMock;
    attach(result, el2);

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('cleans up observers when element is detached (null)', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    const child = document.createElement('div');
    el.appendChild(child);
    attach(result, el);

    const ro = roInstances[0]!;
    const disconnectSpy = vi.fn();
    ro.disconnect = disconnectSpy;

    // Detach (null)
    act(() => { result.current.scrollRef(null); });

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('observes the container on attach regardless of child count', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }) as ScrollMock;
    const child1 = document.createElement('div');
    const child2 = document.createElement('div');
    el.appendChild(child1);
    el.appendChild(child2);

    attach(result, el);

    // Only the container should be observed, not individual children
    expect(roInstances[0]?.elements).toHaveLength(1);
    expect(roInstances[0]?.elements).toContain(el);
  });

  it('defaults to bottom threshold of 50', () => {
    const { result } = renderHook(() => useAutoScroll());
    const el = createMockScrollContainer({ scrollHeight: 1000, clientHeight: 500 }) as ScrollMock;
    attach(result, el);

    // 50px from bottom: distance = 1000 - 450 - 500 = 50 <= 50
    act(() => {
      el.__setScrollTop(450);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);

    // 51px from bottom: distance = 51 > 50
    act(() => {
      el.__setScrollTop(449);
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);
  });
});
