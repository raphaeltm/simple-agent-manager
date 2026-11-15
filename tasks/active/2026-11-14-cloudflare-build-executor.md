# Cloudflare deployment build executor (phase 3)

SAM task 01M7C1SRMAWR3PYFWKF03XJ273; idea 01KZ6V37D1QGDR3WN12PSDB0QD.

## Preflight / research

Classes: external-api-change, cross-component-change, business-logic-change, public-surface-change, docs-sync-change, security-sensitive-change, infra-change.
Read entire Nov6 implementation plan, phase0 attempt2 report (library01M6SMMAP4EHXKAGJ4G25ZXXK1), and merged phase2 #2605 body. Current main099c278d, latest DO migration v22 (use v23); portable collector and callback receipt replay already shipped. Official references: https://developers.cloudflare.com/containers/configuration/outbound-traffic/, https://developers.cloudflare.com/containers/api/durable-object-container/, https://developers.cloudflare.com/sandbox/sdk/guides/docker-in-docker/. Use installed containers0.3.7 API/types; avoid unrelated SDK migration.

Data flow: MCP compose-publish-tools → app-deployment job/executor selection → existing source collect route → existing context callback → atomic admission → ComposeBuilderContainer(jobId) → sam-builder → internal/publish → existing artifact/events/release callbacks → existing deployment VM apply. Builder identity never depends on source liveness. Keep node_id source meaning and existing node cascade limitation.

Spike: standard-4 only demonstrated, overlayfs, root dockerd/cgroupfs, /tmp mount, build.network host required. Keep20min deadline and60s readiness. >100MiB real R2 PUT/GET not measured; mandatory here. Root RUN can access builder-local state: no broad credentials, job token scope exactly one job. The original deny-default egress proposal was superseded by Raphaël’s November 15 unrestricted-egress approval. No runtime secret values supplied.

## Implementation

- [x] Publish-job JWT and dual callback authorization; atomically fence attempt; env/profile/job artifact identity.
- [x] Atomic D1 admission, project2/platform6 clamped class maximum; queue/backoff/drain, no silent source fallback.
- [x] Builder Go supervisor: safe bounded download/hash/extraction, daemon startup/readiness, host network augmentation, existing publish engine, signals/heartbeats.
- [ ] ComposeBuilderContainer alarm/terminal lifecycle; image, env instance type, max config, v23 SQLite migration and allowlist.
- [x] Runtime admin executor selection, Instant cloudflare, VM node default, old-agent compatibility.
- [x] Guide/config/self-host docs and contract updates.
- [ ] Local meaningful regression/contract/admission tests, lint/type/build gates.
- [ ] Independent security/domain/completion reviews resolved.
- [ ] Explicit staging slot;100% rollout plus node AND builder version proof.
- [ ] Real Instant publish then source sleep/app serving; VM cloudflare source no build/save; >100MiB presigned GET and PUT.
- [ ] Clean tasks/chats/nodes; immediate and >5min D1 audits.
- [ ] Draft PR needs-human-review, CI, CodeRabbit request/wait; send URL/full SHA/gates to coordinator then STOP.

Never commit to main. Preserve .codex/config.toml environment change. Staging Claude VMs0.2CPU/0.5GB. Known archive flake retry at most once. No merge absent coordinator exact-SHA approval.

## Implementation validation state — 2026-11-14

Auth/admission and Go supervisor pushed in fe4ffa848 /27fda1536. Container/cron/admin/config integration now uses durable alarm kickoff (HTTP callback returns promptly), idempotent acceptance across SDK healthy state, stop-confirmed capacity backoff, destruction before database deadline verdict, and explicit retry of failed deadline destruction. Root lint and typecheck passed; focused executor tests85PASS and Go race builder/publish/contextcollector PASS. Full root tests hit unrelated archive/UI timing failures under concurrent load; bounded isolated retries pending. Migration/config tests91PASS. Network allowlist remains a known unvalidated placeholder: SDK outbound handler100MiB limit and CA propagation into arbitrary RUN images conflict with required transfer/build semantics. Coordinator requested human approval for open egress; not granted yet. Draft PR #2721 is open with needs-human-review. A staging slot has been requested but not granted; no staging resources have been used.
Adjacent fixes logged: Compose project-name provenance01M7C3V7PQWQFXX8H3Y6J9A59Q; self-host build-cache binary manifest01M7C5YZ354D72XZX7K6F70HHE. Cache/prebuilt manifest must include new builder binary or skip-compile restore cannot build its image. Callback/bootstrap operational budgets are configurable; context GET reuses existing configured URL TTL.

## Migration coordination — 2026-11-14 05:40 UTC

Merged current main `8409636ec` without conflicts; DO migration tag remains v22 on main, so builder adds v23. Renumbered the unapplied builder D1 migration to `0240_cloudflare_build_executor.sql`: PR #2693 already owns 0239. Checked other open PR migration paths before choosing 0240. Migration safety and ordering both pass. The main merge touches none of Deploy Installer’s push path filters. Egress decision and explicit staging grant remain pending; no staging deployment or migration has run.

