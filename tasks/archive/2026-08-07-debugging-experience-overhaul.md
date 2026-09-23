# Debugging Experience Overhaul (coordinated one-PR night run)

**Status:** Active
**Coordinator session:** SAM task `01KZF2ZQRJGW74CK1VVF7491FJ`
**Integration branch:** `sam/rest-night-least-next-7491fj` (all workstream PRs base onto this branch; ONE final PR to `main`)

## Problem

PR #1750 completed the superadmin same-instance debugging pipeline (durable diagnosis runner, VM incident evidence, admin error decoration). But the debugging *experience* around it has large, evidence-verified gaps:

**User-facing (project chat / tasks / nodes — mobile-first primary surface):**
1. `task_status_events` records every lifecycle transition with actor + reason and is served by `GET /api/projects/:projectId/tasks/:taskId/events` (`apps/api/src/routes/tasks/crud.ts:651`) — but `listTaskEvents` (`apps/web/src/lib/api/tasks.ts:273`) has ZERO UI callers. The authoritative "what happened" story is invisible.
2. Failed tasks render as a bare red `StatusBadge` (`TaskList.tsx`, `ActiveTaskCard.tsx`) — `Task.errorMessage` is never shown in lists.
3. The chat failure surface (`project-message-view/index.tsx:141-181`) is a generic red banner with only `errorMessage`: no step, no classification, no guidance, no copy button. Only live-socket crashes get the rich `AgentCrashReportView` (which also hardcodes light-mode Tailwind colors).
4. Silent stalls are invisible: `useActivityVerifyTimer.ts` silently downgrades a stuck "working" spinner to idle — the opposite of the project's fail-visibly policy.
5. Follow-up prompt delivery failures are silently swallowed (SAM idea `01KTP4XBAF351PD3BKHP5VW6HD`, priority 7).
6. No reverse correlation: node/workspace pages never link back to sessions/tasks; admins get no per-node error/incident view.

**Admin-facing (`/admin/errors|logs|stream|diagnoses`):**
7. Error rows (`ObservabilityLogEntry.tsx:126-131`) render user/node/ws IDs as inert text — no links, no copy button (every LOG surface has `CopyButton`; the ERROR surface does not). `PlatformError` has no `taskId`/`sessionId`.
8. Uncaught API request errors are never persisted: `app.onError` (`apps/api/src/index.ts:173-193`) only logs. `source:'api'` rows come from ~10 hand-instrumented sites.
9. Diagnosis runs have no home: only "recent 8" on the errors tab; "Saved diagnoses (N)" opens only `[0]`; incident badge not clickable; no already-diagnosed marker; back button hardcoded.
10. `/admin/logs` fires a rate-limited CF API call on every filter toggle (`useAdminLogQuery.ts:101-105`), has no worker/script filter, and has a search-input/state desync.
11. Health overview has no node heartbeat table (columns exist in D1), cards are inert, overview is not the default admin tab.

## Goal

One PR that makes debugging SAM **rock solid, tested, beautiful, and powerful** for both users and admins:
- Every failure explains itself: classification, guidance, lifecycle timeline, copyable debug report.
- Every ID navigates: error ↔ node ↔ workspace ↔ task ↔ session, both directions.
- Every uncaught API error is durably visible to admins with a requestId users can quote.
- Admin surfaces gain the power features an operator (and an agent reading a paste) actually needs.

## Non-Goals (explicitly out of scope tonight)

- NO automatic retention of the broad node debug package (policy: broad packages stay explicit operator-only, never auto-retained/model-fed).
- NO pre-destroy VM evidence capture (deep vm-agent work — filed as backlog follow-up).
- NO cross-instance feedback transport, GitHub issue automation.
- NO search-performance overhaul of `queryErrors` LIKE scans (follow-up).
- NO new failure-classification column in D1 — classification is display-time only via `packages/shared/src/failure-classification.ts`.

## Shared Contract (pre-written by coordinator on the integration branch)

- `packages/shared/src/failure-classification.ts` — `classifyFailure(message, step?) => { code, label, explanation, guidance, retryable }`. Display-time only; never gates server behavior.
- `packages/shared/src/types/admin.ts` — `PlatformError` gains optional `taskId?`, `sessionId?`; new `AdminNodeSummary` + `AdminNodesResponse`.

### Backend API contract (Workstream A implements; B/C consume)

1. **Observability migration** `apps/api/src/db/migrations/observability/0001_task_session_ids.sql` (additive only):
   - `ALTER TABLE platform_errors ADD COLUMN task_id TEXT;`
   - `ALTER TABLE platform_errors ADD COLUMN session_id TEXT;`
   - Indexes: `(task_id)`, `(session_id)`, `(node_id)`, `(workspace_id)` on `platform_errors`.
