# Make workspace ports polling readiness-aware

## Problem

The 2026-08-25 production stability audit found a high-volume `/ports` readiness/lifecycle gap. Cloudflare telemetry estimated 1,235 workspace `/ports` HTTP 503s in 48 hours, with about 1,085 from three workspaces. One workspace continued to be polled for roughly 32 minutes after its row was marked deleted.

`apps/web/src/hooks/useWorkspacePorts.ts` currently polls at the fixed `WORKSPACE_PORTS_POLL_MS` cadence while the caller's `isRunning` boolean remains true. It has no readiness backoff, no circuit breaker, and no way to distinguish `running` from stale caller state such as `sleeping`, `stopped`, or `deleted`. A runtime that is not yet ready or has been torn down can therefore become hundreds of repeated 503s per open client.

## Research findings

- Audit context is in `.library/reliability/audits/production-stability-audit-2026-08-25.md/production-stability-audit-2026-08-25.md`, section "`/ports` is a concrete UI/lifecycle cross-product gap".
- `apps/web/src/hooks/useWorkspacePorts.ts` uses TanStack Query with a fixed `refetchInterval: WORKSPACE_PORTS_POLL_MS`, tracks consecutive failures, logs each failed background fetch with `console.warn`, and clears displayed ports after three consecutive failures.
- The same hook already preserves stale ports on a transient background failure and query-keys by workspace ID, workspace URL, and a non-raw token marker. Tests live in `apps/web/tests/unit/hooks/useWorkspacePorts.test.ts`.
- The hook currently accepts only `isRunning: boolean`. It should accept the effective workspace status so it can stop immediately for `sleeping`, `stopped`, and `deleted`, then reset cleanly when the status becomes `running` or `recovery`.
- Current callers:
  - `apps/web/src/pages/workspace/useWorkspaceCore.ts`
  - `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- `apps/web/src/lib/poll-intervals.ts` centralizes poll cadences and already documents rule 60 hidden-tab behavior. New ports backoff/circuit budgets must live there with exported `DEFAULT_*` constants and `VITE_*` overrides.
- The noisy browser path is not the REST API helper route; `listWorkspacePorts()` calls `workspaceUrl/workspaces/:workspaceId/ports?token=...`, which is routed through the API Worker wildcard workspace proxy in `apps/api/src/index.ts`.
- `GET /api/workspaces/:id/ports` in `apps/api/src/routes/workspaces/crud.ts` exists for CLI/control-plane use and proxies via `getWorkspacePortsOnNode()` in `apps/api/src/services/node-agent.ts`.
- Cheap server-side contract opportunity: for exact workspace port-list requests, the wildcard proxy can return a structured non-5xx readiness/lifecycle payload for expected states (`not_ready`, `sleeping`, `stopped`, `deleted`, `gone`) and can normalize upstream port-list 503/unreachable responses as `not_ready`. Token/auth/internal failures should remain real errors.
- `packages/shared/src/types/workspace.ts` defines `PortsResponse`; extending it keeps VM agent, API, and web response shapes aligned while remaining backwards-compatible with VM-agent responses that only include `{ ports }`.
- Prior task `tasks/archive/2026-03-31-fix-forwarded-ports-project-view.md` added stale-port retention and token refresh coverage. Preserve that behavior: already-displayed ports must not vanish during background refetch or transient failure.
- Prior task `tasks/active/2026-08-18-ui-perf-chat-poll-and-memo-quick-wins.md` established hidden-tab polling hygiene and elapsed-gated catch-up semantics. TanStack Query's `refetchIntervalInBackground` must remain false for this hook.
- Relevant incident lesson from `tasks/archive/2026-08-16-prevent-hidden-harness-work-sleep-and-add-durable-task-waits.md`: unbounded lifecycle-unaware polling is fragile. Polling must be bounded and explicit about ownership/lifecycle state.
- The comment in `apps/web/src/lib/workspace-status-utils.ts` references `docs/notes/2026-04-03-port-detection-recovery-status-postmortem.md`, but that file is absent on current `main`. Do not rely on that path as evidence.
- New Vite build-time knobs need wiring in:
  - `apps/web/src/vite-env.d.ts`
  - `apps/web/.env.example`
  - `apps/www/src/content/docs/docs/reference/configuration.md`
  - `.github/workflows/deploy-reusable.yml`
  - `scripts/quality/deploy-reusable-workflow.test.ts`

## Design decisions

1. Use a readiness-aware TanStack Query interval rather than a hand-rolled interval. This preserves stale-while-revalidate behavior and hidden-tab pausing.
2. Count both structured `not_ready` responses and fetch failures toward a shared unavailable budget. Use exponential backoff with jitter before the budget is exhausted.
3. Use an open-circuit cooldown for recoverable `running`/`recovery` runtime unavailability. After the failure budget is exhausted, probe only at the configurable reset cadence until a success resets the circuit.
4. Treat `sleeping`, `stopped`, and `deleted` as terminal for ports polling. Clear visible ports and stop polling until the effective workspace state returns to `running`/`recovery`.
5. Treat startup port-list not-ready as normal readiness, not a console/error storm. Only genuine fetch errors should emit bounded warning logs.

## Implementation checklist

- [x] Extend shared `PortsResponse` with optional readiness/lifecycle fields while preserving existing `{ ports }` compatibility.
- [x] Extend `apps/web/src/lib/api/workspaces.ts` and query options to return the structured ports response.
- [x] Add exported `DEFAULT_*` constants and `VITE_*` overrides for ports poll base interval, max backoff, jitter ratio, failure budget, and circuit reset cadence.
- [x] Wire the new Vite env vars into type declarations, `.env.example`, public configuration reference, deploy workflow env, and deployment workflow quality test.
- [x] Change `useWorkspacePorts` to accept effective `WorkspaceStatus`, stop for terminal states, reset on clean running/resume, preserve stale ready ports during transient background failures, and use backoff/circuit interval calculation.
- [x] Keep raw tokens out of query keys and preserve token-rotation behavior.
- [x] Update both web callers to pass `workspace?.status` instead of only an `isRunning` boolean.
- [x] Add cheap server-side structured readiness/lifecycle payload handling in the wildcard workspace proxy for exact port-list requests.
- [x] Add the same structured readiness/lifecycle contract to `GET /api/workspaces/:id/ports`, which is the route used by the web helper and CLI/control-plane callers.
- [x] Add/adjust API tests proving expected lifecycle/not-ready port-list states do not produce 5xx responses while auth/token failures still fail.
- [x] Add browser/React Query behavior tests covering provisioning/not-ready, running-but-agent-not-ready, recovery, sleeping, stopped, deleted, token rotation, repeated 503, backoff intervals, circuit cooldown, hidden-tab pause, bounded warnings, and stale-port preservation.
- [x] Run the mandatory Playwright visual audit at 375x667 and 1280x800 with screenshots under `.codex/tmp/playwright-screenshots/`.
- [x] Run lint, typecheck, tests, and build.
- [x] Run specialist reviews: task-completion-validator, ui-ux-specialist, test-engineer, env-validator, constitution-validator, cloudflare-specialist, and doc-sync-validator if docs/API contract changed.
- [ ] Deploy to staging, verify behavior, create PR, wait for CI, merge, and monitor production deploy to completion.

## Acceptance criteria

- Workspace port polling backs off exponentially with jitter after consecutive `not_ready` or failed responses.
- Polling opens a circuit or hard-stops after a configurable bounded failure budget.
- Polling stops promptly and clears ports when effective state is `sleeping`, `stopped`, or `deleted`.
- Polling resumes cleanly when the effective state returns to `running` or `recovery`.
- Startup runtime/port-scanner not-ready is a normal state and does not generate an error-level storm.
- The browser stops/pauses polling while the tab is hidden.
- Already-displayed ports remain visible during background refetch and transient failures.
- New intervals/budgets have env-configurable `VITE_*` overrides with exported `DEFAULT_*` constants.
- The server-side port-list contract distinguishes expected not-ready/lifecycle states from genuine failures without a large server feature.
- Behavioral tests cover provisioning, running-but-agent-not-ready, recovery, sleeping, stopped, deleted, token rotation, and repeated 503.
- Playwright visual audit passes at 375px and 1280px with screenshot evidence.

## References

- `apps/web/src/hooks/useWorkspacePorts.ts`
- `apps/web/src/lib/poll-intervals.ts`
- `apps/web/tests/unit/hooks/useWorkspacePorts.test.ts`
- `apps/api/src/index.ts`
- `apps/api/src/routes/workspaces/crud.ts`
- `packages/shared/src/types/workspace.ts`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- `.library/reliability/audits/production-stability-audit-2026-08-25.md/production-stability-audit-2026-08-25.md`

## Validation log

- `pnpm --filter @simple-agent-manager/web test -- tests/unit/hooks/useWorkspacePorts.test.ts` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/workspace-proxy-port-access.test.ts` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/ws-proxy.test.ts` — passed after updating the refactored source-contract assertion.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with existing unrelated warnings in acp-client and web components.
- `pnpm exec vitest run --config scripts/quality/vitest.config.ts scripts/quality/deploy-reusable-workflow.test.ts` — passed.
- `pnpm build` — passed.
- `pnpm exec turbo run test --concurrency=1` — all changed/relevant tests passed; the only rerun failure was an unrelated `tests/unit/routes/mcp-streamable-http.test.ts` `beforeEach` timeout, and `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp-streamable-http.test.ts` passed immediately afterward.
- `pnpm exec playwright test tests/playwright/session-header-agent-info-audit.spec.ts --project="iPhone SE (375x667)" --grep "title-led header handles long title|mobile switch toggles"` — passed after updating the existing audit mock to represent completed user setup.
- `pnpm exec playwright test tests/playwright/session-header-agent-info-audit.spec.ts --project="Desktop (1280x800)" --grep "title-led stress scenario displays on desktop|desktop switch shows enabled"` — passed.
- Screenshot evidence retained in `.codex/tmp/playwright-screenshots/`: `session-header-title-led-stress-mobile.png`, `session-header-title-led-stress-desktop.png`, `session-header-public-ports-mobile.png`, `session-header-public-ports-desktop.png`.
- Post-Playwright reruns:
  - `pnpm --filter @simple-agent-manager/web test -- tests/unit/hooks/useWorkspacePorts.test.ts` — passed.
  - `pnpm --filter @simple-agent-manager/api test -- tests/unit/workspace-proxy-port-access.test.ts tests/unit/ws-proxy.test.ts` — passed.
  - `pnpm exec vitest run --config scripts/quality/vitest.config.ts scripts/quality/deploy-reusable-workflow.test.ts` — passed.
  - `git diff --check` — passed.
  - `pnpm lint` — passed with existing unrelated warnings in acp-client and web components.
  - `pnpm typecheck` — passed.
- SonarCloud follow-up fixes for PR #1918:
  - Replaced terminal-state array membership with `Set.has()`.
  - Replaced `parseInt` with `Number.parseInt` in the new polling helper.
  - Replaced `Math.random()` jitter with `crypto.getRandomValues()` plus a deterministic no-jitter fallback.
  - Reruns: `pnpm --filter @simple-agent-manager/web test -- tests/unit/hooks/useWorkspacePorts.test.ts` — passed; `pnpm --filter @simple-agent-manager/web lint` — passed with existing unrelated warnings; `pnpm --filter @simple-agent-manager/web typecheck` — passed; `git diff --check` — passed.
- Pre-staging route-shadowing fix:
  - Found that `GET /api/workspaces/:id/ports` was still handled by the older workspaces route before the wildcard proxy and therefore did not return the structured readiness payload.
  - Added `apps/api/tests/unit/routes/workspace-ports-readiness-contract.test.ts` to cover absent/gone, sleeping, stopped, deleted, provisioning/creating, successful running response, upstream 503, transport failure, and unexpected upstream failure.
  - Tightened node-agent transport classification so only upstream 502/503/504 and actual fetch/timeout transport failures become `not_ready`; signing/setup/config failures remain genuine errors.
  - Extracted shared ports-readiness helpers to `apps/api/src/routes/workspaces/ports-readiness.ts` after SonarCloud flagged duplicated helper code between the wildcard proxy and typed API route.
  - Reruns: `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/workspace-ports-readiness-contract.test.ts tests/unit/services/node-agent-ports-auth.test.ts tests/unit/workspace-proxy-port-access.test.ts tests/unit/ws-proxy.test.ts` — passed (39 tests); `pnpm --filter @simple-agent-manager/web test -- tests/unit/hooks/useWorkspacePorts.test.ts` — passed; `pnpm --filter @simple-agent-manager/api lint` — passed; `pnpm --filter @simple-agent-manager/api typecheck` — passed; `git diff --check` — passed.

## Specialist review notes

- `ui-ux-specialist`: PASS. The changed surface is an existing session header/forwarded-ports presentation with no new layout variants; validated actual app shell with long title, special characters, 50 ports, and public-port toggle at 375x667 and 1280x800. Rubric scores: hierarchy 4, interaction clarity 4, mobile usability 4, accessibility 4, system consistency 4.
- `test-engineer`: PASS. React Query coverage exercises provisioning, running-but-agent-not-ready, recovery, sleeping/stopped/deleted, server terminal states, token rotation, repeated failures/backoff/circuit cooldown, hidden-tab pause, stale-port preservation, and no `console.error` storm. API tests cover structured lifecycle/not-ready/gone and auth failure preservation.
- `env-validator`: PASS. New `VITE_WORKSPACE_PORTS_*` variables are present in `apps/web/src/vite-env.d.ts`, `apps/web/.env.example`, `.github/workflows/deploy-reusable.yml`, `apps/www/src/content/docs/docs/reference/configuration.md`, and `scripts/quality/deploy-reusable-workflow.test.ts`.
- `constitution-validator`: PASS. New poll/backoff/circuit values use exported `DEFAULT_*` constants plus `VITE_*` overrides. No new deployment-specific URLs or unconfigurable timeouts/limits were introduced in product code.
- `cloudflare-specialist`: PASS. Worker proxy change is a cheap structured-response normalization for exact `/workspaces/:id/ports` requests only; it avoids extra D1/DO/KV round-trips and leaves non-ports proxy behavior untouched.
- `security-auditor`: PASS. Terminal-token authentication still runs before lifecycle/gone payloads, token failures remain 401, raw tokens remain out of TanStack query keys, and the port-proxy `Set-Cookie` stripping path is unchanged.
- `doc-sync-validator`: PASS. Shared `PortsResponse` contract and public Vite configuration reference were updated; no additional public API route documentation is required because this is an existing workspace proxy contract extension.
- `task-completion-validator`: PASS. Research findings, checklist items, and acceptance criteria are covered by the diff plus automated/manual visual evidence; no uncovered acceptance criteria found before PR/deploy steps.
