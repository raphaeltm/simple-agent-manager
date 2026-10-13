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
- [x] Relevant lint/typecheck/test/build; regression discrimination.
- [x] Local specialist reviews; coordinated staging verification.
- [x] Create tested draft PR and finish CI; update canonical Idea.
- [ ] Finish in-progress best-effort CodeRabbit review (status recorded in PR).

## Scope exclusions

Global-profile editing is unrelated and remains in canonical Idea. Retry stored hidden-context duplication is a separate follow-up in that Idea; this fix removes rejection and formats hidden context safely, without changing task storage or retry behavior.

## References

.claude/rules/62-tests-must-observe-the-real-trigger.md; .claude/rules/13-staging-verification.md; apps/web/.claude/rules/17-ui-visual-testing.md.

## Verification and review evidence

- Real SQLite enrichment: 26/26 pass. Disabling optional NOT_FOUND guard produces 3 failures; restored.
- Authenticated task-submit/prompt: 37/37 pass; real guards/resolver/enrichment/SQL, fixture auth-provider/runtime boundaries. Disabling the guard produces 8 HTTP failures; restored.
- Direct shared syntax tests instrument source: full shared suite 808/42 pass; helper lines/functions 100%, branches 83.33%; package coverage thresholds pass.
- Full lint/typecheck/build pass (13/19/9 tasks). Final ACP/web builds include wrapping. Formatting/file-size/source-contract/runtime-state checks pass.
- Full suite executed: web 4049 pass; API 12307 pass/2 skip with one unrelated 5s archive-sharding timeout. Unchanged isolated file rerun passes 42/42. Initial concurrent cloud-init timeouts clear in bounded rerun (181 pass). No timeout/assertion/coverage changes; unified API run is not claimed clean.
- All local Cloudflare/constitution/doc-sync/test/task-completion reviews pass or recommendations addressed. UI audit 4/4 passes at 375×667/1280×800; long-name clipping fixed with wrapping, measured name/control bounds pass. Four refreshed mock screenshots reviewed; rubric 4/4/4/4/5. Evidence-only branch commit aefb67f6fefbb9a5309228356e0f55698a1ae07b.
- Coordinated staging deploy 38425474319 green on c0fd65a4c, Worker 4c36f126-e1f6-4901-8a2d-df2e25b381f7. Actual Instant composer /sessions/start202 and follow-up /prompt202 with real gpt-6.1-sol ACK replies to both; five complete profile names enrich, unknown/email/npm text sends, mobile dotted-name picker works. Invalid explicit tasks/submit and profile resolve remain404.
- Successful live fixture 01M4V1C7Y2J7430WW7NS47S5K7: stop200/projectDELETE200; CF confirms nodes0 and original sleeping2/stopping1 workspace baseline restored. Earlier harness waited for wrong endpoint; exact first fixture was independently identified by repository/owner and cleaned before bounded retry. No application failure claimed from that harness error.
- Final changes after staged c0 are test/evidence records only; production code identical. No production deployment/merge/ready action authorized.
- Task stays on output branch (no main task push/production trigger); existing SAM workspace provides branch isolation without redundant worktree.

## Remaining handoff

DRAFT PR: https://github.com/raphaeltm/simple-agent-manager/pull/2331 . CI run38431249226 passes all applicable checks, including Test, Durable Object Workers, Playwright, SonarCloud and corrected Preflight Evidence. Canonical Idea updated in place with PR, evidence and precise retry follow-up. Final task-completion review A–F PASS; no substantive code/test gaps.

CodeRabbit requested once via opt-in label and trusted main workflow38441420126 at17:46UTC; request workflow succeeded and review started. Final review outcome belongs in the PR CodeRabbit evidence and canonical Idea before SAM task completion. Keep this task record active pending user confirmation; deliverable is a tested draft, not a merged or production-shipped fix. Keep the PR draft and unmerged.
