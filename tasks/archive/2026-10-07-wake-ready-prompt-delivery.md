# Authoritative wake-ready prompt delivery

SAM task: 01M4AXGMEWDEH8KRRQ4X0CW824. Source Idea: 01M0VZ205TN8A1JYHNJN77DS4F.

## Problem and scope

Queued prompts can wait saturated retry backoff after VM/Instant recovery completes. Wake progress broadcasts and Instant D1 recovery writes do not schedule delivery. Own delivery readiness, not sibling persisted runtime configuration/ACP semantics, warm pools, retention or snapshot optimization.

## Research

- Latest main 294556e89; no overlapping open implementation PR at initialization.
- VM wake-progress-notifier/state-machine publishes cosmetic restored notifications, including superseded runner path; readiness must validate recovery task/attempt and current runtime binding.
- Instant vm-agent-container recovery commits incarnation-fenced D1 state and lifecycle under lock. Signal after that commit, not on ordinary healthy reconciliation.
- Existing nudgePromptDeliveriesForTarget moves queued/retry_wait deadlines; preparing claims can subsequently overwrite the nudge with backoff. Retain an attempt-fenced marker and consume it only for a pre-send not_ready retry.
- Preparation has a configurable 5-second budget and intentionally cannot submit after timeout. Capability GET timeout currently marks runtime interrupted even after successful wake; disable recovery-on-timeout for that read-only request only.
- Existing claim/submission/receipt fences and admission stay authoritative. Failed signaling falls back to existing bounded retries/TTL.
- Full Idea and library sleep-wake-performance.md read. Scoped DO concurrency/control-loop rules apply.

## Checklist

- [x] Add D1-authority-validated, runtime/recovery-attempt-fenced readiness RPC with duplicate suppression.
- [x] Immediately schedule eligible deliveries, preserving original ordering and preparing-timeout races without touching possible-send claims.
- [x] Connect committed VM and Instant wakes; preserve cancellation/replay/admission safeguards.
- [x] Fix proven capability timeout race using existing transport option.
- [x] Add phase timestamps and deterministic saturated-backoff/duplicate/stale/race tests.
- [x] Update affected docs and source Idea.
- [x] Run applicable lint/typecheck/tests/build and independent specialist reviews.
- [x] Coordinate pinned staging with siblings/occupants; measure user-message→ready→actual prompt start for both runtimes, verify no residual retry wait, clean owned resources.
- [x] Validate task completion and archive evidence after independent final review.
- [x] Create PR2262 and pass applicable CI.
- [ ] Complete best-effort CodeRabbit, reconcile merged runtime PR2261, merge PR2262 and verify production deployment (shipping gates after evidence archive).

## Acceptance

Current committed wake schedules eligible prompt delivery at configured minimum alarm delay despite saturated backoff. Duplicate/stale signals cannot release new work or replay submissions. Readiness preceding preparation timeout is retained exactly once. Ordering, receipts, cancellation and admission remain enforced. Live VM/Instant evidence includes timestamps and cleanup; CI/reviews/merge SHA/deployment proof recorded.

## Review and test evidence

