# Generic Project Webhook Triggers

## Status and delivery constraint

- Status: implementation and local validation complete on `sam/lets-pick-work-started-baecxj`; archived at the `/do` pre-PR checkpoint while specialist review, staging, CI, merge, and production verification remain tracked in `.do-state.md`.
- Delivery: The user explicitly superseded the prior draft/do-not-merge constraint on 2026-07-14. Open a normal PR, merge only after every `/do` gate passes, deploy to production, and pause for his input on any material UX or architecture uncertainty.
- SAM design record: idea `01KXE21NN5F6QZA42ZB591B4T0`.

## Problem

SAM's project trigger substrate supports cron and GitHub sources, and its shared source/provenance unions already include `webhook`, but authenticated CRUD rejects webhook creation and there is no generic public ingress, source configuration, delivery audit, preview, rotation flow, or UI. Source-independent execution policy is also duplicated: cron enforces concurrency and auto-pause, GitHub bypasses those checks, and manual run always renders cron context and records cron provenance.

Implement a complete generic webhook-trigger MVP across shared contracts, D1, Worker routes/services, the real project trigger UI, lifecycle cleanup, observability, tests, OpenAPI/reference material, environment configuration, and public documentation. Keep the design tight and DRY: source adapters authenticate/normalize/filter; one common admission service owns execution policy; the existing `submitTriggeredTask()` remains the only task/session/TaskRunner bootstrap.

## Verified existing-system map

### Shared domain and policy

- `packages/shared/src/types/trigger.ts` already declares `webhook` as a source and `triggeredBy` value. It defines common trigger/execution shapes plus cron/GitHub contexts, but no webhook configuration, delivery, credential, filter, preview, or create response contracts.
- `packages/shared/src/constants/triggers.ts` centralizes configurable trigger defaults. New body, rate, filter, idempotency, and delivery-retention bounds belong there.
- `apps/api/src/schemas/triggers.ts` accepts the source enum but has no webhook configuration validator. Updates cannot change GitHub configuration either.

### Persistence

- `0036_triggers.sql` creates common `triggers`/`trigger_executions`; `0057_github_trigger_configs.sql` establishes the source-side-table and delivery-audit precedent.
- `apps/api/src/db/schema.ts` keeps common scheduling/execution policy on `triggers`, source config in `github_trigger_configs`, and source ingress audit in `github_webhook_deliveries`.
- Current sequence allocation uses `trigger_count + 1`. Concurrent event sources can race, and skipped cron executions reuse the same number because `trigger_count` counts successful submissions rather than attempts.
- The migration must be additive. Never recreate/drop `triggers`: it is a foreign-key parent and the retained migration incident proves that can cascade-delete production data.

### API and source adapters

- `apps/api/src/routes/triggers/crud.ts` is 995 lines. It owns create/list/detail/update/delete/test/run/cleanup and must be split before feature growth under the file-size rule.
- Trigger management is project-scoped through `task:read`/`task:write` checks. Final writes must retain project predicates.
- `apps/api/src/scheduled/cron-triggers.ts` contains both cron scheduling and common admission: auto-pause, active-count checks, skipped rows, prompt rendering, execution creation, submission, failure recording, and metadata updates.
- `apps/api/src/services/github-trigger-handler.ts` authenticates upstream in the GitHub route, deduplicates deliveries, maps repository/project, filters, renders, creates executions, and submits. Its dedup persistence currently fails open and it does not enforce common concurrency/auto-pause policy.
- `apps/api/src/services/trigger-submit.ts` is the reusable downstream boundary. It resolves profile/skill/credentials/runtime, creates the task and status event, creates/persists the ProjectData chat session/prompt, validates repository access, and starts TaskRunner. It already accepts webhook provenance.
- `trigger-execution-sync.ts` and scheduled cleanup reconcile task terminal state and recover/purge stale execution rows. The 2026-04-11 trigger incident showed that every task terminal path must preserve this link.
- Manual preview/run are cron-specific; REST run records `triggeredBy: 'cron'` even for non-cron triggers.

### Public ingress and credential precedents

