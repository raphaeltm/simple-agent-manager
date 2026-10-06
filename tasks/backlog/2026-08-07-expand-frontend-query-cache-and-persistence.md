# Expand Frontend Query Caching and Safe Persistence

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Persistence (PR #1858): an IndexedDB store keyed by the signed-in user's namespace, a
>     content-based allowlist (`apps/web/src/lib/query-persist-config.ts:88-92`), a schema
>     buster (`:110`) and `maxAge`. It is cleared on sign-out and account switch and falls back
>     to the in-memory cache when storage fails. Tests:
>     `apps/web/tests/unit/lib/query-persistence.test.ts`, `query-persistence-allowlist.test.ts`.
>   - Chat summaries and active tasks moved onto query factories (PR #1860, landed via #1852):
>     `lib/query-options/chats.ts:61-97`, `lib/query-options/tasks.ts:37`.
>   - Hover prefetch on the same keys: `hooks/useProjectIntentPrefetch.ts`.
> - **Still open:**
>   - Rank and migrate the remaining hand-rolled loaders. A heuristic count (a read-API call plus
>     `useEffect`/`useState`, no `useQuery`) finds 83 files, against 47 that use TanStack Query.
>     Start with the project subpages: ProjectDeployments, ProjectDeploymentEnvironmentDetail,
>     ProjectLibrary, ProjectActivity, ProjectTasks, ProjectTriggerDetail, ProjectNotifications,
>     ProjectMembersSection, ProjectRuntimeConfigSection, the deployment panels and
>     AgentContextPage; then the admin pages and hooks.
>   - Staging validation of persistence (reload, offline/online, account switch, quota failure,
>     cache buster). PR #1858 skipped staging by instruction.
> - **Moot/dropped:**
>   - `sessionStorage` as the store: the shipped layer uses IndexedDB instead. Rationale:
>     `query-persist-config.ts:22-26` and
>     `tasks/archive/2026-08-18-query-cache-persistence-and-http-cache-headers.md`.
>   - Chat messages on the "Never Persist" list below: the project owner has since approved local
>     persistence of the project-chat message cache (`query-persist-config.ts:45-46`). Keep the
>     rest of that list; `query-persist-config.ts:41-46` and two tests cite it.

## Problem

The first frontend performance PR covers responsive route preservation plus the highest-leverage project list/detail cache. Many other pages still use isolated `useState`/`useEffect` loaders, and a true full document reload still loses the in-memory QueryClient.

## Research Basis

- SOL research tasks `01KZF578YJ1JG4APXDA4J29EYX`, `01KZF57GTQW3Q6RW3JPP47QRM2`, and `01KZF57MDCMN7KT94MFSDEF5C5`.
- `tasks/archive/2026-08-07-frontend-query-cache-and-rotation-resilience.md`.
- Prior cross-user browser-cache incident: `tasks/archive/2026-08-05-namespace-library-cache-by-user.md`.
- Official TanStack persistence guidance: https://tanstack.com/query/v5/docs/framework/react/plugins/persistQueryClient

## Proposed Follow-Up

- Inventory and rank remaining hand-rolled loaders by route frequency, payload cost, volatility, and sensitivity.
- Migrate active-task and cross-project chat summaries, then common project subpages, onto centralized query option factories.
- Add route/parent-load prefetch only after destination pages consume the exact same keys.
- Design an opt-in, authenticated-user-scoped `sessionStorage` persistence layer using `PersistQueryClientProvider`.
- Use an explicit dehydration allowlist. Start with bounded summary/reference data only.
- Version persisted data with a build/schema buster and configure `maxAge`/`gcTime` together.
- Clear persisted state before signout completes and on clean session expiry/account switch.
- Treat quota, parse, and private-mode failures as cache misses without breaking the app.

## Never Persist Without Separate Security Review

- Chat messages, prompt content, attachments, or agent output.
- Credentials, tokens, secrets, environment values, or connection configuration.
- Admin errors, diagnoses, logs, incident evidence, or usage/cost details.
- Node/workspace runtime details that can contain environment or infrastructure metadata.
- File/library contents or signed URLs.
- Mutation state.

## Acceptance Criteria

- Persisted query keys are deterministically namespaced by authenticated user and schema/build version.
- Logout, session expiry, and account switch cannot render the prior user's data, including colliding resource IDs.
- Only approved allowlisted queries are dehydrated.
- Persistence failures degrade to the normal in-memory cache.
- Tests seed foreign-user/sensitive canaries and prove they never render or remain in storage after auth transitions.
- Staging validation covers reload, offline/online, account switch, quota failure, and cache-buster behavior.
