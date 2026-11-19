# GitHub trigger controls, review events and MCP context

Issues #2419, #2420, #2422. Implement explicit structured controls without changing existing defaults; reuse normalized parsing, filters and context across ingress/recovery/manual preview and API/MCP validation. Generic expressions/regex remain a SAM Idea; #2419 stays open.

## Research

- github-trigger-filter.ts parses payloads and evaluates filters; stored filters separately validated. commandPrefix is event-scoped; preserve stale out-of-scope inert behavior.
- shared types/trigger.ts and github-trigger-contract.ts define event/action contracts; schemas/triggers.ts validates REST and MCP shared create service.
- GitHubTriggerFields + form-support + Automation editor build/read filter config.
- github_webhook_deliveries stores audit metadata, not payloads. github webhook inbox retains payload temporarily: inspect safe bounded feasibility for replay preview, disclose expired/unavailable data.
- A owns queue/admission/subject-affinity/migration0209 and queue UI. Coordinate shared schema fields and combined staging.
- Existing SAM branch/workspace reused; direct-main task plan push blocked by required checks on current repo (sibling evidence).

## Checklist

- [x] Shared event/action/filter/template contract and normalized parser
- [x] Scoped addedLabel/commentContains/isPullRequest/reviewStates + actors/authorAssociation/ignoreBots, fail closed on missing authorization data
- [x] Review and inline comments ingress, context and meaningful action/state/path/line
- [x] MCP create concurrency/skip/description and complete template guidance via shared services
- [x] Filter/review/context UI and serializers; bounded recent delivery filter test with honest payload availability
- [x] Docs: scopes/defaults/template variables/untrusted text guidance
- [x] Predicate/parser/context/API/MCP/UI tests and compatibility with A review bursts
- [x] Local validation + specialist reviews + actual Opus UI review on pushed branch
- [x] Shared staging verified without overwrite; Playwright desktop/mobile captures reviewed
- [ ] Desktop/mobile evidence posted in combined PR
- [ ] PR gates/CodeRabbit/merge/deployment/basic production smoke

## Acceptance

Actor means authenticated webhook sender, never issue author; author association belongs to acted-on content and must not authorize another sender on edit/delete/label actions. Each scoped predicate has in/out-of-scope tests and missing in-scope fields fail safely. Stable comment IDs/URLs and subject URL survive parsing. New settings roundtrip across API/MCP/UI. Review bursts use A's subject routing. No expression engine or parallel delivery system. Report issue scope and constraints explicitly.

## Validation / release ownership

A task01M5WD679VMV8R0MF24STHPRDC owns the single combined integration/staging/release PR. Final B3a2d77e2c is included in pushed integrated f76e77369659c1cd6862c5c8936ded5c0dec0cbb alongside mainb73. All four original/recovered local specialist reviewers completed; their findings and recovery lineage are recorded in docs/audits/2026-10-26-github-trigger-controls.md.

Actual required-profile Opus task01M5WQWV8QGFQV7EM3AWQHG239 final PASS at exact f76: zero open findings, rubric all4. Independently80webtests,24desktop/mobilebrowsercases,17probes including320px and error correction; final Library report01M5WTFTH01MST9PQNW5N7HRSS/channel47. All previous H/M findings and final N1/N2 residues were fixed. No further UI change without re-verification.

Integrated full baseline47/47qualitytasks PASS (API13929/web4769); subsequent focused UI111tests/24browser/typecheck/lintPASS, narrowed correction68tests/4browserPASS.60fresh committed captures cover both feature areas. Final PR CI remains required.

Pinned staging40385983738 and12browser smoke tests PASS; Cloudflare verifies exact f76 API at100% and migration0209. Supported live review burst PASS: signer40397144489 sends two inline comments/replays into ONEtask01M5WYW7FMAWM5GV0F7EY5RPZH/two replies. Editing SAME trigger to submitted review roundtrips settings; signer40398575145 plus replay yields3rows/2routed/ONEtask/three replies with file/line and changes_requested context. All fixture triggers/tasks/workspaces cleaned; sole owned node removed20:52:47, four pre-existing nodes untouched. Source evidence and bounded observations are in tasks/evidence/2026-10-26-github-trigger-queue/staging-acceptance.json. Desktop/mobile captures inspected; PR screenshot comment, CI, CodeRabbit, merge and basic production smoke remain release gates. Archive only after final task-completion validation of BOTH combined task files. #2419 expressions/regex remains Idea01M5WE2TEWEBMCRF6YKCGE3EDT.

Remaining #2420 scope: event type selection is singular and affinity per-trigger.
A submitted review plus inline-comment events on separate triggers cannot share one
run. Tracked Idea `01M5WKCK7431DQ4FKBWENZV9QJ`; coordinator/A notified for scope
reconciliation. Keep #2420 open unless the mixed-event acceptance is fulfilled.

Coordinator sequencing decision (2026-10-26): foundations ships review events and
per-trigger affinity. Combined submitted-review plus inline-comment single-owner
acceptance moves to PR-watch #2421 using canonical PR ownership and shared delivery,
with duplicate-wake suppression across watches/triggers. This remains unmet #2420
scope, tracked by Idea `01M5WKCK7431DQ4FKBWENZV9QJ`; do not use Closes #2420.
Combined staging must still prove supported same-trigger review bursts.

Final pre-archive task-completion/doc-sync review: PASS for BOTH combined tasks at f76 after all live acceptance and cleanup; no missing implementation acceptance. Release checkboxes intentionally remain pending until the combined PR completes CI, CodeRabbit, merge/deploy and basic production smoke.

CI test-only correction21:13UTC: Workerd MCP update response now asserts intended normalized queue defaults via exported constants (8focused worker tests PASS). Existing unrelated comment deep-link scroll assertion awaits its React effect with waitFor (15focused tests PASS before and after); no assertion removed. Both files lint and diff checks PASS; independent completion review PASS. No runtime or UI source changes from actual Opus-approved/staging-proven f76. Final-head CI remains required.
