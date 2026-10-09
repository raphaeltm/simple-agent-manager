# CLI project workflows for assistants and voice

## Problem / authorization
Raphael approved the audit plan in PR #2291 and requested full implementation, green PR, testing and shipment on 2026-10-09. This supersedes audit-only/no-merge for this task. Preserve independent Attention fix PR #2290 ownership; consume its reviewed change without duplicating it.

## Research
- Audit: `docs/audits/2026-10-09-cli/README.md` on implementation branch.
- CLI: `packages/cli/internal/cli/{run,args,commands,client,types,project_resolve}.go`; current parser silently drops flags and task aliases bypass project resolution.
- API: task submit/CRUD, chat list/message/prompt/interaction, profile/skill service resolution, project settings/runtime and resource routes.
- Existing APIs already support most operations. Preserve real endpoint verbs and capability/creator restrictions. Add server receipts only where retries genuinely require them.
- Current transcript API uses exact `[createdAt,sequence,id]` cursors; CLI loses metadata and fetches one page.
- Settings scope: safe inspection and rename/description; consequential access/credentials/permission/billing/runtime/deployment/destructive writes deferred. Do not expose an unbounded raw patch escape hatch.

## Implementation checklist
- [x] Common strict command/flag/arity contracts and contextual discoverable help; unknown flags fail before HTTP.
- [x] Shared complete project resolution, scoped profile/skill exact ID/name resolution and fail-closed explicit hints.
- [x] Full supported JSON, project summary counts, project notifications, redacted structured errors and bounded HTTP cancellation.
- [x] Pageable task/session/project/Idea/library/context/notification/activity inspection, complete bounded transcript export, tool-content and metadata.
- [x] Task/Idea create/get/update/linked execute/wait; stdin/file prompt input, skill selection, attachments.
- [x] Safe submit/prompt receipt/idempotency and unknown-outcome reconciliation; no blind retry.
- [x] Session send/cancel/sleep/fork/retry and non-permission attention answer; permission/auth requests inspected and left human controlled.
- [x] Profiles/skills scoped inspect/create/clone/update using approved ordinary fields; security/resource fields rejected, global writes rejected unless backend supports them.
- [x] Settings safe inspect and rename/description only; no mutation of user settings during verification.
- [x] Remaining sidebar reads: comments, repository files/ref/compare, library/download, memory/policies, events, triggers, deployments.
- [x] Scoped draft metadata, notes/replies and library artifact writes implemented. Trigger pause and schedule/watch automation writes explicitly deferred under original conditional decision boundary; no implicit sends/launch/permissions/secret outputs.
- [x] Exact contract/regression/integration fixtures and CI API/shared→CLI coverage coupling.
- [x] User documentation and audit status updated to actual implemented commands.
- [x] Full local validation, task-completion validator and specialist reviews completed; staging smoke/cleanup is a pending external gate tracked below and in PR #2291.
- [ ] PR green, CodeRabbit requested/waited/addressed, merge and production deployment verified.

## Acceptance / tests
All approved audit phase acceptance criteria apply. In particular: unknown dry-run/skill/misspelled flags never make HTTP; invalid project/profile never changes scope/agent; full JSON and pagination never silently claim completeness; tied-time transcript drain contains no gaps/duplicates; lost-response keyed submission/message replays same identity and changed intent conflicts; denied scopes and disallowed settings fields cannot mutate; integration fixture traverses resolve→submit→inspect→continue→finish; all CLI Go race/coverage/vet/cross-build and applicable TS lint/typecheck/test/build pass; staging covers affected command/API flows with synthetic data; PR review gates and deployment succeed before completion.

## References
`packages/cli/.claude/rules/36-cli-quality.md`, API scoped rules, `/do`, staging rule 13, review rule 25, constitution simplicity/configuration principles. Maintain local `.do-state.md` and durable PR state.

## Specialist review and validation
Go/security/Cloudflare/constitution/doc/completion specialists completed and identified actionable fixes. Implemented prompt-safe errors, unknown accepted-write response outcomes, ambiguous selector rejection, exact effect flags, deadline exit semantics, builtin immutability, bounded configurable receipt buffers and corrected help/OpenAPI. Task completion re-review finds substantive gaps fixed; legacy full-JSON regression added. Test-engineer added real SQLite + actual submit route fixtures: metadata lifecycle and explicit Sol/skill propagation for VM/Instant × task/conversation; compiled CLI fixture proves replay admits one runner. Full pnpm test passed serially; final post-review validation, staging and shipping gates remain pending.

## Verified implementation / external gates
Final local lint, typecheck, full test and build passed. Go race coverage82.1%, vet and allfourcrossbuilds passed. Compiled CLI/actualWorker fixtures24tests passed; receipt/metadata security fixtures20passed; deployconfiguration48tests passed. Allspecialists returnedPASS/ADDRESSED including finalwait130review. CI713bcbcbf green. Task implementation is archived under the workflow's pre-PR validation step; this does not claim merge or production deployment success.

Stagingrun37931969807 applied receipt migration0189 but failed during existing container dependency download (express5.3.0tarball404); registry now resolves and integritydownloadpassed. Retry37934236387 is in progress on713bcbcbf. LivePlaywright smoke, cleanup, CodeRabbit, merge and production deployment remain explicit external gates; current evidence and final outcomes are maintained in PR#2291 and SAM task progress, without falsifying future checkbox completion. Consequential settings/automation decisions remain deferred as approved.
