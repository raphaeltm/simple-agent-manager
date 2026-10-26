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
- [ ] Predicate/parser/context/API/MCP/UI tests and compatibility with A review bursts
- [ ] Local validation + specialist reviews + actual Opus UI review on pushed branch
- [ ] Shared staging verified without overwrite; Playwright desktop/mobile evidence posted
- [ ] PR gates/CodeRabbit/merge/deployment/basic production smoke

## Acceptance

Actor means authenticated webhook sender, never issue author; author association belongs to acted-on content and must not authorize another sender on edit/delete/label actions. Each scoped predicate has in/out-of-scope tests and missing in-scope fields fail safely. Stable comment IDs/URLs and subject URL survive parsing. New settings roundtrip across API/MCP/UI. Review bursts use A's subject routing. No expression engine or parallel delivery system. Report issue scope and constraints explicitly.

## Validation / release ownership

B pushed f8ae0aed2, 37c7e9560, 2384a3638 on assigned branch. Local security/CF/constitution review no blocking findings; completion/tests/docs review missing-subject and commentUrl findings fixed. Backend137focusedPASS plus61postfixPASS, web73PASS, API/web typechecksPASS, shared buildPASS. Playwright2PASS with ten inspected desktop/mobile screenshots in tasks/evidence/2026-10-26-github-trigger-controls. Actual Opus task01M5WHY3EFHN326WD32KP7ACJT is in progress, no approval yet.

A task01M5WD679VMV8R0MF24STHPRDC owns single combined integration/staging/release PR. Preserve queue fields during integration and prove a submitted review plus N inline events route compatibly. B will address Opus findings and provide pinned reviewed commit. Archive only after completeness verification of combined gates, before merge. Do not close #2419; expression/regex Idea01M5WE2TEWEBMCRF6YKCGE3EDT remains.
