# Compact archive shards with lossless R2 history and write budgets

## Request and constraints

Raphaël approved keeping metadata, consolidated searchable conversation records and indexes in SQLite shards, with raw streaming history and bulky tool metadata in compressed private R2 chunks. Implement directly in this conversation via `/do`; no delegated implementation. Preserve retrieval/search and keep PR #2033 throttles. A projected ~$100/month SQL overage is explicitly unacceptable.

Do all implementation, review, CI and staging work before presenting an exact production mutation plan. The existing ProjectData rollout policy requires approval for destructive production migration. New format defaults off until that gate; legacy reads continue regardless of the write flag.

## Preflight and research

Classification: external-api-change, cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change. No UI redesign.

Billable boundary: account-wide DO SQLite row reads/writes; SQL indexes and FTS virtual-table changes contribute writes, and source deletes are billed. Transactions/batching alone do not reduce charged rows. R2 Standard charges per object operation and stored bytes. Official references: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ , https://developers.cloudflare.com/durable-objects/platform/pricing/ , https://developers.cloudflare.com/r2/pricing/ . Existing R2 Workers API and streaming compression avoid new dependencies.

Current flow: coordinator `copySourceChunks` exports three source tables, writes recovery JSON to R2, then duplicates ALL rows into a target ProjectData DO. `sealArchiveTarget` recomputes table and terminal hashes and rebuilds grouped FTS; source finalization deletes original rows after persisted recovery proof. Routing `services/project-data.ts` selects the exact owner for transcript, count, tool-content, archived payloads and search. Existing copy-back exports from target and verifies the original terminal hash on root.

Implementation choice: versioned storage format pinned to the target session; compact targets store raw `chat_messages` chunks in gzip R2 with authenticated-by-hash SQLite chunk references and role/time/ID metadata. Existing consolidated `chat_messages_grouped` and tool archive pointers remain SQL so search and old tool-payload lookup semantics are preserved. This removes raw-row target inserts without modifying original history or legacy manifests. Persisted format, not today's env flag, governs all reads/retries.

Every writer/reader affected: coordinator target prepare/commit/seal/manifest; source prepare/finalize/copy-back and abandon; target exact message paging/count/tool expansion/export; project/session grouped search. Normal root writers (`messages`, message-persistence, system messages) remain root-only behind the existing source-intent fence. Target mutators must serialize across R2 awaits. Existing published row-based shards remain readable; do not auto-rewrite them during schema upgrade.

Incident lessons: Aug 26 unseekable scans amplified read bills; Sept 5 whole-session hashing exceeded DO memory; Sept 6 pre-copy refusals stranded migration fences; Sept 8 sessions/hour was not a cost budget. Use bounded chunk streams, exact ownership/hash checks, durable budget deferral, and observe both billed writes and database bytes reclaimed.

## Implementation checklist

- [x] Add additive compact-session/chunk-reference schema and versioned types; test fresh and upgrade migration paths.
- [x] Add bounded gzip R2 chunk codec with read-back verification, identity/hash validation, corruption/size failure and immutable retry behavior.
- [x] Commit raw chunks as SQL references; retain grouped/search records and tool archive ledgers. Pin representation across retries and flag changes.
- [x] Recompute source-compatible hashes/counts from streamed compact chunks before sealing; preserve manifest/source-delete invariants and concurrent-operation safety.
- [x] Route exact transcript pagination, role counts, lazy tool content and export/copy-back to compact storage; preserve legacy behavior and fail closed on unavailable/corrupt archives.
- [x] Enforce durable migration write-budget admission/defer semantics, measure actual SQL writes and bytes freed, prevent oversized-session budget bypass, reserve normal-traffic headroom; document hard versus estimated boundaries.
- [x] Add realistic unit and Workers integration tests for complete migration/read/search/tool/copy-back, retries, corrupt R2, wrong ownership, budget exhaustion/refresh and demonstrably fewer target SQL writes.
- [x] Update deployment env mapping, both env skills, examples, architecture/configuration docs and CLAUDE recent changes.
- [x] Run local full quality gates and task completion/specialist review; fix findings.
- [x] Coordinate staging, deploy final candidate, prove retrieval/tool behavior through live API/UI and history/search through Workers MCP HTTP; record cost/storage and copy-back evidence.
- [ ] Restore staging defaults; finish PR CI/CodeRabbit, prepare exact production rollout plan under the existing approval policy; merge/deploy when authorized and gates satisfied.

