# Frontend Query Cache and Rotation Resilience

## Problem

The authenticated control-plane UI feels slow because responsive transitions and route navigation often restart component-local fetches instead of reusing already-loaded data. The clearest production symptom is phone rotation: rotating a 390×844 phone to 844×390 crosses the app's 767px breakpoint and can unmount the routed page subtree, destroying local state and triggering fresh loaders.

The current production deployment (`71e97323ee499743df099aa5cdca9867e5a87b30`) matches the audited `main` commit, so this is present in the live code rather than only a local hypothesis.

## Research Findings

### Dispatched SOL research

- `01KZF578YJ1JG4APXDA4J29EYX`: confirmed that `apps/web/src/components/AppShell.tsx` swaps structurally different mobile and desktop sibling trees. The routed `<main>` occupies different reconciliation positions, so a breakpoint transition discards the page/chat subtree while the root QueryClient and AuthProvider remain mounted.
- `01KZF57GTQW3Q6RW3JPP47QRM2`: recommended shared in-memory TanStack Query caching and intent prefetch first. Persisting the entire QueryClient is unsafe; any browser persistence must be a per-user allowlist with logout/account-switch cleanup, version busting, and sensitive-data exclusions.
- `01KZF57MDCMN7KT94MFSDEF5C5`: recommended converging destination reads on shared query keys before prefetching, then using bounded hover/focus/touch intent prefetch. Recommended a delayed decorative top-edge indicator for background refetches only.

The original Instant dispatches (`01KZF559Y5BF6D5900W4RFP04C`, `01KZF55E37QM2Z8NMPD63PVQF1`, `01KZF55HMGDQKRW5EVB2QW9A4Z`) failed before agent startup because SAM attempted to clone unpushed generated branches. Corrected retries explicitly checked out remote `main`.

### Baseline code evidence at `71e97323e`

- `apps/web/src/components/AppShell.tsx` branched on `useIsMobile()`. The mobile routed `<main>` was the third root child; the desktop routed `<main>` followed the sidebar. Without stable sibling identity, React unmounted it when crossing the breakpoint.
- `apps/web/src/hooks/useProjectData.ts` used component-local `useState`/`useEffect` loaders. `AppShell`, `Dashboard`, and `Projects` mounted independent `useProjectList({ limit: 50 })` instances, causing duplicate requests and independent polling for the same data.
- `apps/web/src/pages/Project.tsx` hand-loaded project detail and blocked the child outlet on the first request. A project-card prefetch could not help until the destination read the same shared cache key.
- TanStack Query v5.101.2 was already configured in `apps/web/src/lib/query-client.ts`, but only Nodes, Workspaces, and AdminDiagnosis used it.
- `tasks/archive/2026-08-05-namespace-library-cache-by-user.md` documents a real cross-user metadata leak from un-namespaced `localStorage`. Generic persisted query caching must not repeat that failure.
- The service worker caches the app shell and static assets, not authenticated API responses, so it does not provide data reuse across remounts.

### Official documentation

- TanStack Query prefetching: https://tanstack.com/query/latest/docs/framework/react/guides/prefetching
- TanStack Query `useQuery` cache lifetime: https://tanstack.com/query/latest/docs/framework/react/reference/useQuery
- TanStack Query persistence and cache busting: https://tanstack.com/query/v5/docs/framework/react/plugins/persistQueryClient

## UI Variants Considered

1. **Delayed top-edge activity line** — global, layout-neutral, visible on mobile and desktop, and does not compete with page content.
2. **Compact “Refreshing” chrome pill** — clearer text but consumes scarce mobile-header space and can become noisy during polling.
3. **Per-section spinners only** — precise but inconsistent across pages and cannot cover shared prefetch/background work.

Selected: variant 1, with a screen-reader status message. Existing local spinners remain where they already add useful section-level context.

## Selected First PR

