import '@testing-library/jest-dom/vitest';

import { vi } from 'vitest';

// jsdom does not implement window.matchMedia — stub it globally.
// The mock must support addEventListener/removeEventListener for useSyncExternalStore
// (used by useMediaQuery) to work correctly.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.add(cb);
      }),
      removeEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.delete(cb);
      }),
      dispatchEvent: vi.fn(),
    };
  }),
});