## Acceptance criteria

- Complete original raw history round-trips exactly through compact R2 storage, including IDs/timestamps/sequence/origin/tool metadata; paging and count behavior match legacy.
- Consolidated user/assistant conversation text stays complete and searchable in SQLite shards; existing grouped search semantics stay intact.
- Compact target has no raw chat_messages rows; write reduction is measured against the identical legacy fixture in real Workers SQL.
- R2 loss/corruption/oversize/wrong-owner and concurrent retries never publish unverifiable history or delete the sole recoverable source copy.
- Restart and rollout-flag changes do not switch a migration's representation or break existing archives/copy-back.
- Budget exhaustion defers safely without poisoning or fencing new work forever; its allowance and finite unit of work are explicit and tested.
- Production throttles unchanged; deployment alone does not opt production into the new destructive migration format.

## Workflow notes

The current SAM checkout is already clean, isolated on its prescribed feature branch at main 6895aacd5. User requested work here, so keep the task and implementation in this checkout/branch instead of creating another worktree or pushing a task-only main commit.

## Implementation checkpoint (2026-09-08)

Compact codec and real-SQLite compatibility: 30 unit tests passed (including legacy suite). Real Workers archive suite: 10 tests passed, including budget refusal before fencing, complete compact migration/source deletion/routed retrieval, writer-off reads, copy-back and concurrent daily reservations. Focused API typecheck passed before final docs/metadata refinements; rerun in progress. New code remains off in production.

The daily budget is explicitly an estimate (default 250k/day with factor32 and FTS-text units), not an invoice cap. New compact candidates above the message cap remain on root; old legacy migration admission stays unchanged. Source deletion remains a whole-session operation. This is a deliberate safety boundary: do not claim arbitrary giant sessions can drain within a smaller per-day allowance. Actual SQL cursor-write and database-size telemetry accompanies target commit/seal/source delete. Additional cost comparison, failure/race tests, quality gates, independent review, staging and PR remain outstanding.

## Independent review findings and fixes

- Cloudflare/security review found recovery continuation lost at the RPC memory cap. Fixed by carrying `hasMore` explicitly; the 100-row ×200KiB metadata fixture now exercises default 16MiB recovery chunks. Source export and canonical hashing consume SQL cursors instead of materializing raw pages. Compact R2 read/export/seal passes share an operation deadline. Awaiting final reviewer recheck.
- Budget review found same-session contenders wasted permanent reservations. Only a definitive journal/lease loser can now release its unused reservation, atomically and idempotently; no interrupted/ambiguous work is refunded, and old-window releases cannot debit a new day. Real concurrent-canary and rollover tests pass. The pool is installation-wide, not shared across independent SAM installations.
- Completion review requested real routed search/tool/legacy-ledger coverage, true hash/gzip/decompression/stalled-body failures and coordinator restart pinning. Added. Compact Workers suite (new dedicated file) has six passing tests including those end-to-end flows. Additional large-object and shared-deadline refinements are being revalidated.
- Real Workers SQL cost fixture: 1,001 streaming fragments, same consolidation: **3,058 legacy target writes vs63 compact target writes** (~97.94% reduction for target writes only). Snapshot records the runtime counters. Source deletion remains billable.

Full lint13 packages passed, config mapping33 tests passed, D1 ordering passed. Full root test run failed on a now-fixed import error during an intermediate build; it is not counted as passing and must be rerun. Staging, CI and CodeRabbit still pending.

Final independent rechecks: Cloudflare/security PASS; budget/constitution/env/docs PASS after exposing receipt retention and cleanup settings; test-engineer/coverage findings PASS. Focused unit suite95 PASS. Full repository validation and final combined Workers suite in progress; staging and PR gates remain outstanding.

