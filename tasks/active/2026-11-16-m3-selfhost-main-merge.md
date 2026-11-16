# M3: merge main into self-host integration

## Scope and constraints
Real merge of origin/main 726605541f01cbf8ca9e20f14bddf5f0e25115c6 into integration 9286831418dadd5db12ad68a36ffd3d44446beaf. PR base sam/selfhost-pass-2. Never merge: coordinator 01M7JMXS2JRW6QQMB1356ENPM3 reviews/merges. Explicit no staging deploy. Optional exclusive box verification. Model PR #2758.

## Research and impact
Main L5a owns classifier/guard, push checks, credential validation, agent sign-in verification, DNS checks, registry image guard and lint rule. Preserve only branch functionality not landed. 26 textual conflicts recorded in PR. Main composer extraction, JWT publish-job scope and S3 download helper intersect branch capability/rotation/operator-store adapters without adequate textual conflicts. Existing D1 duplicate prefixes are historical: preserve applied numbering; no newly introduced collisions.

## Implementation
- [x] Real git merge origin/main from integration parent.
- [x] Resolve main L5a ownership, delete inventory test, retain branch-only endpoint adapters.
- [x] Preserve main question-asks exports, Inbox/Insights and ComposeBuilderContainer.
- [x] Audit auto-merges, moved imports and changed signatures; fix composer/JWT/S3/deadline adapters.
- [x] Regenerate fetch baseline with each branch site guarded or acknowledged inline; list sites in PR.
- [x] Verify D1 and DO upgrade/first-install compatibility without renumbering applied migrations.
- [x] Run build,typecheck,lint,migration-safety,wrangler-bindings,file-sizes,selfhost:test and conflict unit suites.
- [x] Local security, Cloudflare, UI and completion reviews addressed.
- [x] Check box availability; run final-head chat/task if free or document owed run.
- [ ] Open PR against integration, run full CI, mark ready only after required checks.
- [ ] Publish PR handoff and landing shortstat to channel and idea.

## Acceptance
Merge commit retains both parents; no rebase/cherry-picks. Main landed implementation wins while branch-only behavior survives. Required checks and complete conflict/site lists recorded in PR, plus landing-progress shortstat before/after. No merge to integration or main by this task.

## Evidence
Before origin/main...integration: 872 files changed, 87507 insertions(+),2379 deletions(-). Wrangler review:21 DOs,23 migrations,2 D1; four migration/wrangler gates pass; fresh270 primary+3 observability migrations and upgrade10 incoming migrations pass. Config tests6 files/180 tests. Web focused6 suites/127 tests pass. Further evidence lives in PR and local .do-state.md.

Full local verification: build18/18, typecheck36/36, lint22/22; pnpm test39/39 tasks (API17101pass4skip; web5360pass); selfhost582pass2skip. Baseline28files36sites, no added debt; deleted superseded AST inventory and all unused helpers. Security/Cloudflare/UI/completion/constitution/doc-sync reviews addressed;19 Playwright cases pass with6 reviewed screenshots.

Live box upgrade6860e5e95 passed; real VM heartbeat and assistant pong18:54:28Z. Smoke task01M7JV47BE61YA0GSTB2D6S573. Temporary VM/workspace/profile deleted, signed out; box backup/log, SSH user/key/firewall and local credential scratch removed. Box released. Subsequent commits contain tests/CI/task notes only, runtime identical. PR #2817 remains draft pending final-head CI.

CI merge audit: hosted-git now participates in aggregate needs and main draft skip; dedicated self-host paths select conformance/API units without widening Workers selection. Tracked-input scanner ignores generated bundles/screenshot scratch. Three CI contract suites132tests pass, targeted lint passes; runner budgets count branch hosted-git job.
