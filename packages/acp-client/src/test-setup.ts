/**
 * Global test setup for jsdom environment.
 * Provides stubs for APIs that jsdom doesn't implement.
 */

import { configure } from '@testing-library/react';

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
