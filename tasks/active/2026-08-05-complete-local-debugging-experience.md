# Complete Local Debugging Experience

**Status:** Active

## Problem

SAM's local-instance debugging flow is only partially complete.

The durable admin diagnosis runner shipped in PR #1736, but production-compatible code still has four correctness and usability gaps:

- `debug_diagnosis_runs.status` was created with a D1 `CHECK` constraint that excludes `cancelled`, while the runner writes `cancelled`.
- Terminal writes are not compare-and-set transitions, so a late model/tool completion can overwrite cancellation or deadline failure.
- The diagnosis detail UI renders only the first event page, so runs with more than 100 events silently lose history after refresh.
- Cancel, retry, copy, and evidence actions do not expose pending, success, or failure state.

VM errors are also still ephemeral at the reporting boundary. `packages/vm-agent/internal/errorreport` swaps its in-memory queue before sending and never requeues a failed batch. Operators can explicitly download the broad node debug package while a node remains reachable, but SAM does not automatically retain a small, safe, incident-correlated evidence package when the failure occurs.

The result is a diagnosis experience that can explain control-plane evidence but often loses the most useful VM-side facts and cannot reliably prove cancellation or full event history.

## Goal

Ship a complete, same-instance debugging vertical slice:

1. make diagnosis-run state transitions and event history durable and correct;
2. give every VM report a stable incident ID and a crash-safe SQLite outbox;
3. automatically collect a small allowlisted, bounded, recursively redacted VM snapshot for error-level incidents;
4. upload snapshots through callback-JWT-authenticated Worker routes into private, short-lived R2 storage;
5. correlate incident metadata with the observability error, expose safe evidence to the diagnosis agent, and render evidence state/previews in the superadmin UI;
6. verify the full path on a fresh staging VM and in production after merge.

The broad existing debug package remains an explicit operator-only live-node tool. Automatic incident evidence is a separate safe-by-construction artifact and is never allowed to include broad debug-package content.

## Explicit Non-Goals

- No cross-instance or upstream feedback transport.
- No bundle export/import, signing, encryption envelopes, intake, quarantine, inbox, or federation.
- No automatic GitHub issue creation or publication of machine-generated diagnostics.
- No prompts, model messages, repository contents, arbitrary log files, environment values, authorization headers, OAuth material, credentials, tokens, process command lines, Docker inspect environment/config, or raw SQLite databases in automatic artifacts.
- No public R2 bucket, public URL, presigned browser URL, or unauthenticated download path.
- No replacement or automatic retention/model ingestion of `GET /api/nodes/:id/debug-package`.
- No duplication of the separate active task that wires omitted Worker/DO suites into general CI; this task adds and runs its own feature-specific tests.

## Research Findings

### Durable diagnosis runner

- Migration `0103_debug_diagnosis_runs.sql` permits only `queued`, `running`, `succeeded`, and `failed`, but the shared contract and runner include `cancelled`.
- The run table is an FK parent of `debug_diagnosis_run_events`; repository migration policy forbids dropping/recreating it. The safe repair is an additive canonical `run_status` column with all five values. Existing rows are backfilled from the legacy checked `status`; code reads `run_status`. Writes keep the legacy column compatible (`failed` when canonical state is `cancelled`) until a future explicitly planned cleanup.
- `DiagnosisRunner.completeRun()` and `finish()` currently update by ID without an active-status predicate. Because Durable Objects can interleave at every `await`, cancellation can land while a model/tool request is in flight and then be overwritten.
- Terminal transitions must use guarded D1 batch operations. Diagnosis insertion, run transition, and terminal event creation must be conditional on the same active state. A losing completion must not create an orphan diagnosis or terminal event.
- `listDiagnosisEvents()` returns the last event sequence as `nextCursor` even when there is no next page. The service should query `limit + 1`, return a cursor only when more rows exist, and the web client should exhaust pages with a monotonic-progress guard.

### VM error delivery and evidence

