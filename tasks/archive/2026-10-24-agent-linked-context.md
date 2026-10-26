# Agent linked context

## Problem

Agents reading ideas or chats do not receive related work in one bounded, data-framed response.

## Research

`getIdea` in idea-core serves both MCP adapters. `getIdeaContext` and `getSessionContext` in link-core enforce strong-link inheritance and return ranked capped lists. Idea updates live in ProjectData. T7 provides the shared untrusted-text envelope.

## Checklist

- [x] Add bounded agent context projection with typed settings and untrusted envelopes.
- [x] Include related context and latest updates in get_idea.
- [x] Add get_linked_context for idea, session or file, defaulting to current chat.
- [x] Register workspace and connector adapters and tool guidance.
- [x] Remove the unused legacy session–idea methods after the link store became the only live reader and writer; retain the table and migration.
- [x] Test real handlers, connector parity, scoping, output bound and prompt injection framing.
- [x] Run validation, specialist reviews, staging and PR gates. (reconciled 2026-10-26: PR #2435 body records lint, typecheck and build passing and six specialist reviews PASS/ADDRESSED; Deploy Staging run 40087525261 succeeded on f2abf03a5 and the real Instant-agent spec passed 1/1; final head dadf41177 green in CI run 40090154159; coordinator APPROVED at `feature.linked-work` seq 214; CodeRabbit requested and rate limited; merged 2026-10-24 11:48Z as 45c7490fd; Deploy Production run 40092539612 succeeded)

## Acceptance

One call returns linked work, ranked/capped with disclosed totals, with project isolation and data framing for every agent audience.

## Reconciliation 2026-10-26

- Shipped by #2435 (`45c7490fd`, merged 2026-10-24); first successful production deploy:
  run 40092539612 (head `45c7490fd`, 2026-10-24).
- Unticked: 0 — none.
- Verdict: ARCHIVE. Merged, deployed and verified with a real staging agent; SAM task
  01M5P60VRN1ZSAZ2QY9AA5JE85 and spec idea 01M5NG8EJDWSX5QDY6B0HK99GZ are completed.
