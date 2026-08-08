# Expand Frontend Query Caching and Safe Persistence

## Problem

The first frontend performance PR covers responsive route preservation plus the highest-leverage project list/detail cache. Many other pages still use isolated `useState`/`useEffect` loaders, and a true full document reload still loses the in-memory QueryClient.

## Research Basis

- SOL research tasks `01KZF578YJ1JG4APXDA4J29EYX`, `01KZF57GTQW3Q6RW3JPP47QRM2`, and `01KZF57MDCMN7KT94MFSDEF5C5`.
- `tasks/active/2026-08-07-frontend-query-cache-and-rotation-resilience.md`.
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
