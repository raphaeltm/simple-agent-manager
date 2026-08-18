import { Spinner } from '@simple-agent-manager/ui';

const DEFAULT_ROUTE_FALLBACK_REVEAL_DELAY_MS = 180;

const REVEAL_DELAY_MS = Number.parseInt(
  import.meta.env.VITE_ROUTE_FALLBACK_REVEAL_DELAY_MS ||
    String(DEFAULT_ROUTE_FALLBACK_REVEAL_DELAY_MS),
  10
);

/**
 * Suspense fallback for lazily-loaded route chunks.
 *
 * Mounted only while a route's chunk is being fetched for the first time. Once the
 * chunk is in the module registry React resolves the lazy component without
 * re-suspending, so revisiting a route never shows this again.
 *
 * The spinner is held at `opacity: 0` for a short delay before fading in, so a chunk
 * that arrives quickly (warm HTTP cache, service-worker hit) renders with no visible
 * flash at all. `sam-char-fade-in` is the existing fade keyframe from `app.css`.
 *
 * Per `.claude/rules/48-stale-while-revalidate-ui.md` this is scoped per route, so it
 * replaces only the route slot — the AppShell chrome and any parent layout stay mounted.
 */
export function RouteFallback() {
  return (
    <div
      className="flex items-center justify-center w-full min-w-0 py-16"
      role="status"
      aria-label="Loading page"
      data-testid="route-fallback"
      style={{
        animation: `sam-char-fade-in 200ms ease-out ${REVEAL_DELAY_MS}ms both`,
      }}
    >
      <Spinner size="lg" />
    </div>
  );
}