- `errorreport.Reporter` is in-memory. `flush()` removes entries before `send()`, and any JSON/HTTP/non-2xx failure loses the batch.
- The message reporter already contains the preferred local pattern: WAL-backed SQLite outbox, unique IDs, bounded capacity, oldest-first batches, delete-after-success, retained rows on transient failure, and serialized flushes.
- Production error-level reports need stable VM-generated ULIDs. The same ID is persisted as the observability `platform_errors.id` and the primary-D1 diagnostic incident ID, making correlation deterministic across retries and the two databases.
- Error delivery must be acknowledged only after idempotent writes to both observability D1 and primary-D1 incident metadata succeed. The two databases cannot share a transaction, so retry-safe deterministic IDs and upserts provide reconciliation after a partial write.
- Snapshot collection must not block the caller that reports an error. The durable worker first delivers the structured error, then captures/uploads evidence asynchronously from the persisted outbox.
- A crash can occur before collection, while writing the spool file, after R2 upload, or before the D1 state update. Deterministic object keys, content checksums, idempotent registration/upload routes, and startup orphan cleanup are required.

### Safe snapshot contract

- Automatic artifacts are tar+gzip archives with a manifest and a small set of JSON documents produced by allowlisted collectors.
- Initial allowlist: VM-agent/version/runtime health, bounded system resource summary, bounded recent structured event-store records, bounded workspace/container lifecycle status, and collector outcome metadata.
- Collector implementations select fields before serialization. A second deterministic recursive redaction pass covers keys and values, truncates depth/collections/strings, and detects common token/credential/authorization/private-key/URL-secret patterns.
- The manifest records schema version, incident ID, timestamps, agent version, collector status, truncation, byte counts, and redaction counts. It contains no secret values.
- A realistic canary-secret suite must prove every canary is absent from the local archive, registration JSON, HTTP request logs, R2 download, admin API response, diagnosis tool result, and UI text.
- A collector failure is represented in the manifest and does not broaden collection or invoke shell/log fallbacks.

### Worker, D1, and R2 boundary

- Node callback routes must live on `nodeLifecycleRoutes`, use `extractBearerToken`/`verifyCallbackToken` with expected node scope, and remain mounted before session-authenticated node routes.
- Cloudflare's Worker R2 API accepts a `ReadableStream` in `R2Bucket.put`, so artifact content can be streamed from `Request.body` without buffering the archive in Worker memory.
- Artifact registration is a bounded JSON request. It creates deterministic metadata and returns an artifact ID. A separate authenticated content route requires a valid content length and checksum, streams to a deterministic private R2 key, and marks metadata available only after R2 succeeds.
- Primary D1 stores incident/artifact metadata, safe manifest JSON, preview JSON, status, checksum, sizes, retry/error state, and expiry. Raw artifact bytes exist only in private R2 and the temporary VM spool.
- Pulumi already manages an R2 lifecycle resource. A configurable `diagnostic-incidents/` prefix rule must be added to the same resource so expiration is deployment-owned.
- Scheduled reconciliation is bounded: expire due metadata and R2 objects, mark stale pending uploads failed, repair deterministic objects that exist after a partial state update, and mark missing available objects. Per-node count/byte quotas prevent unbounded storage.

### Diagnosis and UI integration

- The model receives only a bounded `get_vm_incident` tool result containing redacted manifest, collector statuses, previews, counts, and timestamps. It never receives the raw archive or an R2 URL.
- Admin error responses can be decorated with incident summaries by batching IDs against primary D1 after the observability query.
- Diagnosis detail responses include the correlated incident summary for `run.errorId` and an authenticated superadmin-only proxy download action for safe automatic artifacts.
- Existing broad live debug-package download remains separate and explicit.

### Failure history and process correction

- PR #1736 added the cancellation state in TypeScript without evolving the already-applied D1 enum constraint. The root process gap was that tests created tables from ad-hoc/current schemas instead of applying the real migration chain and exercising every persisted enum transition.
- The same PR used unconditional terminal updates despite the repository's Durable Object interleaving rule. Tests did not force cancellation/deadline transitions while the external model/tool await was suspended.
- This task must add migration-chain behavior tests and barrier-controlled concurrency tests, and update the migration rule to require both whenever a persisted enum or long-running terminal state changes.

## Preflight Classification

- **Cross-component:** yes — VM agent, API Worker, observability D1, primary D1, R2, scheduled reconciliation, shared contracts, web UI, infrastructure, deployment.
- **Business logic:** yes — outbox retry, quotas, lifecycle, terminal state machine, deduplication.
- **Public surface:** yes — authenticated internal API contracts, admin UI, environment variables, self-hosting/architecture documentation.
- **Security-sensitive:** yes — diagnostic evidence, callback JWT boundary, redaction, private storage, admin-only access.
- **UI/UX:** yes — error and diagnosis pages, pagination, action feedback, mobile/desktop behavior.
- **Infrastructure:** yes — R2 lifecycle and Worker environment configuration.
- **External API:** Cloudflare R2/D1 bindings only; no new third-party service.