- `api-tokens.ts` generates 32 random bytes, stores an HMAC-SHA256 hash using `ENCRYPTION_KEY`, and returns the raw token once.
- `analytics-ingest.ts` demonstrates bounded public raw-body parsing. `rate-limit.ts` provides KV abuse damping, explicitly not a strict atomic quota.
- The application logger and analytics inspect request paths. More importantly, current Cloudflare Workers invocation/real-time logs include the request URL, so application redaction cannot make a path credential safe. Official evidence: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/> and <https://developers.cloudflare.com/workers/observability/logs/real-time-logs/>.
- Decision: MVP ingress is a static `POST /api/webhooks/ingest` endpoint authenticated with `Authorization: Bearer <one-time-token>`. Do not place the credential in the path or query string.

### Web UI

- `TriggerForm.tsx` is 767 lines and only models cron/GitHub. Modifying it requires a component split.
- `TriggerCard.tsx`, `ProjectTriggers.tsx`, and `ProjectTriggerDetail.tsx` contain cron-shaped fallback copy/icons/stats.
- `ExecutionHistory.tsx` represents admitted executions. Webhook deliveries require a separate audit surface because filtered/duplicate/rejected deliveries do not create executions.
- `apps/web/src/lib/api/triggers.ts` owns the UI/API boundary. Every new webhook form input must be traced through its shared request type, submit payload, API validator/route, config persistence, and handler behavior.
- Raphaël primarily uses the mobile PWA; horizontal overflow and inaccessible hidden controls are retained trigger/UI incident classes. New surfaces require behavioral tests plus 375x667 and 1280x800 Playwright audits.

### MCP, configuration, docs, and tests

- MCP `create_trigger` is intentionally cron-only and direct-SQL based. The secure user control surface must ship first; do not expose create/rotate webhook credentials through MCP in this PR. Update descriptions so advertised support is accurate.
- New generic limits go in shared constants, `apps/api/src/env.ts`, top-level `apps/api/wrangler.toml` vars, `.env.example`, and the environment reference.
- Update `apps/api/src/openapi/sam-cli.ts`, both API-reference skill copies, and public docs under `apps/www/src/content/docs/docs/`.
- Existing cron, GitHub, trigger route/service/worker, web unit, and `triggers-ui-audit.spec.ts` tests are the regression baseline.

## Architecture decisions

### Responsibility split

```text
public webhook request
  -> bounded static ingress + bearer authentication + abuse damping
  -> atomic delivery/idempotency record
  -> pure payload filters + source context
  -> shared trigger admission
  -> existing submitTriggeredTask
  -> D1 task + ProjectData session + TaskRunner
  -> existing execution terminal sync/cleanup
```

- Source adapters own authentication, source lookup, normalization/filtering, and source context.
- `trigger-admission.ts` owns active/paused policy, auto-pause, conditional concurrency reservation, monotonic execution sequence allocation, queued/skipped/failed/running transitions, submission, and common trigger metadata.
- Cron retains due-time calculation and `nextFireAt` advancement.
- GitHub retains GitHub signature/repository/event logic and delivery-specific audit.
- Webhook retains bearer lookup, body/idempotency validation, delivery audit, and generic filters.
- TaskRunner, ProjectData schema, runtime/provisioning, and credential resolution are not redesigned.

### Durable response semantics

Process synchronously through durable admission/submission and final delivery outcome before returning `202`. `waitUntil` may handle non-critical telemetry only. Returning after a pending row while retaining no raw body would acknowledge work that cannot be replayed. If real staging latency misses sender timeouts, Cloudflare Queue plus encrypted short-lived payload storage is a separate follow-up architecture, not a hidden best-effort fallback.

An idempotency key owns one submission attempt. A processing reservation can be recovered only while it has no linked execution. Linking the delivery to its execution is the permanent submission boundary: later same-key requests may observe or repair that execution, but never clear the link or invoke the submitter again. If TaskRunner durably accepted an ambiguous start, its Durable Object state repairs the audit to `accepted`; if the linked attempt failed before a durable start, the same key remains failed and a sender must use a new key for an intentional new attempt.

### Credential and payload posture

- Generate a prefixed 256-bit bearer token; store only a domain-separated keyed HMAC hash and a non-sensitive suffix. Return the token once on create/rotation.
- No raw request body, arbitrary headers, authorization value, rendered prompt, or idempotency key in delivery audit/logs/analytics.
- JSON object bodies only in the MVP; canonical compact JSON is available as `webhook.payload`, while safe dot paths resolve through `webhook.body`.
- Allow only explicitly configured non-sensitive headers into context; authorization, cookie, signature, and token headers are permanently forbidden.
- Require an explicit agent profile for webhook triggers.
- Treat payload text as untrusted data. Frame it in context/template guidance; HTML escaping is not an instruction-security boundary.