## CI regression fixes — 2026-11-14

The complete API test run exposed stale phase-2 shadow fixtures and the central JWT verifier inventory guard. Signature and claim verification now lives in `services/jwt.ts`; `publish-job-token.ts` retains exact live job-row and attempt binding. Generic callback sinks still reject publish-job tokens. The shadow fixture explicitly selects the node default and resets its deferred fetch mock; Instant asserts a real nonshadow Cloudflare job. Focused fixture/JWT tests: 26 passed. Independent security review passed the verifier move with no new trust-boundary blocker. Logged as idea `01M7CAY9AC980PT4AB9DV0B45M`.

## Approved egress and current-main refresh — 2026-11-15

Raphaël approved unrestricted internet access for Cloudflare deployment builds, like VM workspaces, with direct presigned transfers (knowledge `CloudflareDeploymentBuilds`, observation `d00e0407-5a12-431a-aeff-5d35a7694e5e`). Removed the provisional host allowlist, HTTPS interception and CA installer. Security architecture, deployments guide, configuration reference and self-hosting note describe arbitrary root RUN authority, in-memory job token, callback revocation, object-URL expiry and microVM deadline destruction with code paths.

Merged main `fd0be69bd` without conflicts, preserving published history. The merge touches no Deploy Installer trigger paths. Main’s newest D1 migration is 0241; renamed the never-applied builder migration to `0242_cloudflare_build_executor.sql` at the coordinator’s request. Manually checked all ten other open PR migration lists: no 0242 collision. DO tag remains v23 after main’s v22. Migration safety, ordering and DO safety pass.

Fresh security code review passed. Cloudflare review identified an SDK 0.3.7 reconstruction dependency: a running guest requires the Worker’s standard `ContainerProxy` export even without outbound handlers. Added the export and exercised the installed SDK through two reconstructions, including persisted empty config: no HTTP, HTTPS or catch-all interception is registered. This helper is a named internal entrypoint, not an API route. Logged and fixed adjacent idea `01M7FF41HK2PP2311HKJ9N9MB1`. Runtime egress, transfer and isolation proof remain pending an explicit staging slot grant; no staging resources or deployment have been created.

## Source execution proof — 2026-11-15

Coordinator and Shepherd accepted process-local publish-path execution counters for the VM source gate. Atomic counters increment immediately before actual Compose build and HostDocker.Save execution, including failures. Authenticated system-info returns a fresh snapshot outside the cached collector, with an immutable random process incarnation and no-store on both agent and API. Shared response fields are optional for old-agent compatibility. Compare the same source node, exact version and incarnation before/after the owned job; any restart, missing fields or positive delta is NOT_MET. This proves no vm-agent publish-path source build/save, not surveillance of unrelated host processes. Pair it with executor=cloudflare, matching builder attempt/upload digest and served release.

Tests cover normal and host-network builds, save/build failure attempts, concurrent atomic getters, auth/cache and zero build/save delta for the actual VM/Instant context-collection routes. Discrimination checks removed each increment separately: both produced the expected scenario failure, and restored code passes. Fresh Go and security reviews PASS; focused race suites, shared typecheck and affected TypeScript lint PASS. This is a new release input and requires new full-SHA CI and node/builder rollout evidence; older48da receipts are retained as historical evidence only.

Staging remains ungranted. Planning now budgets two owned cx23 VMs (target reused across both proofs, source after Instant passes), two builders and one Instant; actual catalog quote EUR0.0088/hour per2CPU4GB VM, conservative totalUSD1.238/reserve1.30 under coordinator+ShepherdUSD2 ceiling. Provisional17:55–19:40UTC requires strictFREE/direct grant. Latest auth clarification permits one scoped0600 same-session Playwright cache for bounded stages and ledger-driven recovery; never print/publish it, delete at sign-out. No live login/cache/guards/resources have been created.

Coordinator review found a future false-zero risk in the first counter implementation: checking the last argument misses a future `build web` or `build --pull`. Replaced inference with a dedicated counted Compose build helper, routing both normal and host-network builds through it. Generic Compose execution refuses build tokens, including embedded command tokens. Tests cover refusal and counted trailing options/service; the refusal scenario failed before the fix, and deleting the new helper's increment makes the trailing-service test fail. Restored full publish race suite and focused server race checks PASS. Fresh Go/security delta reviews PASS. Logged adjacent review finding as SAM idea `01M7FMFARDXSK7NHY83T0RWKJ5`.

Staging recipe inspection also found the MCP deployment guide still claimed Instant could not publish and builds always ran on a SAM VM. Updated the agent-facing guide to match executor selection and the observable source-sleep boundary (`context_ready` or subsequent builder progress). Existing deployment-guide response test and affected lint PASS; doc review confirmed the contract and identified both stale sentences, now addressed. Logged idea `01M7FPJ6Z5TH60BX2EWE13AQM8`.