## Final local validation and CI checkpoint

Full local typecheck (19 tasks), build (9 tasks), and lint (13 tasks) passed. Full root API collection had 9,039 passing tests and one stale migration index-count assertion; that assertion was corrected and all 18 migration tests passed. Web covered all 303 files across the initial run and the 10 remaining files run separately. The clean full CI run [34204747422](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34204747422) passed. Final compact Workers coverage also passed after adding actual authenticated `/mcp` HTTP entrypoint checks for exact history and session/project search before migration, while archived, with writers disabled, and after copy-back (six tests). Live staging MCP credentials could not be issued with the available KV token; live API/UI verification and Workers-runtime MCP verification are recorded separately.

All three independent specialist reviewers returned PASS after the final relevant changes. Staging deployment and live canary/recovery verification are in progress; final PR CI and CodeRabbit remain pending. D1 migration was renamed to 0154 before its first deployment to avoid numbers already applied by another staging branch; SQL was unchanged, ordering and fresh Workers migration tests passed.

## Staging-discovered recovery transition

The first green staging deployment preserved baseline history and tools. A legacy archived fixture copied back exactly, but a new compact migration was blocked before copying because the completed old source intent rejected a successor identity. Fixed successor admission to require a verified copy-back anchor matching the old migration, generation and owner, plus a strictly higher safe-integer generation. Eligibility and budget checks precede replacement; active/deleted sources and stale RPCs fail closed. Eight guard cases and a real Workers second-migration/recovery round-trip pass. Safety reviewer rechecked PASS; staging rerun is required for this fix.

## Proposed production mutation plan — not approved or executed

After final CI, independent review, CodeRabbit and staging/recovery proof, ship the code with compact writes disabled. Production's existing one-session/hour and 5,000-message settings remain the baseline.

The proposed approval scope is: pause the global sweep, enable compact writes with an initial installation-wide **100,000 estimated writes/day**, and run one named canary in SAM project `01KHRJGANBBWGDY1NZ0KVF0D4J`: session `f5de2e85-fd7b-493d-bb68-7a1464ada665` ("List files and say hello", 20 raw messages in the read-only D1 preflight). Capture complete history/tool/search baseline first; if any eligibility guard refuses it, stop rather than substituting a session. Migration may remove its raw source SQL rows only after persisted R2/target proofs validate. Verify exact retrieval and actual source/target SQL counters before re-enabling the hourly sweep with the same 100k estimate and 5,000-message ceiling. Stop compact admission if verification fails or observed billable usage consumes the remaining included allowance; retain readers and verified recovery objects. No production copy-back or cleanup outside that exact scope is authorized by this document.

The 100k setting is a conservative scheduling estimate, not a guaranteed invoice ceiling. It excludes ordinary application traffic, existing legacy migrations and operator recovery. Sessions too large for a whole-session budget remain on root and require a separate explicit budget plan. Existing legacy archives are not automatically rewritten. This plan remains subject to policy `66060db4-b224-4a18-af68-6693f71280ba` and Raphaël's final approval.

## Live staging evidence (candidate 76265fe4c)

[Staging deployment 34210529169](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34210529169) and smoke tests passed. Compact writes were enabled with the global sweep disabled. Named fixture session `79aaaa68-6ddc-464f-ab23-9389c08d1a69` in Deployment Test 1 migrated through journal `7842aed9-e705-49df-bdda-7c53a9789dd9` and published as `r2-gzip-v1` to generation2 shard29. The failed predecessor transition resumed successfully after the fix.

Exact API comparisons preserved 19 messages (2 user, 7 assistant, 9 tool, 1 system), role filters, paging and all five legacy tool payloads. Combined response SHA-256 stayed `ed315c8113c3ec50b27d6540b387011b57907c884ff5ae244f86c52b412ae9ae`. Playwright verified dashboard, global/project settings, retained conversation display and tool expansion with a200 payload response. The only browser errors were the independently recorded pre-existing deleted-workspace404; no archive API failures remained after publication.

