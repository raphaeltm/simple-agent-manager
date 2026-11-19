# Bound Library multipart memory without changing stored encryption

## Assignment and scope

Shepherd task 01M7NBB7PJCTYXS7MY1T1DTGZ3 completes scanner #2869 at 48055f93b090f64c0a4abaaf2ad580eee7c7544d. Replacement: #2874. Preserve original branch/history, no force push or deletion. Routine verified merge is authorized after every gate. No human draft-only hold was found after complete comment/review, association and owner reconciliation. Backend Implementation profile 01KSWW2DQTZ8N3F2PYXKMJ7QZZ verified openai-codex; credential usage 52% weekly/OK before heavy work.

Scanner's new chunked AES-GCM format is outside this correction. Existing encryption, R2 metadata, keys, D1 schema and shared operations remain unchanged. Residual research is preserved in SAM Idea 01M7NDQJA4EDKMXQRG2YWHXCF5, linked to the scanner. New crypto/storage design requires independent review and a human decision; no such design is needed here. Shared Library seams were coordinated with CSRF completion task 01M7NB9FZNC4CXG6MGXJDQJM1C before editing.

## Reproduced defects

1. Installed Hono 4.13.4 parseBody retains raw multipart bytes and FormData before the file-size check. A 1 MiB fixture retained 1,048,763 raw bytes plus a 1,048,576-byte parsed file. Native formData and Hono bodyLimit do not supply the required incremental actual-byte bound.
2. Browser-only admission was insufficient: independent real uploadFile/downloadFile/crypto/SQLite reproduction held 152.2 MiB for legitimate concurrent 50 MiB upload/download. The initial isolated-write review was withdrawn.
3. Existing MCP workspace Blob/FormData left 50 MiB backing after successful transfer. The next sequential encryption reached about 154 MiB including heap/embedder, independently reproduced in real workerd and HTTP transport without forced GC.

## Smallest complete correction

- Pinned standard incremental multipart parser 1.1.1; actual wire-byte checks independent of declarations, bounded metadata/headers/parts/deadline, 64 KiB BYOB/coalesced allocations and deterministic owned-buffer release. No Hono full-body cache.
- Five canonical Admin Settings control multipart file ceiling, overhead, part/header counts and ingress time. Browser limit is min(legacy limit, canonical ceiling), never above 50 MiB. Agent size limits remain existing behavior.
- One canonical per-isolate Library materialization permit before buffering across browser writes, HTTP reads/previews, MCP transfers and diagnostic capture. No queued file buffers. Busy browser requests receive 429; MCP returns a retryable capacity error without error-log noise.
- Download ciphertext is released after decrypt. HTTP plaintext/permit follows bounded response consumption/cancellation/deadline. Timeout does not free admission while a late load is still live. Callback consumers retain ownership through actual awaited consumption.
- Workspace upload uses standard streamed multipart wire encoding with random boundary and WHATWG filename escaping, bounded copied byte-stream chunks and no full-file Blob. Ownership lasts through body termination and exposed transport settlement. Opaque timed-out container RPC may retain copied chunks, never a whole-file plaintext view.

## Budgets and compatibility

Default file: 50 MiB; overhead/metadata: 64 KiB; parts: 16; headers: 8 KiB; ingress: 120 seconds (about 427 KiB/s at the outer limit); parser buffers: at most 802. Fixed 64 KiB chunks and single-flight admission implement the memory invariant rather than speculative tuning controls.

Existing download timeout defaults to 60 seconds separately for load and HTTP egress (about 854 KiB/s per 50 MiB phase). MCP retains its existing transfer timeout. Full-metadata foreground upload budget is at most 12 D1 + 1 R2 operation; real combined-app measurements are 13 cold upload, 10 warm upload, 8 replacement. Counts include auth, settings, directory and tags; existing waitUntil work is separate. No per-part I/O.

Normal 50 MiB upload/replacement/download and existing preview/range/HEAD behavior are tested. Independent pre-correction ciphertext generated from f5a116bd6 is seeded directly in R2/D1 and downloaded through the authenticated Worker, without a current writer producing it. Existing overlong VM ingress is separate residual research; do not claim a verified bound above the tested 50 MiB contract.

## Validation and reviews

