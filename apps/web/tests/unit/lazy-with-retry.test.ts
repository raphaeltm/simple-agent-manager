import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHUNK_RELOAD_MARKER_KEY,
  importWithRetry,
  isChunkLoadError,
} from '../../src/lib/lazy-with-retry';

/**
 * Regression coverage for the classic code-splitting production failure: content-hashed
 * assets plus a redeploy means an already-open session's lazy `import()` 404s, and
 * without recovery every not-yet-loaded route is permanently broken for that session.
 *
 * The discriminating requirement is the LOOP GUARD — a naive "reload on chunk error"
 * fix turns a genuinely missing chunk into an infinite reload cycle.
 */

const reload = vi.fn();

function chunkError(message: string): Error {
  return new TypeError(message);
}

beforeEach(() => {
  vi.useFakeTimers();
  reload.mockClear();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Advances fake timers until `promise` settles, so the internal retry delay elapses.
 *
 * Handlers are attached synchronously (before the first `await`) and the rejection is
 * re-thrown from a thunk, so a rejecting import is never momentarily unhandled while the
 * timers are being drained.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => () => value,
    (error: unknown) => () => {
      throw error;
    }
  );
  await vi.runAllTimersAsync();
  return (await outcome)();
}

describe('isChunkLoadError', () => {
  it.each([
    // VERIFIED against a real Chromium run: build the app, delete a route chunk from
    // dist/ so the SPA fallback serves index.html, then navigate. The *thrown* error is
    // exactly this. The remaining patterns are defensive.
    [
      'Chromium (verified thrown form)',
      'Failed to fetch dynamically imported module: https://app/assets/x-abc.js',
    ],
    [
      'Firefox (documented wording, not reproduced here)',
      'error loading dynamically imported module: https://app/assets/x-abc.js',
    ],
    ['WebKit (documented wording, not reproduced here)', 'Importing a module script failed.'],
    [
      // Chromium ALSO logs this to the console for the same SPA-fallback 404, but as a
      // diagnostic rather than the catchable rejection. Matched defensively in case an
      // engine surfaces the MIME complaint as the thrown error.
      'wrong-MIME diagnostic wording (defensive; not confirmed catchable)',
      'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
    ],
  ])('recognises the %s', (_engine, message) => {
    expect(isChunkLoadError(chunkError(message))).toBe(true);
  });

  it('recognises a ChunkLoadError by name even with an unfamiliar message', () => {
    const error = new Error('boom');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('does not treat a genuine runtime error from inside the module as a chunk failure', () => {
    expect(
      isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))
    ).toBe(false);
    expect(isChunkLoadError(new Error('useAuth must be used within an AuthProvider'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('importWithRetry', () => {
  it('returns the module and never reloads when the first import succeeds', async () => {
    const loader = vi.fn().mockResolvedValue({ Page: 'ok' });

    await expect(settle(importWithRetry(loader))).resolves.toEqual({ Page: 'ok' });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER_KEY)).toBeNull();
  });

  it('retries once and succeeds on a transient chunk fetch failure — no reload', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(chunkError('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ Page: 'ok' });

    await expect(settle(importWithRetry(loader))).resolves.toEqual({ Page: 'ok' });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads exactly once when the chunk is really gone, and records the marker', async () => {
    const loader = vi
      .fn()
      .mockRejectedValue(chunkError('Failed to fetch dynamically imported module'));

    let settled = false;
    void importWithRetry(loader).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.runAllTimersAsync();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER_KEY)).not.toBeNull();
    // The promise must stay pending: the document is being torn down, and settling it
    // would let React render a torn tree during unload.
    expect(settled).toBe(false);
  });

  it('LOOP GUARD: does not reload a second time within the cooldown — it rethrows instead', async () => {
    // Simulate "this session already reloaded to recover from a chunk 404".
    window.sessionStorage.setItem(CHUNK_RELOAD_MARKER_KEY, String(Date.now()));
    const loader = vi
      .fn()
      .mockRejectedValue(chunkError('Failed to fetch dynamically imported module'));

    await expect(settle(importWithRetry(loader))).rejects.toThrow(
      /Failed to fetch dynamically imported module/
    );

    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again once the cooldown has elapsed', async () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER_KEY,
      String(Date.now() - 24 * 60 * 60 * 1000)
    );
    const loader = vi
      .fn()
      .mockRejectedValue(chunkError('Failed to fetch dynamically imported module'));

    void importWithRetry(loader).catch(() => undefined);
    await vi.runAllTimersAsync();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rethrows a genuine module runtime error immediately — no retry, no reload', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('Cannot access X before initialization'));

    await expect(settle(importWithRetry(loader))).rejects.toThrow(
      /Cannot access X before initialization/
    );

    // Exactly one attempt: retrying/reloading on a real bug would hide it and could loop.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('rethrows when the retry surfaces a genuine module error rather than reloading', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(chunkError('Failed to fetch dynamically imported module'))
      .mockRejectedValueOnce(new Error('ReferenceError in page module'));

    await expect(settle(importWithRetry(loader))).rejects.toThrow(/ReferenceError in page module/);

    expect(reload).not.toHaveBeenCalled();
  });

  it('MALFORMED CONFIG: a non-numeric cooldown falls back to the default instead of NaN', async () => {
    // `x < NaN` is always false, so an unguarded parse would silently disable the
    // cooldown and reintroduce the reload loop the guard exists to prevent.
    vi.stubEnv('VITE_CHUNK_RELOAD_COOLDOWN_MS', 'not-a-number');
    vi.stubEnv('VITE_CHUNK_LOAD_RETRY_DELAY_MS', '');
    vi.resetModules();

    const reloaded = await import('../../src/lib/lazy-with-retry');
    expect(Number.isFinite(reloaded.CHUNK_RELOAD_COOLDOWN_MS)).toBe(true);
    expect(reloaded.CHUNK_RELOAD_COOLDOWN_MS).toBeGreaterThan(0);
    expect(Number.isFinite(reloaded.CHUNK_LOAD_RETRY_DELAY_MS)).toBe(true);

    // And the guard still actually guards with that fallback in place.
    window.sessionStorage.setItem(reloaded.CHUNK_RELOAD_MARKER_KEY, String(Date.now()));
    const loader = vi
      .fn()
      .mockRejectedValue(chunkError('Failed to fetch dynamically imported module'));

    await expect(settle(reloaded.importWithRetry(loader))).rejects.toThrow(
      /Failed to fetch dynamically imported module/
    );
    expect(reload).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('honours a valid numeric cooldown override', async () => {
    vi.stubEnv('VITE_CHUNK_RELOAD_COOLDOWN_MS', '777');
    vi.resetModules();

    const reloaded = await import('../../src/lib/lazy-with-retry');
    expect(reloaded.CHUNK_RELOAD_COOLDOWN_MS).toBe(777);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('never reloads when sessionStorage is unavailable (private mode) — fails closed', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled');
    });
    const loader = vi
      .fn()
      .mockRejectedValue(chunkError('Failed to fetch dynamically imported module'));

    await expect(settle(importWithRetry(loader))).rejects.toThrow(
      /Failed to fetch dynamically imported module/
    );

    expect(reload).not.toHaveBeenCalled();
    getItem.mockRestore();
  });
});
