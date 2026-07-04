import '@testing-library/jest-dom/vitest';

import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// Raise the testing-library async utility timeout (waitFor/findBy*) from the
// 1000ms default. Under `vitest run --coverage` on CPU-starved shared CI
// runners, instrumentation overhead can stretch a rerender→effect→fetch→
// setState chain past 1s of wall time, flaking tests that are structurally
// correct. This is deterministic waiting with a CI-realistic bound — NOT a
// retry mechanism. Env-tunable per constitution Principle XI.
const DEFAULT_ASYNC_UTIL_TIMEOUT_MS = 5000;
configure({
  asyncUtilTimeout: Number(process.env.SAM_TEST_ASYNC_UTIL_TIMEOUT_MS) || DEFAULT_ASYNC_UTIL_TIMEOUT_MS,
});

// Fail fast on unmocked network calls. jsdom ships a real fetch; components
// that fetch on mount would otherwise hit the real network, fail slowly, log
// noise ("Failed to load skills: fetch failed"), and leak background state
// updates into unrelated tests. Individual tests mock fetch explicitly.
globalThis.fetch = ((input: RequestInfo | URL) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(
    new Error(`Unmocked fetch: ${url} — mock this call in your test`)
  );
}) as typeof globalThis.fetch;

// jsdom does not implement window.matchMedia — stub it globally for useIsMobile hook
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom does not implement ResizeObserver — stub it globally for width-measuring components
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
