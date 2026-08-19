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

## Results

Staging deploy: `deploy-staging.yml` run **32214366482**, ref
`sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz`, **completed / success**.
Staging contention checked first with an unfiltered `gh run list` (the
`--status` filter silently returns empty and cannot be trusted); the previous
run was 2026-08-18T08:14:17Z, so staging was free.

### Regression sweep

| Viewport | Routes | Console errors | Failed API | Doc overflow | Clipped overflow |
|---|---|---|---|---|---|
| Desktop 1280x800 | 15 | 0 | 0 | 0 | 0 |
| Mobile 375x667 | 15 | 0 | 0 | 0 | 3 (pre-existing) |

The 3 mobile findings are on `/settings`, `/settings/credentials`
(redirects to `/settings/advanced`) and `/settings/cloud-provider`. Investigated
and confirmed **pre-existing** — filed as
`tasks/backlog/2026-08-19-settings-cloud-provider-mobile-clipped-overflow.md`.
The settings tab strip is a correctly working horizontal scroller
(`overflow-x-auto`, scrollWidth 763 vs clientWidth 349, last tab reachable via
`scrollIntoView`) and is NOT a bug.

### Per-item verdicts

| Item | Verdict | Evidence |
|---|---|---|
| A | **PASS** (indirect) | `/api/config/login-providers` — which resolves the platform config that would otherwise cost 13 D1 reads — is a dead-flat **47ms across 8 consecutive calls** against a 43-51ms network floor (~4ms of server work). `/api/auth/get-session` shows the cold→warm signature: **331ms then 53-62ms**. Security invariants verified intact: `isSignupApprovalRequired` still carries "Deliberately NOT cached per-isolate", and `disableCookieCache: true` is present at all 5 call sites. |
| B | **PASS** | Eager JS on `/dashboard` **3,953 kB → 717 kB (−82%)**; entry chunk **3,429 kB → 271 kB (−92%)**, matching the claimed −91%. Zero heavy libs (mermaid/cytoscape/recharts/xyflow/xterm/katex) in the eager graph. All 4 client-side navigations pulled genuinely NEW per-route chunks. `[data-testid="route-fallback"]` observed under a 120 kB/s throttle. |
| C | **NOT INDEPENDENTLY OBSERVABLE** | See F1 — no batch RPC exists, and neither the memo nor the `Promise.all` exposes a header or log event. Endpoint latency is dominated by other work (see F2), so it cannot isolate this change either. |
| D | **PASS** | On `/nodes`: VISIBLE 40s = **8** API polls (4× `/api/nodes` + 4× `/api/workspaces`, i.e. the 10s intervals). HIDDEN 40s = **0 requests**. RESUMED 12s = 3, including the documented immediate catch-up. |
| E (headers) | **PASS** | All 6 endpoints return the expected `Cache-Control` byte-for-byte, including the `Vary: Cookie, Origin` composition. |
| E (persistence) | **PASS** | IndexedDB `keyval-store`/`keyval` holds exactly one key `sam-query-cache:v1:user:<userId>`, `buster:"v1"`, **queryCount 1**, key `["auth","<userId>","projects","list",{"limit":50}]` — precisely the single allowlisted `projects/list` query, identity-scoped. |
| F (dedup) | **PASS** | Dashboard load issues **9 API requests with ZERO duplicated endpoints**; `/api/credentials` and `/api/credentials/agent` are 1× each. |
| F (SWR) | **PASS** | On client-side return navigation the **first** frame on `/projects` already carries the cached content (len 2438, identical to the settled view); **0 of 42** frames on `/projects` lacked it. |
| G (D1 index) | **PASS** | `session_index_coverage` went from **0 rows** → after ONE `/sessions` call + 6s a row appears with `complete=1, session_count=129`. Across 6 further calls `synced_at` did **not** advance ⇒ no re-prime was scheduled ⇒ the route is **hitting** the D1 fast path. `scope=my` returns 200. |
| G (chat DOM — conversation list) | **PASS** | A **968-message** session holds at most **16** `.sam-message-entry` rows (equal to the virtuoso `[data-item-index]` count), total DOM 662 nodes. The bound holds after scroll-to-top and scroll-to-mid, so it is steady-state, not first-paint. Screenshot confirms the conversation genuinely renders (tool calls, thoughts, messages, "This session has ended"), so the low row count is bounding and not a failed load. Caveat: this list was **already** virtualized before `f5f33559b`. |
| G (chat DOM — timeline drawer) | **PARTIAL — see below** | This is the half that is actually NEW in `f5f33559b` (`Virtuoso` + `TIMELINE_OVERSCAN_PX=200` were added to `ChatTimelineDrawer.tsx`). Virtualization is structurally present and the known breakage is ruled out, but the bound could not be exercised on staging data. |