- Independent Cloudflare/constitution reviewer PASS after fixing authority-read interleaving, moving VM signal before optional chat feedback, and preserving FIFO across transient retry_wait. Both claim and alarm use the same predecessor predicate; urgency priority is unchanged.
- Independent test reviewer PASS: Workers/SQL/adapter tests independently verified, final Instant integration22/22 independently rerun. Exact producer-hook coverage58/58 and actual five-second capability transport timeout15/15 pass. Independent-target and no-immediate-alarm-loop regressions preserve useful alarm scheduling.
- Full lint13 tasks, typecheck19 tasks and build9 tasks PASS. Full API821 files/11500 tests PASS with8 workers (128.21s); other20 root test tasks passed. An initial parallel root test/build invocation raced Astro's shared temp file; the sequential build/test rerun resolved that harness artifact. Import-pressure timeouts passed focused reruns with no production changes.
- Final readiness Workers3/3 PASS; unchanged preparation Workers3/3 previously PASS. The existing Instant vertical fixture now models real ctx.waitUntil and fenced ProjectData readiness RPC against actual migrated SQLite; ordered same-target admission replaces its obsolete concurrent-preparation expectation.
- Rule45 discrimination: isolated wakeReadyLock bypass fails expected1 versus actual2 authority-read entries. The strengthened test counts entry before D1 await; intact mutex passes, failed authority reads do not wedge the chain. Temporary mutation worktree removed; no mutation entered the branch.
- No new polling or global retry interval change. Readiness RPC reuses WAKE_PROGRESS_BROADCAST_TIMEOUT_MS. Candidate selection narrows to one active delivery per target and excludes pending predecessors; existing maxCandidatesPerAlarm, receiptTimeoutMs and TTL bound work. Each authority check is one parameterized D1 read, then local SQLite updates and existing alarm recalculation. No VM provisioning added by implementation.

## Operational evidence

Reviewed source commit dc18fa816; final regression commit827ed4bd2; validation evidence0498e292e. Source Idea updated without marking broader deferred scope complete. Shared staging coordinator owns pinned combined deployment with runtime-contract and archive siblings. Occupant webhook run37607076979 and manual verification/cleanup recorded successful in PR2260; handoff coordination continues. Contract sibling reconciles its unapplied D1 migration0184→0185 against applied webhook0184; own ProjectData migration061 has no collision.

VM/Instant phase timestamps and real ACP prompt-start evidence are complete below; PR2262 is open and all applicable CI is green. Shared fixture cleanup and final task-completion validation remain pending before archive. CodeRabbit, merge and production verification follow the remaining normal gates. Earlier staging failures below are retained as dated investigation history.

Live staging run37611247210 succeeded including smoke on combined3c9792edd, then a conflicting webhook deployment37613801900 overwrote the claimed environment: independently verified Cloudflare active342740d0 at100% from11:32:19, replacing validatedbf2f0be9. Parent coordinates restoration; all new sleep/wake/flag/cleanup mutations paused and resources preserved. Prior owned Instant task01M4B1WMXBKPP3FF2Q37GBDP0V failed11:27:39 before overwrite: generated new task branch absent upstream during standalone clone; contract sibling owns task-semantic diagnosis, no blind redispatch. Shared owned project01M4B1N63Q5XE39D9SCQHSNDBH and existing VM/Instant records preserved. Read-only authenticated Playwright dashboard/project/settings navigation succeeded without page errors. Wake latency proof remains pending; real start will use Go `ACP Prompt started` lifecycle report keyed by deliveryId, since session state can synthesize promptStartedAt from acceptance.

### Verified Instant staging evidence

Final combined candidate `a1d340864b580dbe28d00a051c2f309aa02370cc`, staging run37617669770 PASS including smoke. Coordinator verified API5a86cabc/web415df321/VM-agent1f7b6c0b2 binary provenance; approved flag-only mutation changed version to a7db0912 with unchanged code ETagfd387f25. Latest main2aa6ceac5 reconciled cleanly; post-reconciliation Workers3/3 PASS.

[Bounded redacted source evidence](../evidence/2026-10-07-wake-ready-delivery/instant.json) records the original Sol model/effort/task contract, exact delivery IDs, readiness producer log, actual Go ACP lifecycle rows, retry/acceptance activity and terminal deliveries. A user1791375784163 → ready1791375803660 → actual ACP1791375805929: 19.497s recovery, 2.269s ready→start, 21.766s total. Its old retry deadline1791375810169 was bypassed by4.240s. Signal completed1791375803869 and released2 deliveries. B actual ACP1791375836805 followed A; both exact tokens appeared in order, both acked with nextAttemptAt null, session idle/task awaiting_followup. B busy retries while A ran its harmless sleep are expected admission safeguards, not residual wake retry. Runtime sibling now owns same-session callback/git/completion proof; cleanup follows its release.

