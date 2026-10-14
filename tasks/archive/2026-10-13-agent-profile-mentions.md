# Fix agent-profile mentions rejecting chat messages (#2329)

Historical draft-only limits are superseded by the 2026-10-14 user authorization to finish and ship PR #2331. Production merge/deploy remains held until release coordination clearance.
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
- [x] Finish best-effort CodeRabbit review: both findings reviewed and threads resolved; terminal-period fix tested, quoted autocomplete explicitly deferred.

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
- Post-stage review delta: accept one sentence-final period while preserving full dotted names and rejecting repeated-dot/quoted-suffix prefixes. This narrow parser delta has direct-source, real SQLite and authenticated HTTP regression coverage; it has not been redeployed live. Core rejection-fix staging evidence remains as recorded. No production deployment/merge/ready action authorized.
- Task stays on output branch (no main task push/production trigger); existing SAM workspace provides branch isolation without redundant worktree.

## Remaining handoff

DRAFT PR: https://github.com/raphaeltm/simple-agent-manager/pull/2331 . CI run38431249226 passes all applicable checks, including Test, Durable Object Workers, Playwright, SonarCloud and corrected Preflight Evidence. Canonical Idea updated in place with PR, evidence and precise retry follow-up. Final task-completion review A–F PASS; no substantive code/test gaps.

CodeRabbit requested once via opt-in label and trusted main workflow38441420126 at17:46UTC; request workflow succeeded and review started. Final review outcome belongs in the PR CodeRabbit evidence and canonical Idea before SAM task completion. Keep this task record active pending user confirmation; deliverable is a tested draft, not a merged or production-shipped fix. Keep the PR draft and unmerged.

CodeRabbit review5507783751 arrived with two minor findings. Terminal-period regression addressed with safe single-period handling and direct/SQLite/HTTP tests; quoted autocomplete reviewed as optional UX expansion (existing @Code picker inserts escaped multiword names) and deferred with rationale. No global-profile editing changes. Incremental review and exact-head CI remain pending; PR evidence will record final outcome.

## Draft gate follow-up — 2026-10-14

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2331 . The historical handoff above is superseded by this follow-up for the remaining gates.

- CI 38446137601 on f8bc33db5d626b9645a87a1642a8376b0d1cf1a7 passed all 13 ESLint tasks and type-boundary checks, then failed `quality:runtime-state-files` because `.do-state.md` had been committed. Remove it from git tracking while retaining workspace-local workflow state. No application code or gate configuration changes.
- Rechecked CodeRabbit review 5507783751 against current source: single terminal periods work for dotted and quoted names, covered by `packages/shared/tests/mentions.test.ts`; repeated dots and quoted suffixes remain rejected. Both threads are resolved. Quoted autocomplete remains an explicit optional UX deferral: `@Code` palette selection inserts the complete escaped name, and complete manually quoted tokens parse. The static command-injection annotation is inapplicable: `getMentionQuery` runs a regex and no child process.
- GitHub's historical `CHANGES_REQUESTED` aggregate persists despite resolved threads; do not describe it as approval or dismiss the review merely to clear a status. Request a fresh trusted review once after pushing and record the observed outcome in the PR.
- Relevant local checks and exact-head CI outcomes will be recorded in the PR follow-up evidence before completion. Prior staging and screenshot evidence remains pinned to its original commits. This follow-up changes tracked runtime metadata and task documentation only.
- Keep this record active as previously requested. PR remains DRAFT ONLY / DO NOT MERGE / DO NOT MARK READY / NO PRODUCTION DEPLOY.

## Shipping continuation — 2026-10-14

Latest user authorization supersedes original draft-only limits. Preserve PR #2331 and its original branch. Ordinary validation runs with low concurrency; no infrastructure intervention. Shared staging priority is granted after verifying no active test. Production merge/deploy awaits explicit release sequencing clearance.

- Low-concurrency full build 9/9 and lint/typecheck 32/32 pass at executable head 71cbac1c7.
- Real SQLite enrichment/authenticated HTTP 68/68 and desktop/mobile composer audit 4/4 pass.
- Fresh task-completion A–F, parser, test, constitution, UI and documentation review PASS. Root and UI reviewer inspected all four captures; rubric 4/4/4/4/5. Fresh evidence: https://github.com/raphaeltm/simple-agent-manager/pull/2331#issuecomment-6163718829 .
- Exact-head staging deployment and pipeline smoke PASS: https://github.com/raphaeltm/simple-agent-manager/actions/runs/38531588078 . Final parser live send-path smoke PASS: real Instant start and browser follow-up both 202 with actual Sol replies; all six full profile IDs enrich initially, and both sentence-final period profile IDs reach follow-up. Explicit invalid selector stays 404. Fixture stop/delete 200; Cloudflare confirms zero active nodes. Earlier harness streaming-fragment mismatch was corrected and its first fixture cleaned before a bounded retry.
- Historical CodeRabbit changes-requested aggregate is not approval. Both original threads are resolved; period handling implemented and quoted autocomplete optional expansion deferred with rationale. Fresh trusted review will be requested at final readiness.

- Final live screenshot/report evidence commit: 3e29b3f53 on existing evidence branch. Root inspected both live desktop/mobile captures; they show the real follow-up stream and dotted-name picker without horizontal overflow. Fresh mock desktop/mobile audits provide completed layout stress evidence.
- Task-completion validator implementation A–F PASS, runtime evidence now closes final parser staging gap. No application code changed during shipping continuation. Merge/deploy remains queued behind release clearance and final normal review/CI gates.

## Sonar runtime finding follow-up

Final review identified real quadratic suffix-regex backtracking on malformed punctuation tokens; authenticated follow-ups have no message-length guard. Replace suffix removal with a linear backward scan, preserving one terminal period and complete-token semantics. No scanner suppressions or gate changes.

Direct parser31 and real SQLite/HTTP68 tests pass. Independent parser/test/task/constitution review PASS. Fresh adversarial security review PASS across111111 exhaustive suffix comparisons and bounded30k–120k malformed/quoted/escaped inputs. A120k malformed token now completes in fractions of a millisecond; terminal stripping remains linear. Cognitive-complexity and sequential-await code smells are maintainability advisories, separately assessed; the actual CPU-risk finding is fixed.

The final security delta requires fresh normal CI and coordinated live staging evidence in PR #2331 before merge. Production sequencing clearance remains required. Previous live evidence is preserved at its exact executable commit, not presented as covering this later change.