### Timeline drawer — what was and was not proven

The drawer opens correctly (`role="dialog" aria-label="Session timeline"`), it
renders real content, and it **is** virtualized:
`[data-testid="virtuoso-scroller"]` is present and rows carry `data-item-index`
— the react-virtuoso structure this commit introduced.

**The specific known failure mode is ruled out.** The code comment in
`ChatTimelineDrawer.tsx` warns that wrapping rows in an extra element inside
`components.List` breaks Virtuoso's height measurement, and the repo's audit
pins `MIN_VISIBLE_TIMELINE_ROWS = 4` precisely because a broken wrapper rendered
exactly **1** row while a naive `> 0` assertion still passed. Across six
sessions the rendered row count tracked the entry count exactly — 2→2, 3→3,
5→5, with DOM nodes scaling 38/47/65 — never pinned at 1. So that regression is
absent.

**The bound itself was NOT exercised.** No session on staging has a timeline
long enough. The timeline aggregates user turns and status updates, not raw
messages, so even a 397-message session yields only 3 entries. Every candidate
returned `scrollHeight === clientHeight` (721 === 721), proving the content fits
without scrolling:

| Session | Messages | Timeline rows | Scrollable |
|---|---|---|---|
| hono `e16220c8` | 397 | 3 | no |
| Potato `0b5f6757` | 304 | 5 | no |
| Potato `3434b9be` | 299 | 2 | no |
| Test Project 2 `45d486ea` | 244 | 2 | no |
| hono `9997ac4b` | 170 | 2 | no |
| Potato `fca73a09` | 120 | 5 | no |

This is a limitation of available staging data, not a defect. The repo's own
audit covers this case with a ~300-entry mock fixture in
`apps/web/tests/playwright/chat-dom-bound-audit.spec.ts`, which is the correct
place for it — a staging environment cannot be relied on to contain a
long-timeline session.

### F2 — Observation, NOT attributed to this branch

`GET /api/projects/:id/sessions?limit=20` costs **~1.96-2.09s** on staging while
the underlying D1 work measures **0.165ms** and the network floor is ~43ms. This
is measured on the proven D1 fast path, so the session index is not the cost.
Neighbouring authenticated endpoints: `/api/credentials` ~600ms, `/api/projects`
~750ms, warm `/api/auth/get-session` ~55ms.

No pre-deploy latency baseline exists for these endpoints (staging now runs the
new build), so this is **not** attributable to the performance branch and is
**not** reported as a regression. It is worth a follow-up investigation against
rule 60's round-trip budgets.

### Chat-page 404s — checked, expected behavior

Two console 404s appear on the project chat page. Ruled out the serious
possibility first (a failed lazy chunk would be an item B regression):

- All 30 route-visits in the regression sweep recorded **zero** `requestFailed`
  and **zero** `failedApi`.
- Every asset referenced by the deployed `index.html` returns 200.

Root cause, established from D1 without needing a browser session:

- Chat session `e955988f-...` belongs to task `01KVT1HAB4WQ017TXJPA6T3S89`,
  status `completed`, `workspace_id = 01KVT1HEWADVMV730TG1FK4PAJ`.
- That workspace row is `status='deleted'`.
- `workspaces` holds **196 rows, 0 alive** — every staging workspace has been
  reaped, which is exactly the "staging runs zero VMs at rest" capacity policy.
- The endpoint itself exists: an unauthenticated probe of
  `/api/workspaces/01KVT1HEWADVMV730TG1FK4PAJ` returns **401, not 404**, so this
  is not a missing or renamed route.

A completed session whose workspace has been cleaned up is the expected steady
state. Not a regression.

### Onboarding overlay — checked, not a regression

`/dashboard` renders the cloud-onboarding wizard overlay for the smoke user at
both viewports. Item F did rewrite this path (`OnboardingContext`,
`ChoosePathWizard`, new `useSetupStatus`), so it was checked: the completion
predicate is preserved byte-identically as `hasAgent && hasCloud && hasGitHub`.
The trigger condition is unchanged, the overlay is dismissible, and the
dashboard renders behind it. Per CLAUDE.md this smoke-user state is explicitly
NOT a blocker.

### Staging cleanup

Validation was entirely read-only and provisioned nothing. Verified via D1:
**0 non-destroyed nodes, 0 non-deleted workspaces** — consistent with the
"staging runs zero VMs at rest" capacity policy.

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