### Multi-tenant threat model

- Token lookup resolves exactly one trigger configuration. Management operations verify project capability and include project scope in mutations.
- User A cannot list, rotate, preview, edit, or inspect deliveries for User B's inaccessible project.
- A token compromised for one trigger cannot select another trigger/project. Immediate rotation invalidates it.
- Project members who can manage triggers may rotate/view the one-time replacement credential but never retrieve the stored hash or original token.
- A database-only compromise does not yield usable webhook tokens because hashes are keyed by the Worker secret.
- Trigger concurrency/profile/skill/project checks remain the final cost and privilege boundary.

## UI variants considered

1. Extend the existing drawer with a third source, split into focused source sections, then show the credential in a one-time modal and delivery history on detail. Selected: lowest navigation cost, preserves the real trigger workflow, and can remain mobile-first.
2. Multi-step creation wizard. Rejected for MVP: clearer progressive disclosure but substantially more state/effect/error complexity for a three-source form.
3. Separate webhook settings page. Rejected: fragments common trigger policy and makes execution/delivery correlation harder to understand.

Selected UI: refactored existing drawer (`TriggerSourceSelector`, cron/GitHub/webhook fields, common template/options), one-time credential dialog after save, source-aware cards/detail, and a delivery tab/section distinct from execution history.

## Data model

Add the next available additive migration (re-check main before numbering):

- `triggers.next_execution_sequence INTEGER NOT NULL DEFAULT 1`, backfilled to `MAX(sequence_number)+1` per trigger. This counts every future execution attempt and removes dependence on successful `trigger_count`.
- `webhook_trigger_configs`: `trigger_id` PK/FK cascade, unique indexed `token_hash`, token suffix/timestamps, source label, filter mode, validated `filters_json`, validated `included_headers_json`, created/updated timestamps.
- `webhook_deliveries`: ID, trigger FK cascade, nullable idempotency hash with per-trigger unique partial index, keyed request fingerprint, bounded metadata/outcome/status/error code, nullable execution FK set-null, timestamps and expiry. No raw body.

Use D1 batch/conditional statements for atomic create/config, rotation, delivery dedup, and execution reservation. Fail closed if durable admission state cannot be written.

## Implementation checklist

### Foundation and contracts

- [x] Split the oversized trigger CRUD module into focused CRUD/actions/webhook-management routes with shared response/validation helpers and a thin route index.
- [x] Add shared webhook config/filter/context/delivery/credential/preview/run/create-response types and source-aware request contracts.
- [x] Add configurable shared defaults and strict Valibot schemas for body/config/filter/path/header/idempotency bounds.
- [x] Add generic Worker env declarations/top-level Wrangler vars/local env documentation.

### Persistence and admission

- [x] Add the safe additive D1 migration, Drizzle schema, indexes, types, sequence backfill, and cleanup support.
- [x] Add a focused webhook configuration/delivery repository/service: token generation/hash/lookup/rotation, atomic config writes, idempotency, redacted delivery list, retention purge.
- [x] Add pure safe path/canonical JSON/filter utilities with prototype-key, depth, size, and operator protection.
- [x] Extract `admitAndSubmitTriggerExecution` with conditional active-count reservation, monotonic sequence, skipped outcomes, auto-pause, prompt render callback, common submission, failure recording, and project-scoped metadata updates.
- [x] Migrate cron, GitHub, and REST manual run to shared admission; preserve cron advancement and make GitHub dedup fail closed.
- [x] Add source-aware preview/run context and correct REST manual provenance to `user`.

### Public and management APIs

- [x] Add static public bearer-authenticated `POST /api/webhooks/ingest`, mounted outside session auth without wildcard middleware leakage.
- [x] Enforce kill switch, per-IP/per-trigger KV damping, content type, streamed/raw byte limit, JSON object validation, idempotency length/hash, and uniform non-enumerating responses.
- [x] Add webhook create/update/read config enrichment, one-time credential create response, immediate rotate endpoint, redacted paginated delivery history, and sample-payload preview.
- [x] Ensure invalid tokens return generic `404`; validation errors use bounded public messages; durable internal failures return retryable `503`.
- [x] Add delivery cleanup to the existing scheduled maintenance path and bounded token-free observability.