2. **`persistError`/`persistErrorBatch`/`persistErrorBatchStrict`** accept optional `taskId`/`sessionId` and write the columns. Existing writers updated where the IDs are in hand (`failTask` already has `taskId` in context; `stuck-tasks` sweeps; `chat.ts`).
3. **`app.onError` durable persistence**: for responses with status >= 500, generate a `requestId` (crypto UUID), include it in the JSON error response body, and persist `{source:'api', level:'error'}` to `OBSERVABILITY_DATABASE` via `c.executionCtx.waitUntil` with message/stack truncation and redaction. Context includes `{requestId, path, method, status}` plus `nodeId/workspaceId/taskId/sessionId/projectId` when derivable from route params. MUST be wrapped so it can never throw or recurse (rule 53); silently skips when the binding is absent. 4xx AppErrors are NOT persisted.
4. **`GET /api/admin/observability/errors`** gains query params: `nodeId`, `workspaceId`, `taskId`, `sessionId`, `userId` (exact match), `endTime` (epoch ms; service already supports). Rows include `taskId`/`sessionId`.
5. **NEW `GET /api/admin/observability/nodes`** — superadmin; bounded (default 50, max 100) list from main D1 `nodes`: `AdminNodeSummary[]` ordered by `last_heartbeat_at` DESC NULLS LAST. Includes error'd/stopped nodes (post-mortem visibility), excludes `destroyed` older than 24h.
6. **NEW `GET /api/admin/observability/nodes/:nodeId/incidents`** — superadmin; bounded (max 50) diagnostic incidents + artifact status for a node (post-mortem evidence survives node death).
7. **`POST /api/admin/observability/logs/query`** accepts optional `scriptName` (validated `^[a-zA-Z0-9_-]{1,64}$`) passed through to `queryCloudflareLogs` (already supported at `observability.ts:576`).
8. **vm-agent ingest** (`node-diagnostic-incidents.ts:178`): non-incident batch persistence failures log a structured warn with dropped count (no more fully-silent drops).

### Frontend deep-link contract

- `/admin/errors` reads filters from URL query params: `?nodeId=&workspaceId=&taskId=&sessionId=&userId=&source=&level=&range=` (Workstream C implements; Workstream B links to it for superadmins).
- Copy-debug-report format (Workstream B, reused stylistically by C): fenced markdown block with SAM IDs (task/session/workspace/node/project), status, execution step, classification code, error message, and the last N status events with timestamps — safe to paste to an agent; contains no secrets by construction (IDs + already-user-visible text only).

## Workstreams