## End-to-End Data Flow

```text
VM error call
  -> assign stable incident ULID
  -> persist structured report + evidence state in SQLite WAL outbox
  -> return immediately to caller

outbox worker
  -> POST idempotent error batch with node callback JWT
  -> OBSERVABILITY_DATABASE platform_errors(id = incidentId)
  -> DATABASE diagnostic_incidents(id = incidentId, status = pending)
  -> collect allowlisted fields
  -> recursive redact + bound + tar/gzip to private local spool
  -> register manifest/checksum/size with callback JWT
  -> stream archive to Worker
  -> private R2 diagnostic-incidents/{nodeId}/{incidentId}/{artifactId}.tar.gz
  -> D1 artifact/incident status = available
  -> delete acknowledged local outbox row and spool file

superadmin
  -> /admin/errors receives batched incident summaries
  -> launches/opens durable diagnosis run
  -> get_vm_incident returns bounded redacted metadata/previews to model
  -> /admin/diagnoses/:runId shows complete event pages + evidence state
  -> optional authenticated proxy download streams the safe archive

scheduled reconciliation + R2 lifecycle
  -> bound stale pending, missing object, partial update, quota, and expiry state
```

## Implementation Checklist

### A. Repair the durable diagnosis runner

- [x] Add a migration-safe canonical `run_status` column, backfill it, and index active/deadline queries without dropping or recreating tables.
- [x] Update Drizzle/raw SQL to read canonical status and maintain the legacy checked column compatibly.
- [x] Make completion, cancellation, failure, deadline, and reconciler transitions compare-and-set operations.
- [x] Make diagnosis insertion, terminal run update, and terminal event creation one guarded D1 batch so losing transitions create no orphan result/event.
- [x] Prevent post-terminal nonterminal checkpoints/events after an in-flight await resumes.
- [x] Add migration-chain regression coverage proving `cancelled` persists on a database built from all migrations.
- [x] Add barrier-controlled DO tests for cancel-vs-completion, deadline-vs-completion, duplicate alarm, and idempotent terminal events.
- [x] Return event cursors only when another page exists; exhaust all pages in the web client with monotonic cursor protection.
- [x] Add accessible pending/success/failure feedback and duplicate-click suppression for cancel, retry, copy, and download actions without page reloads or hidden stale content.

### B. Durable VM error outbox and incident IDs

- [x] Add a production SQLite WAL outbox for structured error reports, snapshot state, attempts, acknowledgements, manifest metadata, and spool paths.
- [x] Assign stable monotonic ULIDs in the VM agent and preserve caller-supplied IDs during retries/restarts.
- [x] Bound outbox rows, batch entries, body bytes, attempts/backoff, local spool bytes, artifact bytes, and local retention through named defaults plus environment overrides.
- [x] Delete rows only after required structured-report and artifact acknowledgements; retain on transient failures; terminalize bounded permanent/quota failures safely.
- [x] Serialize flush/outbox mutation, support token refresh, and make shutdown idempotent and race-free.
- [x] Prune expired and unreferenced spool files on startup without following symlinks or leaving the configured private directory.
- [x] Preserve nil-safe reporting and keep info/warn reports durable without automatically capturing artifacts.

### C. Safe automatic VM snapshots

- [x] Implement allowlisted collector interfaces and safe default collectors for runtime/version health, bounded system resources, bounded structured events, and bounded workspace/container lifecycle status.
- [x] Do not read arbitrary logs, env values, repository files, prompts/messages, process command lines, Docker inspect config/env, credentials, tokens, or raw local databases.
- [x] Implement deterministic recursive key/value redaction, secret-pattern detection, depth/item/string limits, and cumulative byte accounting.
- [x] Emit a versioned manifest with collector outcome, truncation, bytes, and redaction counts.
- [x] Build tar+gzip archives entirely under a `0700` private spool with `0600` files, atomic rename, deterministic names, and configured maximum size.
- [x] Make collection asynchronous, idempotent, crash-recoverable, and limited to error-level incidents.
- [x] Add malicious nested-object, oversized, symlink, partial-write, collector-failure, crash-restart, and realistic canary-secret tests; run `go test -race ./...`.

### D. Authenticated incident/artifact APIs and storage