Live SQL telemetry at09:44:32–09:44:37 UTC: target commits9+18+31 writes, seal6 and idempotent reseal0; source deletion38 writes. Target database grew901,120→905,216 bytes; source shrank1,302,528→1,290,240 bytes (12KiB reclaimed). These are instrumented phases, not total billed request costs. The meaningful amplification comparison remains the identical1,001-fragment Workers fixture (3,058→63 target writes).

Verified compact copy-back returned28 rows across3 chunks and restored root ownership. External post-copy-back equality passed with the identical baseline hash, including all five tool payloads. Normal-configuration redeploy34211987879 passed, and exact API/UI history and tool retrieval passed after restoration. Both temporary GitHub staging overrides have been removed; live compact=false/global=true was verified after the normal redeploy. Recovery objects and audit journals are intentionally retained. Production remains unchanged.

PR [2034](https://github.com/raphaeltm/simple-agent-manager/pull/2034) is open. Full runtime-candidate CI [34210615290](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34210615290) passed. PR preflight wording was clarified to identify official documentation and concrete repository paths; the preflight validator now passes locally. Final PR CI and CodeRabbit, normal staging settings, and the production approval gate are tracked in the PR.


## Final Sonar cleanup

PR Sonar rejected3.7% new duplication against the3% gate and reported archive helper complexity. Shared real-Workers archive fixtures now remove duplicated setup; guard, query, formatting and budget helpers were extracted while preserving public RPC contracts and validation order. All three independent reviewers rechecked PASS. Focused units68, combined legacy/compact Workers14, API typecheck and changed-file lint passed. Changed functions meet the local Sonar complexity threshold. Final-head CI/Sonar and another deployment/canary/copy-back/normal-settings staging cycle remain required before CodeRabbit and merge.


## Final runtime staging and concurrency check (0fe6e2c54)

Full CI34215059313, Sonar and E2E smoke passed. Staging34215274019 passed. The same fixture migrated to compact generation4 throughdee53370-0730-4e9c-ae5a-2c95707b7543, with D1 confirming publishedr2-gzip-v1 and the same aggregate hash. Target commit/seal writes remained9+18+31+6; source deletion38, reclaiming12KiB.

The first simultaneous API/UI check encountered two10-second R2 deadline errors. Tail RPC durations10.4–13.45s with0–1ms CPU support an I/O stall, but do not identify a provider outage or the precise R2 phase. Sequential exact-baseline retry and the identical concurrent API/UI repeat both passed on the unchanged runtime. The expanded tool screenshot was inspected. A real Workers Promise.all regression now verifies full history, role-filtered history, inline tool and legacy archived tool reads against the same owner after source deletion; all6 compact Workers tests passed. Safety and completion reviewers rechecked PASS. The transient failures remain recorded rather than ignored.

Final copy-back and normal-settings restoration are in progress. Both temporary GitHub staging overrides are removed. Test-only concurrency coverage requires fresh final-head CI before CodeRabbit. Separately observed repeated no-op storage alarms are recorded in tasks/backlog/2026-09-08-staging-repeated-noop-storage-alarms.md; no causal link to the R2 errors is established. Production remains unchanged.


## CodeRabbit review and final cleanup

Normal-settings restoration34217173448 and smoke passed; livecompact=false/global=true and exact recovered API/UI/tool baseline passed. All temporary GitHub overrides and the authenticated test browser profile were removed. Final fullCI34217093183 and Sonar passed ond609bc285.

CodeRabbit's initial label trigger did not produce a review; Raphaël manually triggered it at11:32UTC. Review at11:46 reported one minor heading nesting issue and one environment-default documentation nit. Promoted the compact archive section to a top-level configuration heading while preserving its anchor, and documented actual defaults in Env comments. No runtime changes. Fresh final-head CI and CodeRabbit follow-up remain required before merge; production activation still requires the exact-plan approval. Shared staging is released to node-pool and these documentation changes require no new deployment.
