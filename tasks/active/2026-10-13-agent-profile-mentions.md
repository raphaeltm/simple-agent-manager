# Fix agent-profile mentions rejecting chat messages (#2329)

DRAFT ONLY / DO NOT MERGE / DO NOT MARK READY / NO PRODUCTION DEPLOY.
Canonical SAM Idea: https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4SN1TA0YTFK8QWQEFWR4K83

## Problem and research

Mention enrichment calls the strict profile resolver and propagates unknown-name NOT_FOUND errors. The composer and parser disagree on punctuation and Unicode. All five enrichment callers (task submit, send-chat, Instant submit, chat start, prompt forwarding) share this defect. Email/npm tokens can accidentally resolve partial names. Explicit profile selection and existing access checks must remain strict.

## Checklist and acceptance

- [x] Share formatter/parser/palette syntax; support punctuation, Unicode, spaces, escaped quotes/backslashes without partial matching.
- [x] Skip only AppError NOT_FOUND/404 in optional mention enrichment; propagate other failures.
- [x] Real SQLite enrichment tests: known/unknown names, ordinary text, email/npm scopes, scoping, explicit invalid selections, database failures.
- [x] Authenticated task-submit and prompt route tests through real enrichment/database helpers; inspect Instant/chat-start callers.
- [x] Composer behavioral and desktop/mobile browser evidence.
- [ ] Relevant lint/typecheck/test/build; regression discrimination.
- [ ] Local specialist reviews; coordinated staging verification.
- [ ] Create tested draft PR; CI and best-effort CodeRabbit; update canonical Idea.

## Scope exclusions

Global-profile editing is unrelated and remains in canonical Idea. Retry stored hidden-context duplication is a separate follow-up in that Idea; this fix removes rejection and formats hidden context safely, without changing task storage or retry behavior.

## References

.claude/rules/62-tests-must-observe-the-real-trigger.md; .claude/rules/13-staging-verification.md; apps/web/.claude/rules/17-ui-visual-testing.md.

## Verification and review evidence

- Real SQLite enrichment: 26/26 pass. Disabling optional NOT_FOUND guard: 3 fail, 23 pass; restored.
- Real authenticated task-submit/prompt handlers: 37/37 pass. BetterAuth getSession and runtime/DO boundaries are fixtures; real auth/access guards, resolver/enrichment/SQL run. Disabling optional guard: 8 fail, 29 pass; restored.
- Cloudflare and constitution local specialist reviews PASS; all five shared callers inspected. Doc sync recommendation addressed with short agents-guide note.
- Task-completion audit A–E finds no code/test gaps; runtime/browser/CI/publication gates still pending.
- Staging prior owner explicitly relinquished; active blog owner confirms no staging use.
- Initial unrestricted concurrent full test run timed out 3 unrelated cloud-init cases; bounded-concurrency rerun underway.

- Final UI audit: 4/4 Playwright cases pass (new/follow-up × 375×667/1280×800). Long-name clipping found and fixed by wrapping. Measured text widths and Send/textarea bounds pass. All four refreshed screenshots reviewed by UI reviewer and root. Rubric 4/4/4/4/5.
- Full lint/typecheck/build pass; final ACP and web builds include wrapping. File-size, source-contract and runtime-state checks pass.
- Local full test suite remains running without reported failures; staged deployment will overlap this independent validation. No claim of completed full test validation until it exits.
- Task record stays on output branch (no main task-only push) to honor no production deployment. Existing SAM workspace already isolates output branch, so no redundant worktree needed.
