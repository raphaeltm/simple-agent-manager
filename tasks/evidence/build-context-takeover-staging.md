# Phase 2 takeover verification — 2026-11-09

Deployed source: `d97e8b167445da51567e1ac6ec3a0456bac30eda`, merging main `1065cd446` into PR #2605. [Staging deployment](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42710953115) and its smoke test passed. Worker version `66bc55fe-ae21-452e-90f1-59c88ccd8a4b` served 100% traffic with this commit annotation. This report does **not** satisfy the requested fresh VM publish gate. PR remains draft, with `needs-human-review`, pending coordinator/Raphaël disposition.

## Instant transport: PASS

One claude-code Instant session called the genuine publish tool against temporary staging environment `01M717A2PE0C7MKTZMFJS46GZA`. Normal Instant publication retained its expected early rejection. The isolated shadow job `01M717NG24BB6ZYT8VMPNBGR79` reached `context_ready` at `22:43:08.775Z` and terminal success at `22:43:09.095Z`.

- Compressed size: **8,391,150 bytes**.
- SHA-256: `e0be70b6764d6b591aee646f223eba780c82f1f36be705973ee4e47fafcf7ca6`.
- R2 key: `compose-build-contexts/01KVRJCC7Y3NSDQYCPWDRPVJVH/01M717A2PE0C7MKTZMFJS46GZA/01M717NG24BB6ZYT8VMPNBGR79/1.tar.zst`.
- The source accepts only a 2xx PUT before invoking completion. Completion independently checks R2 HEAD size and recorded SHA metadata. The exact successful PUT status was not separately logged.
- Independent Cloudflare R2 GET at `22:44:39Z` matched size and SHA; decompression/tar inspection found relative paths, an 8 MiB payload, Dockerfile, Compose file, and empty `.env`/`runtime.env` placeholders. Both synthetic secret markers were absent. Structured evidence: `build-context-takeover-instant.json`.

This establishes successful current transport on Instant. It does not prove the historical 403's root cause: the SigV4 header-binding fix is consistent with this result, but the original failing request lacked diagnostic evidence.

## VM composite evidence and remaining gap

The small VM requested 0.2 vCPU / 0.5 GiB, used claude-code, and obtained Hetzner capacity within about two minutes. Its healthy heartbeat and ready state reported the deployed release. It never called publish: the Claude agent treated parent-agent prompts as requiring human confirmation, even after read-only `get_instructions` inspection and one ordinary short publish prompt. This is an agent refusal, not an observed phase-2 collector/upload defect. No second VM, model switch, forged human identity, or alternate harness was used. The coordinator instructed cancellation and cleanup.

Evidence supporting, but not replacing, a fresh VM publish:

1. The earlier real VM run at `3b65a30f4501ceea29795a8bb78fc33a2dc52cd6` collected an approximately 8.39 MiB bundle and recorded its SHA before PUT returned 403. See `build-context-staging-upload-failure.json` for the exact descriptor.
2. `git diff 3b65a30f4501ceea29795a8bb78fc33a2dc52cd6..d97e8b167445da51567e1ac6ec3a0456bac30eda -- packages/vm-agent` leaves `internal/publish/contextcollect`, the rooted source route, and source-directory resolution unchanged. The upload-file change only adds bounded allowlisted error parsing and names existing response caps; PUT construction, headers, body and completion flow are unchanged. Main also changed ACP process cleanup, independently of this collector path.
3. Both runtimes execute `Server.collectAndUploadBuildContext` in `internal/server/mcp_build_context.go`: collection, callback-init, HTTP PUT with byte length/content type/SHA header, 2xx guard, callback-complete. The API now binds the SHA metadata header with `unhoistableHeaders` in `build-context-upload.ts`.
4. Deployment builds Linux/amd64 VM and Instant artifacts from the same Go source, compiler, flags, version and build date. `Makefile` targets `prepare-container` and `build-all` share `GOFLAGS`; `apps/api/Dockerfile.vm-agent-container` copies that generated binary. Deployment reported container binary SHA `a1ca5a7fafb6977cd7eab823a4f4d881fa6980e0e841dd469413325a63e9ad21`. Byte identity is expected from this reproducible pipeline; this report did not download/hash both live binaries independently.
5. Focused current-head route/source/owner/shadow tests passed under the race detector, and CI VM integration passed.

Unverified at the current head: a contiguous live VM Docker-volume-root acquisition/collection/PUT/completion; VM-specific authenticated source-route behavior in that live call; and Hetzner DNS/TLS/HTTP egress to the presigned R2 endpoint. Instant egress originates from Cloudflare Containers. These are explicit gaps for coordinator/Raphaël review, not self-waived acceptance criteria.

## Validation and review limits

At the deployed head: 184 targeted API tests in eight files, API lint/typecheck/build, migration ordering and runtime-tunable checks passed. Collector and ACP race suites passed; focused source/context/server race tests passed. [CI](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42709709964) functional checks, including VM integration, passed without retrying the tracked Node-feature fixture.

Broad local server tests failed an unrelated hibernation quiescence test that also reproduces on unmodified main `1065cd446`. A second run additionally exposed a snapshot digest race, filed as idea `01M716DTEP9VWYVGTZXX4DJY7R`; neither was changed here. Sonar S2083 remains the coordinator-accepted rooted `os.Root` sink disposition (current issue `AaG_7TLdyRj9CdSjTvmX`); Specialist Review Evidence remains red because the mandatory hold label is present. Supplemental merge review passed; completion review found no missing static implementation and correctly left live acceptance pending. Real Docker ignore parity remains unverified locally.

Main's latest migration was 0229 when merged; phase 2 keeps 0230/0231. Staging also contains unrelated `0230_capacity_pool_excluded_sources.sql`. Recheck main before merge; any rename requires avoiding replay of already-applied ADD COLUMN migrations, with coordinator approval for staging-only bookkeeping.

Previous-session `sessions_read(method=messages)` returned condensed history with `hasMore`, but no pagination argument is exposed. The PR/task/history and coordinator messages supplied additional context; full message coverage is not claimed.

## Cleanup

Immediate independent D1 audit at `23:01:31Z` found no active nodes/VMs, fixture tasks/workspaces/snapshots/profiles/environment/jobs/releases. The Instant tombstone records termination at `23:00:38.719Z`; the VM node row was removed by strict deletion. A historical placed VM admission remains with no task and no scheduled retry. Both tasks were cancelled and chats stopped before deletion. An Instant cancellation HTTP500 occurred after its terminal state was committed; the barrier aborted, D1 confirmed cancellation, and normal cleanup resumed. Authenticated dashboard smoke passed at `23:01:18Z`. The late D1 audit at `23:06:40Z` (over five minutes later) was equally clean, with no late VM. See `build-context-takeover-cleanup-late.json`. Post-cleanup R2 GET/hash still matched at `23:04:12Z`; see `build-context-takeover-retained-object.json`. Immediate audit: `build-context-takeover-cleanup-immediate.json`. The coordinator explicitly directed retention of the successful object for normal 48-hour cleanup rather than manual deletion with a read-only token. Its R2 Last-Modified is `2026-11-09T22:43:08Z`; expiry eligibility is `2026-11-11T22:43:08Z`, followed by the scheduled retention sweep. R2 is **not empty**. Shadow must be off, tasks cancelled and chats stopped before node deletion, with immediate and approximately five-minute-later D1 audits.

Latest main recheck at `23:04Z`: `49a5b84d9fe9423a76d1dbf211186e44854c2c09` (#2604 eviction changes), still migration maximum0229. The deployed branch includes main1065cd446; it has not incorporated the later eviction PR.
