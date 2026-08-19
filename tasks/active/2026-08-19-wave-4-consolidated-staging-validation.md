# Wave 4 — Consolidated Staging Validation for the UI Performance Program

- **Date**: 2026-08-19
- **Idea**: `01M09SKVNJGJNJY2WGCZ6D89XZ` (SAM UI Performance Program)
- **SAM task**: `01M0C2TF4KWTEMQBT1KB0VCFHC`
- **Output branch**: `sam/wave-4-consolidated-staging-0vcfhc`
- **Branch validated**: `sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz` @ `f66f5d91f`
- **Scope**: VALIDATION ONLY — no merge, no production deploy.

## Problem

Twelve UI-performance optimizations were implemented across three waves and
squash-merged into one integration branch. Per the project policy
*"Progressive quality-tool rollout with consolidated staging validation"*,
staging work is consolidated into a small number of large end-to-end sweeps on a
pinned final candidate rather than repeated per-feature deploys. This task is
that single consolidated sweep.

The gate is rule 30: the features must WORK end-to-end as a user experiences
them. Page loads and 200 responses are regression baseline, not feature
verification (rules 13, 33).

## What shipped (per the brief)

| Item | PR | Claim |
|---|---|---|
| A | #1848 | Auth per-isolate cache + platform-config 6-module split |
| B | #1850 | Route-level React.lazy code splitting (entry bundle −91%) |
| C | #1851 | DO roundtrip cuts via batch RPCs (−35-42%) |
| D | #1849 | Poll gating (hidden-tab pause) + context memoization |
| E | #1858 | TanStack Query cache persistence (IndexedDB) + Cache-Control |
| G | #1859 | Chat DOM bounding (react-virtuoso) + D1 session summary index |
| F | #1860 | TanStack Query migration of 15 hooks, SWR, identity-scoped keys |

## Research findings

### F1 — The brief's description of item C is inaccurate (docs, not code)

`git show 1ef54144c -- apps/api/src/durable-objects/project-data/index.ts` shows
the entire DO-side change is a doc comment plus `private syncSummaryToD1` →
`protected`. **No batch RPC was added.** The single-RPC
`getChatAgentState(chatSessionId)` design was deferred and remains an unchecked
backlog item at `tasks/backlog/2026-08-18-chat-agent-state-single-do-rpc.md`.

The real item-C mechanism is:
1. `ensureOncePerIsolate` memo — `apps/api/src/services/project-data-ensure-memo.ts`,
   keyed on `DurableObjectId.toString()`, bounded by
   `DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES = 2000`
   (env `PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES`). Collapses 2 DO roundtrips → 1
   per logical op on a warm isolate.
2. `Promise.all` in `resolveChatAgentState`
   (`apps/api/src/routes/chat-agent-state.ts`) parallelizing two
   `getSessionState` reads plus `getLatestPersistedPlan`.

**Consequence for validation**: there is no batch-RPC surface to observe, and
item C exposes no HTTP header. Only latency (warm vs cold) and the absence of
`chat.state_*_lookup_failed` log events are observable.

### F2 — Item A is not directly observable

`platform-config-core.ts` emits zero log calls; there is no cache hit/miss
counter, header, or metric. `DEFAULT_PLATFORM_CONFIG_CACHE_MS = 60_000` is
module-private. Only latency and TTL-convergence behavior are observable.

Deliberately NOT cached (must stay true): `isSignupApprovalRequired`
(`apps/api/src/services/signup-approval.ts`) carries an explicit
"Deliberately NOT cached per-isolate" comment because it is an account-denial
gate. Every `createAuth` call site still passes `disableCookieCache: true`.

### F3 — Item G's D1 fast path was cold at validation start

Migration `0117_session_index_per_project.sql` is applied and
`idx_session_summaries_project_creator` exists, but `session_index_coverage`
had **zero rows**, so every `/sessions` call was missing the index and falling
back to the Durable Object. This converts into a stronger test than latency:
drive the documented self-heal and assert a coverage row appears with
`complete = 1`.

### F4 — A genuine "before" baseline was available

`sam/recover-rebase-land-finished-gg6ed6` (previously deployed, 2026-08-18)
contains none of the perf commits, so pre-deploy assets are a true "before":
`/dashboard` served **17 JS files, 3,953 kB decoded**, dominated by one
monolithic `index-N5jNpI-f.js` at **3,429 kB**.

## Observable-signal map (what each item is validated by)

| Item | Signal |
|---|---|
| A | Latency cold vs warm on `/api/config/login-providers`; suspension/approval gate must stay uncached |
| B | Eager JS bytes on `/dashboard`; new chunks fetched on client-side nav; `[data-testid="route-fallback"]` |
| C | Latency warm vs cold; absence of `chat.state_*_lookup_failed` |
| D | API request count over equal VISIBLE vs HIDDEN windows via CDP `Emulation.setPageVisibilityOverride` |
| E | Exact `Cache-Control`/`Vary` header values; IndexedDB `keyval-store` key `sam-query-cache:v1:user:<id>` |
| F | Duplicate concurrent requests per endpoint; zero-row frames during client-side return nav; userId in query keys |
| G | `.sam-message-entry` and `[data-testid="virtuoso-item-list"] > [data-item-index]` counts vs total messages; `session_index_coverage.complete` |

## Implementation checklist

- [x] Verify staging free of contention (unfiltered `gh run list`)
- [x] Capture genuine pre-deploy "before" baseline
- [x] Deploy integration branch to staging
- [x] Confirm deploy green
- [x] Regression sweep, desktop (15 routes)
- [x] Regression sweep, mobile 375px (15 routes)
- [x] Item B — code splitting
- [x] Item D — poll gating
- [x] Items E/F — cache headers, IndexedDB, dedup, SWR
- [x] Item G — chat DOM bounding + D1 index self-heal
- [x] Items A/C — latency characterization
- [x] Confirm zero staging VMs left running
- [x] Report findings

## Acceptance criteria

- [x] Staging deploy green on the integration branch
- [x] Every major page renders real content with no new console errors
- [x] No horizontal overflow at 375px or 1280px (including clipped overflow, rule 56)
- [x] Each of the 12 items has an explicit PASS / FAIL / NOT-OBSERVABLE verdict backed by evidence
- [x] Any regression documented precisely (page, action, error)
- [x] No PR merged

## References

- `.claude/rules/13-staging-verification.md`, `30-never-ship-broken-features.md`,
  `33-staging-feature-validation.md`, `17-ui-visual-testing.md`,
  `56-clipped-overflow-is-invisible-to-document-checks.md`,
  `60-request-io-and-bundle-budgets.md`
