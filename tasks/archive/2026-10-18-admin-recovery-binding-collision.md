# Admin conversation recovery binding collision

## Problem

Idea 01M55GNWQNFYWSV360H2F811BC: supported continuation of task 01M52PEXV56VPD7H8541HP8EFJ/session e75b9a9f-82d2-497e-8250-abdb847c315d fails UNIQUE workspaces.chat_session_id. PR #2304 already shipped; latest policy correction remains unprocessed.

## Research

- Baseline main 5b79e6c12f1a9510ddfa523ae36e406f69860b7e already clears snapshot workspace transactionally in services/session-recovery.ts.
- Read-only production correlation: snapshot generation 01M53NDX2AB1YXXKBC80WH3X16 points to deleted workspace 01M53M4GQMH88AWZXN0G63RZ2G, which is unbound. Later deleted workspace 01M54VRNDJFH7PQ5B4KMHNZ2BP retains the session binding. Original task is sleeping/workspace null.
- Snapshot waking/attempts 3 with exhausted-budget refusal. Check failure anchor/deletion markers before recovery recommendation.
- Real writer task-runner/session-linking.ts binds workspace before linking ProjectData. Existing integration helper omits unique constraints; regression must create the actual unique index and follow the real writer.
- Relevant lessons: rules 35 vertical slice, scoped 45 concurrency, 66 ownership handoff; preserve stable task and predecessors, use existing snapshot lock.

## Checklist

- [x] Reproduce mismatch with unique constraint before diagnosing/fixing
- [x] Small transactional fix scoped to exact session/project/user and safe retained predecessors
- [x] Tests: task identity (transcript requires staging),, retained predecessors, repeated/concurrent one-runtime wake, untouched unrelated/live bindings and stale attempt fencing
- [x] Assess original owner's supported continuation versus separate approval requirement
- [x] Full relevant quality checks and specialist/Astra review (reconciled 2026-10-26: #2377 body — frozen `pnpm turbo run lint typecheck test build` 47/47 PASS; CI 39174836693 success on frozen head `00d2928b8`; specialist table all PASS; Astra source approval of `00d2928` recorded)
- [x] Draft PR initially; exact-head CI and CodeRabbit request/wait (reconciled 2026-10-26: #2377 timeline — ready_for_review 2026-10-18 23:40 UTC, then coderabbit-review label; request run 39177521068; CodeRabbit APPROVED `00d2928` at 23:45:52 with no comments; CI 39174836693 success)
- [x] Existing lease coordinated, supported recovery journey verified on staging with free browser (reconciled 2026-10-26: #2377 body — lease seq266/267 confirmed and released at seq268; staging run 39175170174 success; free Playwright journey gave one claim, one replacement VM, all 15 transcript message IDs preserved; zero active VMs after cleanup)
- [x] Normal merge/release and basic production smoke, exact SHA/run evidence (reconciled 2026-10-26: merged as `f483db374`; main CI 39177935190 and production run 39178996406 success; #2377 body records 00:21 UTC smoke — `/health` 200, app 200, unauthenticated `/api/projects` 401)

## Acceptance

Regression red on baseline, green after narrow fix. Stable task/session/transcript retained; no duplicate runtime under repeated/concurrent continuation. No live/unrelated binding changes or predecessor deletion. Supported staging continuation verified; no full production test or raw repair. Real-owner limitations described before any exceptional production mutation.

## Constraints

No admin reimplementation, autosave #2366, held legacy PR merges/closures, credentials/permissions/security network/spend changes, paid browser, raw production repair or broad dispatch rewrite. Astra reviews concrete design/draft PR before merge. Preserve resumable state through deployment verification.

## Verification and original-owner limitation

- Local regression failed with the exact UNIQUE error on baseline using real ensureSessionLinked and real SQLite unique index; passes with transaction extension.
- 66 focused tests passed before two extra status-with-marker controls. Full repo validation ongoing.
- Production read-only confirms both predecessor workspace and node deletion markers. Original snapshot recovery_failed_at NULL, recovery_claimed_at 2026-10-17T17:14:23.689Z, attempts3, expires Oct24. No supported budget reset route exists; binding release alone cannot recover this owner. Added normal-continuation reconciliation of this exact task-reported stale collision: reconstruct only the missing failure anchor after strict deletion proof, retain attempts and existing cooldown/reclaim CAS. Real owner still untested; no production repair performed.
- Sol profile 01KSSMJCG4EE1XS153GNZX5B09: gpt-6.1-sol, medium effort, conversation/lightweight. Runtime OPENAI_MODEL agrees.
- Task-only direct-main push rejected by required Durable Object Workers check; retained required gate and carried task on assigned branch.
- Local ProjectData boundary is mocked; real transcript continuation remains a staging gate.

## Post-mortem

What broke: supported wake failed a workspace-session UNIQUE binding after a prior unsuccessful wake.
Root cause: the stable-task wake transaction (introduced by #2230, ee80b0ee0) released only snapshot.workspace_id, although later failed wakes could own the unique binding on another retained workspace. Snapshot location is recovery content provenance, not necessarily the current runtime-binding owner.
Why missed: the integration SQL helper omits unique constraints; prior tests asserted wake admission without exercising the actual asynchronous link writer.
Process fix: regression explicitly installs the production UNIQUE index and executes ensureSessionLinked, with concurrency and conservative controls. Existing rule35 already requires this boundary-level coverage; no additional standing instruction added.

## Narrow exhausted-claim completion

Astra requested a supported path for the actual owner, not merely prevention of future collisions. `session-recovery-binding-failure.ts` reconstructs a missing clean-failure timestamp only when the exact stale attempt belongs to a sleeping task without a workspace, its recorded error is this binding collision after the claim, and the actual retained, snapshot and recovery workspaces have strict deletion proof. It normalizes the task failure timestamp to canonical ISO, does not reset attempts, and leaves the existing cooldown/reclaim CAS authoritative. Source/terminal/archive guards remain in the ordinary claim flow.

Focused tests cover direct unchanged attempts=3 before reclaim, cooldown, distinct live/unconfirmed recovery workspace, task/session/project/user mismatch, wrong/invalid/future failure evidence, replaced attempt at write time, retained existing anchor, concurrent reconciliation and exhausted wakes. Real D1 Workers test exercises UPDATE alias/RETURNING and correlated proof. All specialist source reviews PASS; execution results and live journey remain tracked in PR/state.

## Reconciliation 2026-10-26

- Shipped by #2377 (`f483db374`, merged 2026-10-18); first successful production deploy:
  run 39178996406 (head `f483db374`, 2026-10-19).
- Unticked: 0 — none.
- Verdict: ARCHIVE+FOLLOWUP. The binding fix worked in production, but the real owner's wake
  (task `01M52PEXV56VPD7H8541HP8EFJ`) then hit `SESSION_LINK_STATUS_REFUSED` on a stopped session
  and left replacement workspace `01M58RW8FASQNMBGY9PZ5EMS7Q` in `creating`. Owner task
  `01M58JARRQQ01A3DB9JEDA2E9G` was cancelled 2026-10-26; only the stale draft idea
  `01M55GNWQNFYWSV360H2F811BC` covers it, so record it in a backlog file.
