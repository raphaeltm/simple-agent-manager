import { Spinner } from '@simple-agent-manager/ui';

const DEFAULT_ROUTE_FALLBACK_REVEAL_DELAY_MS = 180;

const parsedRevealDelay = Number.parseInt(
  import.meta.env.VITE_ROUTE_FALLBACK_REVEAL_DELAY_MS ?? '',
  10
);
const REVEAL_DELAY_MS =
  Number.isFinite(parsedRevealDelay) && parsedRevealDelay >= 0
    ? parsedRevealDelay
    : DEFAULT_ROUTE_FALLBACK_REVEAL_DELAY_MS;

/**
 * Suspense fallback for lazily-loaded route chunks.
 *
 * Mounted only while a route's chunk is being fetched for the first time. Once the
 * chunk is in the module registry React resolves the lazy component without
 * re-suspending, so revisiting a route never shows this again.
 *
 * The spinner is held at `opacity: 0` for a short delay before fading in, so a chunk
 * that arrives quickly (warm HTTP cache, service-worker hit) renders with no visible
 * flash at all. The `.sam-route-fallback` class in `app.css` cancels both the animation
 * AND the reveal delay under `prefers-reduced-motion`, matching the `.char-fade`
 * convention in that file — the design system's global reduced-motion rule only
 * neutralises `animation-duration`, not `animation-delay`, so relying on it alone would
 * still leave reduced-motion users staring at an invisible spinner for the delay.
 *
 * No `role`/`aria-label` on this wrapper: `Spinner` already declares
 * `role="status" aria-label="Loading"` itself, and this now mounts on the first visit to
 * every one of ~90 routes, so a second nested status region would double-announce on
 * every navigation. (`ProtectedRoute` double-wraps; `AdminUsers` does not — the latter
 * is the correct precedent.)
 *
 * Per `.claude/rules/48-stale-while-revalidate-ui.md` this is scoped per route, so it
 * replaces only the route slot — the AppShell chrome and any parent layout stay mounted.
 */
export function RouteFallback() {
  return (
    <div
      className="sam-route-fallback flex items-center justify-center w-full min-w-0 py-16"
      data-testid="route-fallback"
      style={{
        animation: `sam-char-fade-in 200ms ease-out ${REVEAL_DELAY_MS}ms both`,
      }}
    >
      <Spinner size="lg" />
    </div>
  );
}