- [x] Extend the VM error contract with `incidentId` and idempotently persist that ID in observability D1 and primary-D1 incident metadata before acknowledging delivery.
- [x] Add primary-D1 `diagnostic_incidents` and `diagnostic_artifacts` tables with statuses, indexes, deterministic uniqueness, safe metadata, expiry, and non-cascading retention choices.
- [x] Add node-callback-JWT artifact registration and streaming upload routes on the lifecycle router; validate node/incident identity, scope, content type, content length, checksum, manifest bounds, and quotas.
- [x] Use deterministic private R2 keys and checksum verification; never expose public/presigned URLs.
- [x] Add strictly superadmin-authenticated summary and proxy-download routes with safe headers and audit logging.
- [x] Add bounded scheduled reconciliation for partial dual-D1 writes, stale pending uploads, missing/available R2 drift, quota state, expiry, and metadata cleanup.
- [x] Add a Pulumi-managed, configurable prefix lifecycle rule for automatic incident artifacts and tests that preserve the existing session-snapshot rule.
- [x] Add route contract/capability tests through the combined router proving node tokens work, workspace/session/missing tokens fail, another node cannot overwrite an incident, and non-superadmins cannot read/download artifacts.
- [x] Add streaming, oversize, checksum mismatch, duplicate upload, partial failure, retry, quota, reconciliation, and retention tests using realistic Worker/R2 boundaries.

### E. Diagnosis tools, shared contracts, and admin UI

- [x] Add shared incident/artifact status, manifest, preview, summary, and API response types.
- [x] Add a bounded read-only `get_vm_incident` diagnosis tool correlated by the selected platform error ID; include safe source/action events and never raw bytes/R2 keys/URLs.
- [x] Batch-decorate admin error results with incident state without N+1 queries.
- [x] Include correlated incident state in diagnosis detail responses and poll while evidence is pending.
- [x] Render evidence availability, collector outcomes, truncation/redaction counts, safe previews, explicit unavailable/expired/failed states, and the separate nature of the live broad debug package.
- [x] Provide an authenticated download action for the safe automatic artifact with pending/success/error state.
- [x] Preserve complete event history during polling/refetch and keep existing content visible.
- [x] Add unit/component/Playwright tests for pending, available, failed, expired, missing, long, many-event, malicious-text, retry/cancel, and download states at mobile and desktop sizes with no overflow or XSS.

### F. Configuration, documentation, and process fix

- [x] Add every new timeout, limit, quota, prefix, and retention value to VM/API env config with named defaults and environment overrides.
- [x] Update `.env.example`, env reference, API docs, self-hosting/deployment docs, architecture overview, and debugging/operator guidance.
- [x] Document the safe automatic artifact contract and the explicit broad debug-package boundary.
- [x] Add the R2 lifecycle setting to Pulumi config/output synchronization and deployment validation.
- [x] Update migration-safety guidance to require full migration-chain behavior tests for new persisted enum states and barrier-controlled tests for terminal transitions across awaited work.
- [x] Add a concise postmortem covering the cancelled CHECK mismatch, terminal race, why existing tests missed both, and the process correction.
- [x] Keep touched source files below repository size limits by extracting services/components rather than extending existing oversized files.

### G. Verification, release, and stale artifact reconciliation

- [x] Run format, lint, typecheck, migration ordering/safety, API unit/integration/Worker/DO tests, web tests/build, infra tests, Go unit/race/vet, and repository quality gates with zero errors.
- [x] Complete security, Cloudflare, Go, UI/UX, test, env, docs, constitution, and React reviews; address every critical/high and record all verdicts. Final task-completion validation remains mandatory immediately before archive.
- [ ] Because VM-agent code changes, delete all existing staging nodes before deployment, deploy the branch, provision a fresh VM through the platform Hetzner credential path, and prove heartbeat plus reachable workspace.
- [ ] Fault-inject a real VM error and verify: stable correlation ID, restart-safe delivery, safe snapshot creation, private R2 upload, D1 state, admin error evidence, diagnosis tool event/result, complete timeline, download, and canary absence.
- [ ] Verify cancel during an in-flight diagnosis cannot be overwritten and a run with more than one page of events remains complete after refresh.
- [ ] Clean staging resources, open the PR, obtain green CI, merge, monitor production deployment, and run bounded production smoke with no synthetic secret material retained afterward.
- [ ] Close stale superseded PR #1737 without merging, mark the shipped diagnosis idea complete, and reconcile the failed/stale SAM task bookkeeping only after code and production verification establish the final state.
- [ ] Move this task file and the shipped durable-runner task from active/backlog to archive only after all acceptance criteria and required validation pass.

