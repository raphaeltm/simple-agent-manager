/**
 * Global test setup for jsdom environment.
 * Provides stubs for APIs that jsdom doesn't implement.
 */

// ResizeObserver stub — individual tests can replace with richer mocks
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

// MutationObserver is provided by jsdom, but add a guard just in case
if (typeof globalThis.MutationObserver === 'undefined') {
  globalThis.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof globalThis.MutationObserver;
}
