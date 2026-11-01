# Focused notification question dialog

Raphaël approved prototype Direction A and authorized PR, merge and production. Explicitly skip staging for this task; perform local desktop/mobile validation and production smoke.

## Research

- Bell rows truncate body to 2 lines and navigate using actionUrl; notification body itself is truncated server-side.
- Human-input attention marker retains full reason, answer options, resolution and timestamp. Requests are not necessarily transcript messages; use this canonical record, never assume the newest chat page contains the question.
- Existing session access checks and Cloudflare attention answer endpoint remain authoritative. Fixed-option requests reject custom strings; only offer free text where supported.
- Existing transcript paging can retrieve a bounded preceding window by marker timestamp, including archived transcript routing. Preserve exact paging semantics.
- Dialog requires pinned response area and independently scrollable body on mobile. Reuse shared modal interaction behavior for focus/background isolation.

## Checklist

- [x] Read-only, project/session-authorized question context endpoint, full persisted reason/options/status and bounded preceding messages.
- [x] Focused responsive dialog integrated into bell and project notifications; preserve normal non-question navigation and quick answers.
- [x] Share answer controls; pending/error/already-resolved states honest; refresh state after resolution; free text only where accepted.
- [x] Earlier context toggle, useful missing request fallback, explicit conversation link with context anchor when available.
- [x] Behavioral tests cover full old request, options/custom replies, stale/concurrent state, send failure, dismissal/navigation and authorization boundaries.
- [x] Playwright audits actual components with mocked APIs, mobile + desktop, long content, empty/error/context; visually review and upload screenshots.
- [x] Remove prototype route/files before PR; docs and contract updated.
- [ ] Typecheck/lint/targeted tests/build; independent specialist review; CI/CodeRabbit; merge/deploy/production smoke.

## Acceptance

Full question readable even outside current chat page; responses stay visible while reading; quick answers still work; context is bounded and older than request; resolved/unavailable requests cannot be answered; no change to authoritative answer delivery; responsive and keyboard accessible; no prototype enters production.

## References

.claude/commands/do.md; apps/web/.claude/rules/17-ui-visual-testing.md; chat-attention.ts; project-data/attention.ts; approved screenshots in library /design/notification-context-2026-11-01/.

## Validation and review

- 43 targeted web tests and 42 API/attention unit tests passed; 12 Workers tests passed including real service → DO RPC → SQLite for a full old question, cross-session lookup and resolved history.
- Playwright: 10 tests passed at 375×667 and 1280×800, exercising bell/project reader, long content, context, typed answers, failures, direct quick answers and normal update navigation. Geometry asserts header/footer stay in viewport and answers stay stationary when body scrolls. Screenshots visually reviewed; no remaining layout issues. Physical mobile software keyboard was not tested.
- API/web typechecks and builds passed; scoped ESLint passed. Prototype code removed.
- Independent backend/security/constitution review ADDRESSED caller write authority and configurable context limit; final PASS. Independent task/test/doc review PASS. Independent UI review PASS; rubric 4/5 in all five categories.
- Staging skipped by explicit Raphaël authorization. Task-only direct main push was rejected by GH013 required check; task is included in this normal feature PR instead, without bypass.
- Reviewers verified no effect-handler conflict. Optional-context query is independent so a context failure does not remove the question or answer area.
