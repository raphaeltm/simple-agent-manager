# Incident triage IDs and bounded recovery

## Problem
Generated triage prompts abbreviate incident IDs, but incident tools require exact signatures. Unfinished claimed sessions requeue without using a retry budget, while a sleeping unclaimed dispatch can pin the queue indefinitely.

## Authorization and scope
Raphaël: “Fix it. Ship the fix. Skip staging.” (2026-10-28). Staging waived for this fix only; review, CI, production deployment and smoke remain required. No snapshot or runtime-assets changes. No destructive handling of user work.

## Research / preflight
- Business logic, cross-component contract, docs sync.
- `platform-feedback-incidents/queries.ts`: summary truncates IDs to16; rows/claims require exact IDs.
- `claims.ts`: expiry clears ownership and requeues without consuming attempts.
- `dispatch.ts`: nonterminal task protects dispatch even after sleeping without a claim.
- Existing configurable agent/dispatch lease TTLs, reclaim limit and max attempts should bound recovery; use existing states, avoid schema changes.
- Preserve active owners. Reclaim only expired unfinished work; don't terminate tasks or mutate conversation state.
- Lessons: scoped rules47 (bounded control-loop I/O),58 (sleep is not death), and25 (review gates). Retry of incident ownership must not imply destruction of runtime or user work.
- Data flow: backlog summary -> incident MCP exact lookup/claim -> claim/dispatch lease -> scheduled reclamation -> selection/reservation.

## Checklist
- [x] Full IDs in generated prompts and usable evidence references; behavioral round trip regression.
- [x] Bound unfinished claims and sleeping unclaimed dispatches with existing attempt budget, preserve active owners and fencing.
- [x] Regression tests with real SQLite for expired claims, dispatches, concurrent/stale ownership, retry exhaustion and live-owner preservation.
- [x] Update affected documentation and postmortem; validate lint/typecheck/tests/build.
- [x] Local specialist reviews and task-completion validation.
- [ ] PR, CI, best-effort CodeRabbit, merge, deploy, production smoke.

## Acceptance
An ID copied from a prompt resolves and claims its incident. Sleeping unfinished owners neither pin incidents forever nor allow unlimited replacement tasks. Active investigation is preserved. Retries stop at configured budget with an explicit reason, and terminal incidents remain terminal. No new unbounded sweep.

## Postmortem
What broke: automated triage repeated or stalled without classification.
Root cause: display-only signature abbreviation used as a tool identifier; claim and dispatch expiry used inconsistent retry/liveness rules.
Why missed: tests did not consume prompt IDs through real lookup/claim or exercise repeated unfinished handoffs.
Process fix: cross-boundary round-trip and multi-cycle lease regression tests in this PR, following existing rules23/47/58/62.

## Validation evidence
Six regression cases failed on original implementation (23 existing passed). After implementation, 76 tests across incident handling, triage and scheduled trigger pass. Active claim renewal preserves CAS tokens and original max-age bound. Claim reclamation is bounded by existing reclaimLimit and runs once per scheduled pass (not once per trigger); each candidate uses at most one update after one bounded SELECT. Dispatch candidates remain bounded by existing reclaimLimit; new sleeping-owner checks are indexed task lookups, no remote I/O.

Final local validation: root lint (13 tasks), typecheck (19 tasks), tests (21 tasks; API 13,996 passed), and build (9 tasks) passed. Focused regression suites: 86 tests passed. All three local specialist reviews completed; findings addressed. Staging explicitly waived. PR/CI/review/deployment remain release gates.