Artifacts-only failed fixture task/profile cleanup200 after preserved diagnosis and explicit parent replacement approval. One replacement GitHub-backed Instant task01M4B4YQ4F2HF0YX5Q62MGFVPN/profile01M4B4YC23EYXEPR5DA299H9V4 preserves gpt-6.1-sol/auto/task; no unsupported VM-only retry route, no model override or extra VM. Original VM wake capture remains pending runtime provisioning; bounded120s read-only capture ended with evidence preserved and no cancellation.

### Verified VM staging evidence

[Bounded redacted VM source evidence](../evidence/2026-10-07-wake-ready-delivery/vm.json) preserves original chat/task and restored Sol contract, readiness producer, actual Go ACP event, retry deadline transition, activity and final idle/token/ack. Delivery01M4B5307BFWR7M84F546W9B0Y: user1791375802603 → ready1791376154493 → actual ACP1791376156400. Recovery/provisioning351.890s; ready→actual start1.907s; total353.797s. Signal finished1791376154736/released2. The parked deadline1791376223132 was bypassed by66.732s; final acked/nextAttemptAt null. Original chat recovered on replacement workspace01M4B5BEDFZBYFTJCSQA65TVBE/node01M4B53CBBF17ZTNDNX8455QJB; exact CONTRACT_VM_CHAT_WAKE_READY and idle1791376185088. No cancellation or duplicate wake after bounded capture timeout. Delivery scope released; runtime-contract checks and coordinator archive/cleanup remain pending.

Independent Instant evidence review PASS recomputed every duration and verified real ACP attribution. Limits explicit: live Instant A bypassed10-second retry; saturated maximum backoff is proven in deterministic tests. The harness issued one owned sleep/wake; this is not an exhaustive runtime-attempt count. VM live evidence bypassed an80-second parked deadline at capped attempt ordinal.

Playwright loaded-chat verification PASS after dismissing the normal setup overlay through Exit setup; owned Instant session header and Send control visible, no page errors. Screenshot visually inspected; [redacted browser record](../evidence/2026-10-07-wake-ready-delivery/browser.json). Older wake replies are in virtualized/paginated history, independently verified through persisted transcript; no UI implementation change. Coordinator explicitly authorized own PR/CI now while runtime sibling retains same Instant fixture for its independently diagnosed callback credential-context fix. Final owned cleanup and completion/archive validation remain merge gates.

PR2262 opened after coordinator approval with feature staging evidence and retained sibling fixture. CI AST checker flagged inline static SQL predicate calls; refactored full claim/alarm queries into module-owned constants with identical SQL/parameter bindings, no scanner suppression. Independent correctness/security review PASS; AST0errors, readiness unit14/14 and Workers3/3 PASS. No runtime behavior changes; prior live proof remains applicable. All applicable CI passed on final head f7d4619d5100894322e38949946d92ad46f6251f in run37623181381: root21 test tasks, API821 files/11502 tests, web336 files/4023 tests and Durable Object Workers108 files/1357 tests; lint, typecheck, build, quality, smoke and SonarCloud passed. Final cleanup/archive, best-effort CodeRabbit and merge/production gates remain pending.

### Final prearchive assessment

Independent completion reviewer found no remaining code, regression, live-latency or behavior-documentation gap. The earlier prearchive verdict was WARN pending shared cleanup; the final fulfilled receipt and PASS below supersede that state. Runtime sibling owns the retained Instant callback/Git/PR and MCP completion proof, public Stop/container-zero and owned PR/branch cleanup. Preserve its completed task audit. Delivery deletes only temporary profile01M4B4YC23EYXEPR5DA299H9V4 after explicit fixture release and verifies404. Coordinator owns original conversation ArchiveLAST, restored interaction flagsfalse and final owned compute/container-zero proof. No delivery staging mutations or additional resources while the shared lease is held. Future merge and production verification remain shipping gates after validated archive.