This PR deliberately combines the direct rotation fix with the smallest cache/prefetch slice that has cross-UI leverage:

- Preserve routed content identity across AppShell mobile/desktop breakpoint transitions.
- Move project list and project detail reads onto shared TanStack Query option/key factories.
- Deduplicate the project list used by AppShell, Dashboard, and Projects.
- Prefetch project detail on hover, keyboard focus, and touch intent from project cards and sidebar entries.
- Keep stale project data visible during background revalidation.
- Show a delayed, unobtrusive global indicator only when cached query data is being refreshed.
- Keep initial project-list failures truthful in both the page and desktop sidebar instead of presenting failed data as an empty list.
- Make list limits, polling cadence, hover dwell, and background-indicator delay build-time configurable with shared validated defaults.
- Namespace every authenticated query key migrated in this PR by user identity, gate protected
  rendering during identity transitions, and clear the previous in-memory
  namespace.
- Capture broader query migration and safe persistence as explicit follow-up work.

## Implementation Checklist

- [x] Add a failing AppShell regression test proving breakpoint changes preserve child mount/state.
- [x] Give the shared routed `<main>` stable identity across the mobile and desktop shell branches.
- [x] Add shared project list/detail/GitHub-installation query keys and query options.
- [x] Migrate `useProjectList` and `useProjectDetail` to TanStack Query while preserving their return-value shapes and updating callers for required identity scope.
- [x] Migrate the `Project` parent to cached detail/installation data and keep the outlet visible on background errors/refetches.
- [x] Add bounded project-detail intent prefetch from project cards and sidebar project buttons.
- [x] Add a delayed global background-fetch indicator above AppShell.
- [x] Centralize and document configuration-backed project list/poll/prefetch/indicator defaults and pass their overrides through canonical deployments.
- [x] Identity-scope the migrated project/installations query keys, gate clean signout/session-expiry/account-switch transitions, and preserve the active namespace through transient same-user auth refetch errors.
- [x] Add unit tests for deduplication, cache reuse, stale-data preservation, auth cleanup, indicator behavior, and intent prefetch.
- [x] Add Playwright coverage for portrait→landscape rotation, request counts, indicator rendering, overflow, and mobile/desktop screenshots.
- [x] Update Rule 48 with responsive-shell identity and authenticated-query isolation requirements.
- [x] Run full validation, specialist reviews, and staging verification.
- [x] Create draft PR #1769 without merging.

## Acceptance Criteria

- Rotating across 767px does not remount the routed page/chat subtree or discard its local state.
- AppShell plus Dashboard/Projects issue one initial project-list request for the shared key, not duplicate requests.
- Re-entering a recently loaded project/list surface renders cached data immediately; stale data remains visible while revalidation runs.
- Hover/focus/touch intent on a project destination populates the exact query key consumed by `Project`.
- Background revalidation shows a subtle top-edge activity cue without replacing visible content or changing layout.
- Initial project-list failures never render a contradictory empty state in the page or sidebar.
- Project and GitHub-installation queries migrated here are identity-scoped; clean auth identity changes cannot
  render the previous account's data even for one frame, while transient
  same-user auth refetch errors preserve the active cache.
- No generic QueryClient data is written to `localStorage` or `sessionStorage` in this PR.
- Mobile and desktop visual/behavioral checks pass with no horizontal overflow.

## Out of Scope

- Migrating every remaining hand-rolled loader in one PR.
- Persisting authenticated query data across full document reloads.
- Prefetching chat histories, messages, logs, diagnostics, credentials, secrets, environment values, or large file/library payloads.

## Bug Post-Mortem

### What broke

Rotating a phone from portrait to landscape across the 767px breakpoint remounted the routed page subtree, discarded its local state, and restarted project fetches. Shared project surfaces also issued independent component-local requests instead of converging on one cache entry.

### Root cause

