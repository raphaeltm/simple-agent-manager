# Cloudflare deployment build executor (phase 3)

SAM task 01M7C1SRMAWR3PYFWKF03XJ273; idea 01KZ6V37D1QGDR3WN12PSDB0QD.

## Preflight / research

Classes: external-api-change, cross-component-change, business-logic-change, public-surface-change, docs-sync-change, security-sensitive-change, infra-change.
Read entire Nov6 implementation plan, phase0 attempt2 report (library01M6SMMAP4EHXKAGJ4G25ZXXK1), and merged phase2 #2605 body. Current main099c278d, latest DO migration v22 (use v23); portable collector and callback receipt replay already shipped. Official references: https://developers.cloudflare.com/containers/configuration/outbound-traffic/, https://developers.cloudflare.com/containers/api/durable-object-container/, https://developers.cloudflare.com/sandbox/sdk/guides/docker-in-docker/. Use installed containers0.3.7 API/types; avoid unrelated SDK migration.

Data flow: MCP compose-publish-tools → app-deployment job/executor selection → existing source collect route → existing context callback → atomic admission → ComposeBuilderContainer(jobId) → sam-builder → internal/publish → existing artifact/events/release callbacks → existing deployment VM apply. Builder identity never depends on source liveness. Keep node_id source meaning and existing node cascade limitation.

Spike: standard-4 only demonstrated, overlayfs, root dockerd/cgroupfs, /tmp mount, build.network host required. Keep20min deadline and60s readiness. >100MiB real R2 PUT/GET not measured; mandatory here. Root RUN can access builder-local state: no broad credentials, job token scope exactly one job, deny-default egress. No runtime secret values supplied.

## Implementation

- [x] Publish-job JWT and dual callback authorization; atomically fence attempt; env/profile/job artifact identity.
- [x] Atomic D1 admission, project2/platform6 clamped class maximum; queue/backoff/drain, no silent source fallback.
- [x] Builder Go supervisor: safe bounded download/hash/extraction, daemon startup/readiness, host network augmentation, existing publish engine, signals/heartbeats.
- [ ] ComposeBuilderContainer alarm/terminal lifecycle; image, env instance type, max config, v23 SQLite migration and allowlist.
- [x] Runtime admin executor selection, Instant cloudflare, VM node default, old-agent compatibility.
- [ ] Guide/config/self-host docs and contract updates.
- [ ] Local meaningful regression/contract/admission tests, lint/type/build gates.
- [ ] Independent security/domain/completion reviews resolved.
- [ ] Explicit staging slot;100% rollout plus node AND builder version proof.
- [ ] Real Instant publish then source sleep/app serving; VM cloudflare source no build/save; >100MiB presigned GET and PUT.
- [ ] Clean tasks/chats/nodes; immediate and >5min D1 audits.
- [ ] Draft PR needs-human-review, CI, CodeRabbit request/wait; send URL/full SHA/gates to coordinator then STOP.

Never commit to main. Preserve .codex/config.toml environment change. Staging Claude VMs0.2CPU/0.5GB. Known archive flake retry at most once. No merge absent coordinator exact-SHA approval.

## Implementation validation state — 2026-11-14

Auth/admission and Go supervisor pushed in fe4ffa848 /27fda1536. Container/cron/admin/config integration now uses durable alarm kickoff (HTTP callback returns promptly), idempotent acceptance across SDK healthy state, stop-confirmed capacity backoff, destruction before database deadline verdict, and explicit retry of failed deadline destruction. Root lint and typecheck passed; focused executor tests85PASS and Go race builder/publish/contextcollector PASS. Full root tests hit unrelated archive/UI timing failures under concurrent load; bounded isolated retries pending. Migration/config tests91PASS. Network allowlist remains a known unvalidated placeholder: SDK outbound handler100MiB limit and CA propagation into arbitrary RUN images conflict with required transfer/build semantics. Coordinator requested human approval for open egress; not granted yet. No staging slot requested or used. No PR exists yet.
Adjacent fixes logged: Compose project-name provenance01M7C3V7PQWQFXX8H3Y6J9A59Q; self-host build-cache binary manifest01M7C5YZ354D72XZX7K6F70HHE. Cache/prebuilt manifest must include new builder binary or skip-compile restore cannot build its image. Callback/bootstrap operational budgets are configurable; context GET reuses existing configured URL TTL.
