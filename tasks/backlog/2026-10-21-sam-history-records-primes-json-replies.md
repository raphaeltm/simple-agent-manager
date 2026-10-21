# SAM history records shown as assistant JSON prime the model to reply in JSON

## Problem

`projectOperatorContext` (`apps/api/src/durable-objects/sam-session/operator/context.ts`) shows
every past turn to the model as the user's message followed by an **assistant** message whose
content is a JSON status record (`kind: sam_historical_turn_status`, `authority`,
`recordedAt`, `assistantMessages`, …). Every prior assistant turn the model sees is therefore
JSON. Models imitate that, and GLM 5.3 Flash sometimes starts its answer by writing a record.

## Context

Found during staging verification of the /sam live-streaming PR, 2026-10-21. The smoke user's
conversation had ~95 turns. GLM copied a record in 2 of 5 runs: once 463 characters streamed
before the guard reset them, and once ~15 s of output was withheld. Gemma did not copy in its
one run. The PR made the publication guard reject replies that carry a record key: such a reply
is never streamed or stored, the correction runs, and a stored copy is left out of later
context. It also added an end-of-prompt line telling the model to reply in plain prose.

The copy is still generated before it is rejected. Each one costs the user ~15 s and roughly
doubles the turn's tokens (run 5: 51K in / 1.4K out, $0.0064, against 33K / 0.5K, $0.0033).

## Acceptance Criteria

- [ ] Measure the copy rate on staging before and after the change. Use a bounded number of
      runs; check the staging token cap with Raphaël first.
- [ ] Past turns are projected so prior assistant turns read as prose. For example: the stored
      answer as the assistant message (it already passes the guard, which now rejects
      record-key impersonation), with status metadata carried separately. The historical-only
      authority stays explicit to the model.
- [ ] The receipt-grounding guarantees in `sam-operator-context.test.ts` still hold. That
      includes forged status, untrusted prose and omitted-history cases.
- [ ] A native workerd test with the real Mastra agent shows the projected history shape the
      model receives.