## Release Evidence and Current Blocker

- Staging workflow `31026725374` deployed commit `5c483e3fd2cb6160022fae20867aff5f1c8db50d` successfully. Configuration validation, Pulumi, migrations `0105`/`0106`, API/tail Workers, web UI, VM-agent/CLI artifacts, health checks, and the authenticated Playwright smoke job all passed.
- An additional authenticated browser check rendered `/admin/errors` at the correct route with no console errors, no feature API 5xx responses, and no shared-canary matches in rendered text or observed admin payloads.
- Staging had zero active nodes before deployment. The enabled platform cloud credential is `01KNY6DC06C9QCYQM0389NAGNT` (`Users Staging Hetzner`). A secondary smoke-user provision attempt correctly selected `credential_source='platform'` and `credential_attribution_source='platform'`.
- Fresh VM provisioning is blocked outside this branch: Hetzner returns HTTP 403 `server limit reached` for both the primary user's Hetzner credential and the enabled platform fallback. Staging observability shows the same capacity failure predating this branch. All failed validation node records were deleted.
- Per Rules 13, 27, and 33, no PR may merge until a Hetzner server slot is freed or quota is raised, a fresh staging node downloads this deployment's VM-agent binary, and the remaining real incident/R2/diagnosis/cancellation/pagination verification plus cleanup passes.

## Acceptance Criteria

- A database created by the real migration chain accepts a canonical cancelled run, while existing rows and deployments remain compatible and no FK parent is dropped/recreated.
- Cancellation or deadline failure that wins while model/tool work is in flight remains terminal; late completion creates neither a success status nor an orphan diagnosis/result event.
- Direct link, refresh, and polling display every diagnosis event beyond the first page with monotonic cursor behavior.
- Cancel, retry, copy, and artifact download show accessible pending/success/failure state and suppress unsafe duplicate actions.
- A VM-agent restart or transient network/control-plane failure does not lose or duplicate a structured error report.
- Every error-level VM report has a stable incident ULID correlated to the persisted platform error and primary-D1 incident record.
- Automatic evidence collection is asynchronous, bounded, allowlisted, recursively redacted, private, retry-safe, and expires automatically.
- Canary secrets are absent from local artifacts, outbound registration, logs, private R2 downloads, admin responses, model-visible tool results, and rendered UI.
- Automatic artifacts contain no prompts/messages, repo content, arbitrary logs, env values, process command lines, Docker inspect secrets, credentials/tokens, authorization material, or raw databases.
- Node callback authentication and node identity are enforced on ingest/upload; all read/download/UI surfaces remain approved-superadmin-only.
- The diagnosis agent can inspect only bounded safe incident metadata/previews and surfaces which VM evidence it used without hidden reasoning.
- The admin error and diagnosis pages clearly show pending, available, failed, missing, and expired evidence on mobile and desktop with no overflow or XSS.
- R2 retention, D1 cleanup, quotas, and reconciliation are automated and deployment-owned; no manual infrastructure prerequisite is introduced.
- The broad live debug package remains explicit operator-only and is never automatically retained or model-fed.
- Fresh staging VM fault injection and post-merge production smoke prove the complete same-instance flow with zero console/network/server errors.
- No cross-instance feedback, bundle, signing, encryption, intake, quarantine, inbox, or upstream transport code is added.

## References

- SAM task `01KZ8V0GMXQ4ZCSERPRT2X2K6M`
- VM incident-evidence idea `01KZ6XAFQDWPTQQWEMZ84CEDQQ`
- Shipped diagnosis idea `01KZ1WR6160C3W6VW165914ZW0`
- PRs #1688, #1722, #1736; stale superseded PR #1737
- `tasks/active/2026-08-04-durable-admin-diagnosis-runner.md`
- `tasks/archive/2026-02-14-vm-agent-error-reporting.md`
- `tasks/archive/2026-03-12-fix-workspace-callback-auth-middleware-leak.md`
- `tasks/archive/2026-03-30-fix-r2-upload-cors.md`
- `tasks/archive/2026-04-01-fix-vm-agent-concurrency-errors.md`
- `tasks/backlog/2026-05-05-debug-package-fixes.md`
- `.claude/rules/23-cross-boundary-api-contracts.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/35-vertical-slice-integration-tests.md`
- `.claude/rules/43-long-running-mcp-tools.md`
- `.claude/rules/45-durable-object-concurrency.md`
- `.claude/rules/46-vm-agent-diagnostic-getters.md`
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