### A. Backend debugging data foundation (Backend Implementation profile)
Items 1-8 of the backend contract + tests: Miniflare integration tests for onError persistence (never-throws, bounded, 4xx skipped, requestId round-trip), filter queries incl. new columns, superadmin gating on new routes (non-superadmin 403), migration-chain test on real observability migrations, classification util unit tests (extend coordinator's module with tests, incl. first-match-wins ordering and unknown fallback).

### B. User-facing failure experience (Frontend Implementation profile)
Must-have:
- Failure card in project chat replacing the bare ErrorBanner content when a task/session is failed/errored: classification label + explanation + guidance (`classifyFailure`), error message, execution step, lifecycle timeline (fetch `listTaskEvents` — first UI caller), `CopyableId` row, and a **Copy debug report** button (markdown per contract). Superadmins additionally get a "View in admin errors" deep link (`/admin/errors?sessionId=...`).
- Task lists show a truncated `errorMessage` preview on failed rows.
- Surface silently-swallowed follow-up prompt delivery failures (idea `01KTP4XBAF351PD3BKHP5VW6HD`) with visible error + retry affordance.
- Stall visibility: when `useActivityVerifyTimer` verifies idle-while-supposedly-working, show a subtle inline notice ("Agent went quiet — no confirmed activity for a while") instead of silently flipping the spinner; keep the existing state reconciliation.
- `AgentCrashReportView` converted to design tokens (dark-mode correct).
Stretch:
- Node page: superadmin-only "Debug" panel showing recent platform errors for the node + diagnostic incidents (new A routes) with link to prefiltered `/admin/errors?nodeId=`; works for stopped/error nodes (post-mortem).
- Report-an-Issue prefill: when opened from a failed session, prefill description with the debug report block (user-editable; existing consent flow unchanged).

### C. Admin debugging power UX (Frontend Implementation profile)
Must-have:
- Error rows: full **copy-as-markdown** button (message/stack/context/IDs); IDs become links (node → `/nodes/:id`, workspace → workspace page, task/session → project chat when projectId present in context) with click-to-copy fallback pills; incident badge clickable (expands/anchors incident details).
- URL-param filter sync + new filter inputs (nodeId/workspaceId/taskId/sessionId/userId) + endTime/custom range; auto-refresh toggle (30s off by default).
- Diagnosis home: list ALL runs (existing list endpoint) in a proper "Diagnoses" surface reachable from admin nav; saved-diagnoses picker (not just `[0]`); per-row "diagnosed" marker; back button uses history.
- `/admin/logs`: stop auto-firing on every filter change (explicit Apply or debounced batch), fix search-input desync, add `scriptName` filter.
Stretch:
- Health overview: node heartbeat table (`GET /api/admin/observability/nodes`), clickable cards, overview as default admin tab.
- `/admin/stream`: client buffer matches server replay (1000), shared `CopyButton`, clearer reconnect state.
- Close backlog `2026-03-10-log-viewer-test-coverage-gaps.md` (behavioral tests: copy-all click, copied state, search submit, collapse, multi-highlight).

## File Ownership (conflict avoidance — do not cross)

| Workstream | Owns | Must NOT touch |
|---|---|---|
| A (backend) | `apps/api/**`, `packages/shared/**` (extend types/tests only), observability migrations | `apps/web/**`, `packages/acp-client/**` |
| B (user FE) | `apps/web/src/components/project-message-view/**`, `components/project/**`, `components/ReportIssueDialog.tsx`, `pages/Node.tsx` + `components/node/**`, `packages/acp-client/**`, `apps/web/src/lib/api/tasks.ts`, new files under `apps/web/src/components/debug/**` | `apps/web/src/{pages,components,hooks}/[Aa]dmin*`, `apps/web/src/lib/api/admin.ts`, `packages/shared/**`, `apps/api/**` |
| C (admin FE) | `apps/web/src/pages/Admin*.tsx`, `apps/web/src/components/admin/**`, `apps/web/src/hooks/useAdmin*.ts`, `apps/web/src/lib/api/admin.ts` | chat/task/node components, `packages/shared/**`, `apps/api/**` |

Both B and C may add exports to `apps/web/src/lib/api/index.ts` (coordinator resolves conflicts at merge). FE workstreams may rely on the pre-written shared contract even before A's PR merges; final integration happens on the integration branch.

## Sub-agent workflow constraints

- Branch FROM `sam/rest-night-least-next-7491fj`; open PR with **base `sam/rest-night-least-next-7491fj`** (NOT main).
- Do NOT deploy to staging (coordinator runs ONE integrated staging verification; explicit instruction per skip-staging policy). Do NOT merge your own PR.
- Full local gates required: build, typecheck, lint, tests; UI workstreams: behavioral component tests + Playwright visual audit at 375x667 and 1280x800 with stress data + overflow assertions (`.claude/rules/17`).
- Design tokens only (no hardcoded Tailwind palette colors in `apps/web`); files ≤500 lines (rule 18); stale-while-revalidate rules (48); no `window.location.reload()` (16).
- Admin-only detail gating: detailed error internals (stacks, contexts) are superadmin-only surfaces; regular users see classification + sanitized message + their own IDs only.

## Verification plan (coordinator)

1. Merge workstream PRs into integration branch; run full monorepo gates + integrated Playwright audits.
2. One staging deploy of the integration branch; Playwright token-login verification of: admin errors filters/copy/links, diagnosis surfaces, chat failure card with a real failed task, deep links. Hetzner discipline: zero VMs at rest; any test node deleted immediately.
3. Final PR `sam/rest-night-least-next-7491fj` → `main` with preflight + specialist review evidence + staging evidence.

## Execution record (2026-08-08)

- Workstream PRs #1766 (admin FE), #1767 (user FE), #1768 (backend) merged into the integration branch with zero conflicts (ownership matrix held).
- Five specialist reviews (security, cloudflare, ui-ux, test, constitution) ran on the integrated diff; every CRITICAL/HIGH fixed on-branch (file-size gate splits, FailureCard accessible name, phantom Tailwind tokens, stale-notice resume lifecycle, context bounding + rule-50 reads, requestId 500-body test). MEDIUM/LOW deferrals recorded in `tasks/backlog/2026-08-08-debugging-overhaul-review-followups.md`.
- Full suites green on the final tree: API 6,749; web 2,936+; workers 585; shared 568.
- Staging deploy 31230856753 (SHA abf58296f) green; scripted verification 14/14 PASS including copy-as-markdown on a seeded real error, URL-param deep-link prefilter, and the failure card + timeline + copy-debug-report on a real reconciliation-killed task at desktop and mobile. Zero VMs provisioned; residual console noise attributed to pre-existing analytics beacon aborts and expected deleted-workspace 404s.
- Latent production bug found and fixed en route: `failTask`'s observability write targeted a nonexistent `errors` table (fail-silent since inception); now uses `persistError` against `platform_errors` with correlation columns.

## Follow-ups filed (not tonight)

- `tasks/backlog/2026-08-07-pre-destroy-safe-evidence-capture.md` — safe allowlisted snapshot before node reaping/heartbeat-death (vm-agent + cleanup sweep).
- Observability `queryErrors` search sargability + COUNT cost near cap.