Commit `5ca21242d` (`feat(web): UI/UX overhaul — design system, navigation, and polish (spec 019) (#149)`) introduced the responsive `AppShell` with structurally different mobile and desktop child lists. The routed `<main>` occupied different unkeyed reconciliation positions across those branches. Existing component-local `useState`/`useEffect` project loaders then had no shared server-state cache to reuse after the remount.

### Timeline

- **2026-02-22:** `5ca21242d` introduced the separate responsive AppShell branches and positional routed subtree; later shell changes retained the identity problem.
- **2026-08-07:** The phone-rotation reload and broader frontend slowness were reported. Baseline inspection at `71e97323e` reproduced the code path, and dispatched research isolated the reconciliation/cache causes.
- **2026-08-07 to 2026-08-08:** The fix moved project server state to shared user-scoped queries, stabilized responsive child identity, added bounded prefetch/background activity UI, and passed local specialist/behavioral review.
- **2026-08-08:** Exact SHA `9e2d86565` deployed to staging; authenticated iPhone and mouse/keyboard Playwright checks verified the rotation, prefetch, and stale-revalidation paths.

### Class of bug

Responsive reconciliation identity loss combined with duplicated component-local server state.

### Why it was not caught

The suite exercised mobile and desktop layouts independently, but did not resize one mounted authenticated tree across the breakpoint while counting requests. It also lacked a shared-query contract test spanning AppShell, Dashboard, and Projects.

### Process fix included in this PR

`.claude/rules/48-stale-while-revalidate-ui.md` now requires stable responsive subtree identity, authenticated query-key isolation, cleanup/gating during identity transitions, and exact-key convergence before prefetching. The Playwright audit adds a portrait-to-landscape request-count regression.

### Post-mortem file

This task is the durable post-mortem record and will be archived at `tasks/archive/2026-08-07-frontend-query-cache-and-rotation-resilience.md` when the draft PR is opened.

## Validation Evidence

- `pnpm typecheck` — 16/16 tasks passed.
- `pnpm lint` — 7/7 tasks passed with zero errors; existing warning baseline remains.
- `pnpm --filter @simple-agent-manager/web test` — 240 files and 2,903 tests passed.
- `pnpm build` — 9/9 tasks passed.
- `pnpm exec vitest run scripts/quality/deploy-reusable-workflow.test.ts` — 19/19 deployment mapping tests passed.
- Playwright cache audit — 15 passed with 12 intentional device-specific skips across iPhone SE, iPhone 14, and desktop; rotation request-count, stale-refresh, delayed-indicator, overflow, error, single-character, and hostile-looking text cases passed.
- Specialist review — UI/UX, test engineering, security, constitution, documentation sync, and environment consistency all passed after their findings were addressed.
- Final staging deployment — GitHub Actions run `31230115937` passed for exact implementation SHA `9e2d865651a400395cbf51730cb8967117e7316d`, including the repository's built-in live smoke suite.
- Authenticated feature-specific staging Playwright — passed in both an iPhone 14 touch context and a mouse/keyboard-capable context at 390×844 → 844×390. The test observed one project-list request through rotation, retained the first loaded project card, confirmed intent-prefetch detail reuse during navigation, delayed a real background list response to observe `data-refreshing=true` while content stayed mounted, checked horizontal overflow, navigated dashboard/projects/settings, and captured zero console errors.
- Staging screenshots — `.codex/tmp/playwright-screenshots/staging-frontend-cache-landscape.png` and `staging-frontend-cache-refresh.png` were visually inspected; the latter shows the top-edge activity line with the loaded project grid unchanged beneath it.
- `pnpm quality:observability-noise` — no significant log noise detected; D1 and Workers telemetry checks were unavailable in this local environment because their optional credentials/API access were not present.
- Task completion validator — final re-validation PASS after adding the complete Rule 02 post-mortem and removing the backlog task's trailing EOF blank line; checks A–F found no implementation or acceptance-criterion gap, and its package-scoped focused rerun passed 106/106 tests.
