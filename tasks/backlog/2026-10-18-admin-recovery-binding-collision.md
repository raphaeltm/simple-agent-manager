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
- [ ] Reproduce mismatch with unique constraint before diagnosing/fixing
- [ ] Small transactional fix scoped to exact session/project/user and safe retained predecessors
- [ ] Tests: transcript/task identity, retained predecessors, repeated/concurrent one-runtime wake, untouched unrelated/live bindings and stale attempt fencing
- [ ] Assess original owner's supported continuation versus separate approval requirement
- [ ] Full relevant quality checks and specialist/Astra review
- [ ] Draft PR initially; exact-head CI and CodeRabbit request/wait
- [ ] Existing lease coordinated, supported recovery journey verified on staging with free browser
- [ ] Normal merge/release and basic production smoke, exact SHA/run evidence

## Acceptance
Regression red on baseline, green after narrow fix. Stable task/session/transcript retained; no duplicate runtime under repeated/concurrent continuation. No live/unrelated binding changes or predecessor deletion. Supported staging continuation verified; no full production test or raw repair. Real-owner limitations described before any exceptional production mutation.

## Constraints
No admin reimplementation, autosave #2366, held legacy PR merges/closures, credentials/permissions/security network/spend changes, paid browser, raw production repair or broad dispatch rewrite. Astra reviews concrete design/draft PR before merge. Preserve resumable state through deployment verification.