### Owned fixture cleanup

Runtime sibling proved actual same-session automatic Git/PR and original MCP completion: task01M4B4YQ4F2HF0YX5Q62MGFVPN completed2026-10-07T15:35:24.117Z/errornull; exact local/remote/PR commit38530c93911c4bfd05b385e7bbce8b2e2c7f89bd, owned fixture PR4 closed and branch404. It stopped the runtime through the public API and explicitly released only profile cleanup. Delivery independently read owned workspace/node statusesdeleted and snapshotcount0, then deleted only profile01M4B4YC23EYXEPR5DA299H9V4 (200→GET404). Completed task GET200 retained identical completion timestamp/outputPR; no task audit deletion. [Redacted cleanup proof](../evidence/2026-10-07-wake-ready-delivery/profile-cleanup.json). All API/browser/capture contexts closed; delivery released for sibling sequential Manual Instant check/finalflagsfalse and coordinator ArchiveLAST/sharedzero proof.

Evidence-only task-note head5cbc99ea5 passed all applicable CI in37640036496. Final shared metadata increment deployedbbaee36fd5a6126d1bb4e0305a2886b636ed4e5d: childdeploy112858915274 succeeded, overall37640782379 failed before creating smoke job. Coordinator recovered the gate with the exact existing live smoke suite12/12PASS, verified activeAPIaaa1ff32/codeETag35c82b7f/agent1120/web282c7897 and parent explicit release. Reviewed import-onlyad16 is source evidence, not relabeled as the deployed bba. No blindredeploy/newVM; flags and same fixture remained under sibling ownership.

Runtime owner final staging release: actual Manual Instant Write card8708edb6 Yes→delivery_confirmed/Write/idle/zeroJS PASS; owned Stop200/profile200→404/snapshot0, completed audits retained. Finalflags restore37648102691SUCCESS/API8b19aee2-667a-4824-bb50-60ff7bd4c180/unchanged ETag35c82b7fa0c8a03c160dd6d72cc7ae5c7408bb86029406e5e8385810ccad57a9. Delivery independently read all three ACP interaction flagsfalse/355 bindings and D1liveNodes=[] after final release. Coordinator original ArchiveLAST receipt remains the sole prearchive operational gate; no further delivery staging mutations/resources.

### Final shared cleanup gate fulfilled

Coordinator and parent final receipts confirm original ArchiveLAST normal mobile dockPOST200/closedAt2026-10-07T16:06:11.797Z, repeat200/sameclosedAt, exactly1completed event (before0), originalworkspace/snapshotabsent, all3originalR2GET404/liveNodes[]. Original temporary profile200→404; completed task/chat/project audits retained. Manual Instant strict termination and snapshot0 reviewed; finalflagsfalse and migrationledger unchanged. [Bounded redacted shared cleanup receipt](../evidence/2026-10-07-wake-ready-delivery/shared-cleanup.json). First Instant public Stop500 recorded as nonblocking follow-up Idea01M4BH36AZV3Q2J8MH43JXY8M6; one bounded idempotent retry succeeded, no broad fix added here. No remaining staging mutation/resource or operational cleanup blocker. Final independent completion validation precedes task archive. Merge order2261→2262→archive; this task owns only2262 and will reconcile runtime/main overlap before merging. CodeRabbit and production proof remain honest future shipping gates.

### Final task-completion validation: ARCHIVE PASS

Independent wake_docs_completion_review revalidated the actual diff, test suite and all four phase/browser/cleanup evidence records. A research→checklist PASS; B checklist→diff PASS; C acceptance→tests/live PASS; D UI→backend N/A; E runtime selection PASS; F vertical slice PASS. No implementation, evidence, documentation or operational cleanup gap remains. Both new cleanup JSONs included with archive move. CodeRabbit, reconciliation after runtimePR2261, mergePR2262 and production deployment verification remain future shipping gates and are not asserted complete by archive validation.
