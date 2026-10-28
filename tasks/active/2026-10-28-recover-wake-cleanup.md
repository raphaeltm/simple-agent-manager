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
- [ ] Allow incompatible managed VM retirement only after all remaining sources are safely preserved.
- [ ] Fence claim against active/new siblings, placement, owner/incarnation/generation changes.
- [ ] Reverify R2 artifacts immediately before provider deletion; retain wake fence until termination proof.
- [ ] Regression tests exercise real SQL and snapshot verification, including failures and races.
- [ ] Local specialist/completion review and appropriate validation.
- [x] Staging explicitly waived by user.
- [ ] Green PR, best-effort CodeRabbit request/wait, merge, production deploy and basic smoke.

## Acceptance
Older-agent cleanup can converge via safe drained-node retirement without trusting legacy DELETE success. Active work and unpreserved data remain protected. Provider failure does not release wake. Report the separate stalled reschedule honestly and fix any proven in-scope cause.