### Real web product surface

- [x] Refactor `TriggerForm` into focused components below file-size limits and add webhook source/config/filter fields with explicit profile requirement.
- [x] Capture the create response and show an accessible one-time credential dialog with endpoint, bearer token/curl example, copy controls, warning, and acknowledgement.
- [x] Add source-aware card/list/detail copy/icons/stats; show no `Next run` for event sources.
- [x] Add masked configuration, rotation confirmation/result, sample JSON preview, filter diagnostics, and paginated delivery history using the project's current query/data-fetching convention.
- [x] Preserve trigger credential warnings and existing cron/GitHub behavior; keep onboarding cron-only in this slice.
- [x] Add behavioral unit tests for every new interaction and full UI-to-backend value propagation.
- [x] Extend Playwright trigger audits for normal, long, empty, many, error, special-character, credential, preview, filter, rotation, and delivery states at mobile/desktop widths with overflow assertions and screenshots.

### Contracts, documentation, and verification

- [x] Update OpenAPI/SAM CLI trigger schemas and endpoints.
- [x] Keep MCP webhook create/rotation unavailable; update tool descriptions/reference to state the supported boundary accurately.
- [x] Update both API-reference skill copies, environment reference, and public webhook trigger guide with auth, curl, limits, idempotency, filters, templates, statuses/retries, delivery history, rotation, and security guidance.
- [x] Add unit tests for token hashing/rotation, filters/path safety, rendering, config validation, and cleanup.
- [x] Add API vertical-slice tests with realistic SQLite-backed D1/project/profile/trigger state proving ingress -> delivery -> admission -> execution -> injected task/session/TaskRunner submission boundary, plus retryable boundary failure.
- [x] Add concurrent duplicate/concurrency/sequence tests and cron/GitHub/manual regression coverage.
- [ ] Run migration-safety, focused tests, full lint/typecheck/test/build, file-size check, task completion validation, and all required specialist reviews.
- [ ] Run local Playwright visual audit, deploy to staging, verify D1 migration/config via Cloudflare API, then exercise create/preview/ingest/dedup/filter/concurrency/rotation/delivery/execution/task flow and credential-free logs in a real browser/API flow.
- [ ] Open a normal PR with complete preflight, staging, security, data-flow, and specialist evidence; merge only after every gate passes, then monitor and verify production.

## Local verification evidence

- `pnpm lint`: passed with zero errors (repository baseline warnings remain).
- `pnpm typecheck`: 16/16 tasks passed.
- `pnpm test`: 19/19 tasks passed; API 419 files / 6,037 tests and web 219 files / 2,674 tests passed.
- `pnpm build`: 9/9 tasks passed, including the public webhook guide.
- Webhook SQLite ingress vertical slice: 20/20 passed, including public-envelope limits, authenticated submission, filtering, pre-admission rate/config recovery with the same idempotency key, deduplication, both concurrency policies, pre-submit retry, post-submit finalization recovery without duplicate dispatch, stale processing-lease recovery, composite delivery cursors, and bounded cleanup.
- Webhook management/config/action API focus: 31/31 passed, including atomic invalid/valid PATCH behavior, mounted preview, source-accurate action context, one-time credential cache prevention, rotation, equal-timestamp pagination, and invalid cursors. Web focus: 10/10 passed, including creation/rotation focus trapping and opener restoration.
- Playwright audit: 26 applicable cases passed at 375x667 and 1280x800; 26 cross-project cases intentionally skipped. Screenshots cover webhook credential create/rotation, preview/filter results, all delivery outcomes, empty history, long/special text, and pagination with overflow assertions.
- UI rubric: visual hierarchy 5/5, interaction clarity 5/5, mobile quality 5/5, accessibility 4/5, consistency 5/5 (24/25). The one-point accessibility reserve reflects automated/behavioral coverage without a dedicated assistive-technology staging pass yet.
- `quality:wrangler-bindings`, `quality:ast-checks`, `quality:file-sizes`, `quality:migration-safety`, `quality:do-migration-safety`, `quality:source-contract-tests`, and `quality:observability-noise`: passed (external observability queries skipped where credentials were unavailable; local noise checks passed).
- `openapi:check` and `git diff --check`: passed.
- Task-completion pre-staging validation: WARN only for the explicit live ProjectData/TaskRunner staging gate; research/checklist coverage, checked-item implementation, acceptance/test mapping, UI/backend field propagation, source-discriminated resources, and the SQLite-backed vertical slice all passed.