- [x] Actual-trigger regression fails on old route: original legacy cap 32, streamed body 3,000 bytes, old route consumes all bytes without cancellation; correction stops before tail.
- [x] 103 route tests, 14 ownership tests, 55 consumer tests and 106 transport/downstream tests pass in focused invocations (totals overlap).
- [x] 29 combined Worker tests pass: 50 MiB lifecycle and held-read overlap, historical ciphertext, length violations, existing serving and measured I/O.
- [x] Independent source security, Cloudflare ownership, constitution and implementation-completion reviews pass after both reproduced memory findings were corrected. Documentation qualifies opaque transport settlement.
- [x] Independent actual workerd external HTTP cancellation receives source cancellation in about 40 ms, releases plaintext and permit. SELF service-binding cancellation differs; Worker overlap test drains, external cancellation is verified separately.
- [x] Three real HTTP 50 MiB downloads followed by encryption succeed without forced GC: backing about 100 MiB, total below 128 MiB.
- [x] Independent actual MCP transport: three completed 50 MiB transfers, early response and stalled transfer followed by encryption all pass; maximum observed total about 108.83 MiB, no forced GC. Actual container RPC memory was not exercised.
- [x] Final full repository lint/typecheck/tests/build after Sonar corrections: 22/36/39/18 tasks passed; API 1,100 files and 16,780 tests passed (3 files / 4 tests skipped). Earlier fixture failures were corrected; no waiver.
- [x] Independent post-Sonar security/Cloudflare/constitution/docs/implementation-completion re-review passed at source commit c2fcfac46f64eb5c4a5eb1855f997f00da30b358. Fresh three-cycle 50 MiB parser/encryption probe peaked at about 107.79 MiB; all five MCP transport scenarios passed. Exact-head Sonar must still confirm all five received findings closed.
- [x] Received Codex HEAD finding independently reproduced for both download and preview: real automatic HEAD returned correct headers/empty body but the next upload was 429. Explicit disposal preserves GET/auth/range behavior; two actual combined-Worker regressions cover immediate upload/decryption. Independent source re-review passes; final runtime and full-suite results remain required below.
- [x] Received Codex debug-capture finding reproduced through the actual MCP route: occupied Library admission incorrectly returned invalid parameters. Canonical Operations runner now maps only typed HTTP 429 to the existing retryable-capacity wire contract. Five focused suites / 66 tests pass; invalid input and audit controls remain intact. All 17 runner consumers retain existing behavior except this typed-capacity classification; no retry execution is added.
- [ ] Final full quality rerun after the Operations mapping correction, exact-head CI, and resolution of received review findings. Trusted CodeRabbit request succeeded; latest response is Review skipped, so its best-effort wait ended without a waiver.
- [ ] Normal leased staging deployment, actual changed-flow verification including external cancellation/full app, unchanged observability noise gate and cleanup.
- [ ] Replacement verified merged, actual production deployment/basic health only, then concise scanner closure with full commit links and residual disposition. No production user-flow/provisioning tests.

## Release state

Replacement is ready after full local checks; exact-head full CI and trusted CodeRabbit review were requested in parallel with remaining release work. Both staging queues/owners checked; normal primary reservation run 44153749840 accepted, latest observed turn 21:31:52 UTC. No lease held or deployment yet. The unchanged primary 24-hour/threshold-10 observability noise gate fails on existing session/snapshot/providerless-node groups; existing repair task 01M7NHBKR3B9T4KPATYFCNA0X8 owns remediation. Preserve peer resources and require an actual unchanged-gate pass; this is an engineering blocker, not a human hold. Runtime/evidence artifacts and existing .codex/config.toml modification remain uncommitted. Task-only main push was rejected by protected-branch GH013; task record travels through this PR without bypass.

## Takeover correction (2026-11-18, Claude task 01M7PX40M0GEX6J4VXM4X7PV3T)

Independent security review found that the single per-isolate boolean permit refused every overlapping Library transfer, of any size. The Library page starts all selected uploads in parallel (`ProjectLibrary.tsx` `uploadLibraryFile` loop), and chat document cards fetch previews together. In one isolate, all but one of them got `429 Another Library transfer is in progress`. A new Workers test reproduced this on the original head: three concurrent 22-byte uploads, and the second upload returned 429.

Fix: the permit is now a 50 MiB byte budget (`library-memory.ts`, `acquireLibraryMemory(size?)`).
- A full-size or unknown-size transfer still takes the whole budget, so the measured one-50 MiB-file peak is unchanged. The existing 50 MiB overlap test still gets 429.
- Uploads reserve their declared Content-Length. `parseUpload` now refuses bytes beyond the declared length as they arrive, instead of only at the end.
- Previews (library and interactive host) reserve the stored file size. `downloadFile(..., maxPlaintextBytes)` refuses with 409 an R2 object larger than that reservation, which covers a replace racing the metadata read.
- Each reservation is at least 64 KiB.

Tests:
- `tests/workers/library-concurrent-previews.test.ts`: overlapping previews, parallel uploads, and the outgrown-object 409 with a control. The guard was deleted once, the test went red, and it was restored.
- Budget unit tests.
- Two upload tests were updated, because an understated length is now refused before materialization.

Residual: large concurrent transfers that together exceed 50 MiB still get 429. On main those would have exceeded the isolate's memory.

Re-review (fresh security-auditor on c0f23010): PASS, with one MEDIUM. A 64 KiB minimum was smaller than the two fixed 64 KiB buffers each upload holds, so about 800 tiny slow uploads could exceed the budget. Fixed:
- Every reservation now adds 256 KiB of fixed overhead (`LIBRARY_MEMORY_TRANSFER_OVERHEAD_BYTES`). That caps concurrency at about 200, and each transfer peaks at no more than twice its reservation.
- From the LOW findings: the Download route now reserves the stored size, after a `getFile` (+1 D1 read; GET download stays within the 8 round-trip budget).
- The weak download-reservation test now asserts that the budget stays held.
