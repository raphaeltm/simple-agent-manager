import { type ComponentType, lazy, type LazyExoticComponent } from 'react';

/**
 * Chunk-load resilience for route-level code splitting.
 *
 * Static assets are content-hashed with a long TTL, so a redeploy invalidates the
 * hashed filenames an already-open SPA session still holds in its module graph. When
 * the user then navigates to a route whose chunk has not been fetched yet, the dynamic
 * import 404s and — with no recovery — that navigation is permanently broken for the
 * rest of the session.
 *
 * The service worker cannot rescue this: `staleWhileRevalidate` in `src/sw.ts` only
 * caches `status === 200`, so a missing chunk is returned as the origin's 404 verbatim.
 *
 * Recovery ladder:
 *   1. retry the import once (cross-engine insurance — see the caveat below)
 *   2. reload the page once (fetches a fresh `index.html` with current hashes)
 *   3. rethrow so the global ErrorBoundary shows its recovery UI
 *
 * Step 2 is guarded by a `sessionStorage` marker so a chunk that is genuinely gone can
 * never produce a reload loop.
 *
 * Caveat on step 1, measured in Chromium via
 * `tests/playwright/lazy-route-chunks-audit.spec.ts`: the ES module map caches a failed
 * specifier for the lifetime of the document, so re-importing the SAME specifier returns
 * the cached rejection without issuing a second network request. The retry therefore
 * costs one delay and does not refetch on that engine; it is kept because the caching
 * behaviour is not uniform across engines and the cost is bounded to a single
 * `CHUNK_LOAD_RETRY_DELAY_MS` wait on an already-broken path. Step 2 is what actually
 * recovers the session — that is the rung the tests assert.
 */

const DEFAULT_CHUNK_LOAD_RETRY_DELAY_MS = 350;
const DEFAULT_CHUNK_RELOAD_COOLDOWN_MS = 15_000;

/**
 * Falls back to `fallback` when the env value is absent, non-numeric, or non-positive.
 *
 * The `NaN` case matters here specifically: the cooldown below is a safety guard, and
 * `x < NaN` is always false — so a malformed `VITE_CHUNK_RELOAD_COOLDOWN_MS` would
 * silently disable the reload-loop protection this module promises.
 */
function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CHUNK_LOAD_RETRY_DELAY_MS = positiveIntFromEnv(
  import.meta.env.VITE_CHUNK_LOAD_RETRY_DELAY_MS,
  DEFAULT_CHUNK_LOAD_RETRY_DELAY_MS
);

export const CHUNK_RELOAD_COOLDOWN_MS = positiveIntFromEnv(
  import.meta.env.VITE_CHUNK_RELOAD_COOLDOWN_MS,
  DEFAULT_CHUNK_RELOAD_COOLDOWN_MS
);

/** sessionStorage key holding the epoch-ms timestamp of the last chunk-recovery reload. */
export const CHUNK_RELOAD_MARKER_KEY = 'sam:chunk-reload-at';

/**
 * Error shapes emitted when a dynamic `import()` cannot be fetched or evaluated.
 * Each engine words this differently, so all of them must be matched.
 */
const CHUNK_LOAD_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // WebKit
  /failed to load module script/i, // Chromium, wrong MIME (SPA 404 → index.html)
  /expected a javascript(?:-or-wasm)? module script/i, // Chromium, wrong MIME (verbose form)
  /dynamically imported module/i, // defensive catch-all for engine rewording
] as const;

/**
 * True when `error` looks like a failed dynamic-import fetch rather than a genuine
 * runtime error thrown from inside the loaded module.
 *
 * This distinction is load-bearing: a real error inside a page component must surface
 * to the ErrorBoundary immediately. Reloading on it would hide the bug and could loop.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && 'name' in error && error.name === 'ChunkLoadError') {
    return true;
  }
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function readReloadMarker(): number | null {
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_MARKER_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Private mode / storage disabled. Treat as "already reloaded" so that a browser
    // where the marker cannot persist can never be put into a reload loop.
    return Number.POSITIVE_INFINITY;
  }
}

function writeReloadMarker(at: number): boolean {
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_MARKER_KEY, String(at));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reload once to pick up a fresh `index.html`.
 *
 * @returns `true` if a reload was triggered, `false` if the loop guard blocked it.
 */
function reloadForFreshChunks(): boolean {
  const now = Date.now();
  const lastReloadAt = readReloadMarker();
  if (lastReloadAt !== null && now - lastReloadAt < CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }
  if (!writeReloadMarker(now)) {
    return false;
  }
  window.location.reload();
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a dynamic-import loader with retry-then-reload recovery.
 *
 * When a reload is triggered the returned promise never settles — the document is being
 * torn down, and settling it would let React render a torn state during unload.
 */
export async function importWithRetry<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (firstError) {
    if (!isChunkLoadError(firstError)) throw firstError;

    await delay(CHUNK_LOAD_RETRY_DELAY_MS);

    try {
      return await loader();
    } catch (secondError) {
      if (!isChunkLoadError(secondError)) throw secondError;
      if (reloadForFreshChunks()) {
        return new Promise<T>(() => {
          /* deliberately never settles: the page is reloading */
        });
      }
      // Already reloaded once for this session — surface it instead of looping.
      throw secondError;
    }
  }
}

/**
 * Route components are rendered as bare route elements (`<Dashboard />`) and take no
 * props. Pinning the props type here keeps the wrapper compatible with `React.lazy`'s
 * `ComponentType<any>` constraint without introducing `any`, and makes a page that
 * grows required props fail at the call site rather than silently at runtime.
 *
 * If you hit a constraint error here because a page now needs data: thread it through
 * `useParams()` / router context / a provider rather than loosening this type. Route
 * elements have no caller that could supply props.
 */
type RouteComponent = ComponentType<Record<string, never>>;

/**
 * `React.lazy` for a module that exports the component under a **named** export,
 * wrapped in chunk-load recovery.
 *
 * Every page in `apps/web/src/pages/` uses named exports, so plain `React.lazy` (which
 * requires a `default`) cannot be used directly.
 */
export function lazyNamed<K extends PropertyKey, M extends Record<K, RouteComponent>>(
  loader: () => Promise<M>,
  exportName: K
): LazyExoticComponent<M[K]> {
  return lazy(async () => {
    const module = await importWithRetry(loader);
    return { default: module[exportName] };
  });
}