## Primary data-flow trace to verify

1. User creates a webhook trigger in `TriggerForm` -> typed web API client -> authenticated project trigger create route -> atomic `triggers` + `webhook_trigger_configs` write -> one-time credential response -> credential dialog.
2. Sender posts bounded JSON with bearer token -> public static route -> token HMAC lookup -> atomic delivery/idempotency write -> pure filter -> webhook context/render callback -> shared admission.
3. Shared admission conditionally creates a queued execution with monotonic sequence -> `submitTriggeredTask()` -> D1 task/status event -> ProjectData session/message -> TaskRunner start -> execution becomes running and delivery links to it.
4. Existing terminal task paths call `syncTriggerExecutionStatus()` -> execution becomes completed/failed -> detail page shows linked delivery/execution/task.
5. Rotation management route replaces the hash atomically -> old token returns generic 404 -> new token admits work -> UI never re-fetches either raw token.

## Acceptance criteria

- [x] Project editors can create/edit a webhook trigger with explicit profile, prompt, concurrency policy, source label, allowlisted headers, and bounded deterministic filters.
- [x] The bearer credential is 256-bit, shown once, keyed-hash-only at rest, masked thereafter, immediately rotatable, and absent from URLs/logs/analytics/database audit/UI persistent cache.
- [ ] Valid bounded JSON produces exactly one durable delivery, execution, task, ProjectData session/prompt, and TaskRunner dispatch through existing infrastructure.
- [x] Invalid auth reveals no trigger/project existence. Oversize/content/JSON errors are bounded. Persistence failure fails closed; pre-link failures can retry the same key, while a linked retry never resubmits.
- [x] Idempotency and concurrent admission do not double-submit or exceed `skipIfRunning`/`maxConcurrent`; future execution sequence values are unique and monotonic.
- [x] Cron, GitHub, webhook, and manual sources use shared admission; existing cron schedule semantics and GitHub matching remain green; manual provenance is correct.
- [x] Delivery history distinguishes accepted, duplicate, filtered, paused/disabled, rate-limited, concurrency-skipped, configuration, and internal-error outcomes without storing the raw body.
- [x] Preview is source-aware, reports filter diagnostics/context/rendered prompt, and creates no durable work.
- [x] Trigger list/detail/form are source-aware, accessible, mobile-first, and have no horizontal overflow under required edge-case datasets.
- [x] Migration replays from zero and upgrades existing data without dropping/recreating FK parents or losing cron/GitHub history.
- [x] Configuration, OpenAPI, internal API reference, public docs, environment reference, tests, and UI match the shipped contract.
- [ ] Local quality, specialist review, staging deployment, Cloudflare data/log verification, and end-to-end staging behavior pass before the normal PR is opened.

## Explicit non-goals

- Raw payload retention/replay, arbitrary scripts/JQ/transforms, XML/form/multipart/binary bodies, regex filters, sender-managed HMAC secrets, multiple active rotation credentials, outbound webhooks, provider presets, Cloudflare Queue infrastructure, and webhook create/rotate MCP tools.
- Changes to TaskRunner internals, ProjectData schema, VM agent/CLI, provisioning, provider credential resolution, or onboarding's cron-only automation step.

## References

- `.specify/memory/constitution.md`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/04-ui-standards.md`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/18-file-size-limits.md`
- `.claude/rules/19-external-service-integration.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `tasks/archive/2026-04-11-fix-trigger-execution-status-sync.md`
- `tasks/archive/2026-03-12-fix-workspace-callback-auth-middleware-leak.md`
- `tasks/archive/2026-05-08-port-access-tokens.md`
- `tasks/archive/2026-03-25-fix-idea-pages-horizontal-overflow.md`
- `tasks/archive/2026-06-05-harden-trigger-ui-accessibility.md`
- Cloudflare Workers logs: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Cloudflare real-time logs: <https://developers.cloudflare.com/workers/observability/logs/real-time-logs/>
