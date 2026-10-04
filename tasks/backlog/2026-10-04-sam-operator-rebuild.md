# Rebuild the opt-in SAM operator

## Problem
The user authorized implementing recommendations from session 5ce09401-1d6a-443e-806e-498f4381373b and shipping to production. Existing /sam uses mock overview data and stream-bound inference, lacks durable turn/action ownership, and exposes repository tools directly.

## Source recommendations
- One primary per-user conversation, explicit requests and requested watches; no autonomous standing-goal advancement.
- Account opt-in OFF by default, server enforced; disabling fences new actions and preserves history and running project work.
- All code/file questions dispatch visible project sessions. Follow-ups preserve original constraints; human intervention wins.
- Persist accepted turns and action receipts; retries/restarts cannot duplicate effects. Streaming reflects persisted state.
- Reuse project event infrastructure for a scoped user inbox, deduplicated and replayable. Events quietly update work cards without competing conversation writers.
- Evidence-linked results distinguish turn completion, task completion and verified deployment.
- Keep reasoning replaceable; evaluate framework adoption rather than assuming a rewrite improves quality.

## Research
- apps/api/src/routes/sam.ts proxies user identity to per-user SamSession.
- apps/api/src/durable-objects/sam-session/index.ts stores messages but starts inference in stream-bound waitUntil.
- tools/dispatch-task.ts provisions visible tasks but lacks durable operator action idempotency.
- tools/index.ts exposes direct search_code/get_file_content, contrary to routing requirement.
- apps/web/src/pages/SamPrototype.tsx uses MOCK_PROJECTS.
- Roadmap idea 01KQ720TE8Y8ZGVTZPBM8Y4NH0 contains superseded proposals; latest session recommendations govern.

## Implementation and acceptance
- [ ] Persist opt-in and enforce new-action gates, preserving history on opt-out.
- [ ] Durable primary conversation, accepted turns, single writer, cancellation and recoverable failure states.
- [ ] Durable action receipts and duplicate-safe dispatch with original authority.
- [ ] Restrict top-level capabilities to authorized platform operations and project dispatch.
- [ ] Scoped event inbox/watch delivery, replay/deduplication and noninterrupting presentation.
- [ ] Live responsive chat, work/attention cards, project-session links and account settings.
- [ ] Tests for retry, restart, disable, revocation, direct human intervention, duplicate events and false completion claims.
- [ ] Document supported initial workflows and framework evaluation decision.
- [ ] Local validation, independent specialist review, desktop/mobile screenshots.
- [ ] Coordinated staging validation, PR/CI/CodeRabbit, production deployment verification.
