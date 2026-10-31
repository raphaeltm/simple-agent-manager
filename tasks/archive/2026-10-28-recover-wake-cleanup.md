# Recover wake cleanup and investigate silent reschedule

## Problem

Older VM agents cannot confirm workspace physical deletion through the new endpoint. Preserved sleeping workspaces stay stopping, block wake, and prevent incompatible-node retirement. The previous implementation session was evicted during resource-heavy validation, restored, and then produced no output despite accepted ACP prompts. Its changes were not pushed.

## Evidence

- Exact parent transcript reviewed through SAM get_session_messages, then search_messages.
- Production D1 confirms original cleanup retries receive HTTP404; snapshot remains available.
- Parent replacement workspace and ACP LoadSession succeeded; continuation prompt was started, then cancelled by user follow-up after 16m36s. Underlying runtime stall cause remains unproven.
- Saved WIP exists but current diagnostic credential cannot download R2 objects (403). Reconstruct the small fix from verified code and prior findings.

## Checklist

- [x] Inspect production and previous session before editing.
- [x] Allow incompatible managed VM retirement only after all remaining sources are safely preserved.
- [x] Fence claim against active/new siblings, placement, owner/incarnation/generation changes.
- [x] Reverify R2 artifacts immediately before provider deletion; retain wake fence until termination proof.
- [x] Regression tests exercise real SQL and snapshot verification, including failures and races.
- [x] Local specialist/completion review and focused validation; full repository results tracked in PR.
- [x] Staging explicitly waived by user.
- [ ] Green PR, best-effort CodeRabbit request/wait, merge, production deploy and basic smoke.

## Acceptance

Older-agent cleanup can converge via safe drained-node retirement without trusting legacy DELETE success. Active work and unpreserved data remain protected. Provider failure does not release wake. Report the separate stalled reschedule honestly and fix any proven in-scope cause.

## Review and validation evidence

- Cloudflare/security local reviewer: PASS after fixing unsafe-candidate backoff and partial-budget starvation; final semantic commit 23324d3ae.
- Completion/test/constitution/doc local reviewer: PASS at 23324d3ae.
- Go/runtime reviewer: successful ACP restore and prompt acceptance do not prove an adapter/model response. Current 4h task-age / 60m silence defaults exceed the observed 16m and 8m windows. No speculative runtime change included.
- 31 new regression cases use real SQLite, the real snapshot verifier and external R2/provider mocks. Existing retirement/preservation/provider-identity suites also pass (130 focused cases total).
- Whole-repository checks caught implicit source-array inference; fixed with an explicit WorkspaceDeletionIdentity intersection. Final validation is recorded in PR evidence.

## Limits and retained follow-up

Production inspection at18:28UTC found the original VM still hosting active work and a stopped bootstrap-failure workspace without a saved snapshot. Retirement correctly remains blocked for those sources; this change does not authorize discarding their data. Bootstrap failure was runtime-assets request timeout and no agent-session row exists, but that alone is not physical-deletion proof.
The independent silent Codex continuation remains unproven and is captured privately in SAM Idea01M61W98T9FE647YFR4NAHSV1B. Do not describe it as fixed by this cleanup change.

## Post-mortem

What broke: #2463 required physical workspace deletion proof before both wake and automatic node retirement, which old VM agents cannot produce. Failed cleanup timestamps also postponed idle retirement indefinitely.
Process fix: real-SQL vertical-slice regression covers old-agent cleanup state, actual R2 verification, provider-proof ordering and saturated/partially-spent sweep budgets. Existing control-loop and vertical-slice rules already cover these requirements; no additional standing guidance added.

Implementation archived after completion-validator PASS. Release remains in progress; the PR and local workflow state track CI, CodeRabbit, merge and deployment outcomes.
