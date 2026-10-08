# Expired sleeping conversations

## Problem
Snapshot retention ends after seven days but tasks stay sleeping or legacy in_progress forever, or fail as workspace_deleted. Approved outcome: Expired, readable transcript, continue via Fork. Deadline 2026-10-12 00:42Z.

## Research
- session-snapshot-purge.ts stops the DO session then deletes snapshots; task lifecycle is untouched. Legacy degraded snapshots without fallback are intentionally excluded from artifact purge.
- Production read 2026-10-08: 69 legacy in_progress asleep rows (13 available, 56 degraded); 30 modern sleeping rows. Four failed conversations since Oct 1 have deleted snapshots and timing consistent with expiry; another workspace_deleted failure has an unexpired snapshot and must remain unchanged.
- task-sleep-preservation.ts conversation fallback preserves degraded expired rows indefinitely. Sweep selects active statuses only.
- Existing task cancelled and session stopped provide neutral terminal semantics. Add nullable terminal_reason=snapshot_expired; never use error_message for normal expiry. Session list already enriches task data; detail embeds task metadata.
- Shared terminal transition owns CAS/event/outbox/parent wake; expiry must preserve these and exclude racing wakes.

## Checklist
- [x] Add additive expiry reason representation and API propagation.
- [x] Terminalize expired sleeping tasks through purge, including metadata-only degraded expiry, without broadening R2 deletion.
- [x] Prevent legacy expiry failures through real sweep path; retain wake fences.
- [x] Bounded dry-run-first legacy backfill, including verified false failures since Oct 1; unexpired control.
- [x] Expired chat list/header and clear Fork path; readable transcript.
- [x] Real purge/sweep regression tests and race/nonexpired controls.
- [ ] Desktop/mobile Playwright screenshots inspected and attached to PR.
- [x] Lint/typecheck/test/build and local specialist reviews.
- [ ] Exclusive staging lease, deploy and verify, release.
- [ ] PR/CI/CodeRabbit/merge/production deploy and real-row verification.
- [ ] Append evidence to ideas, complete only after verified deployment; channel MERGED/DONE and unsubscribe.

## Acceptance criteria
Expired saved workspaces end as Expired without failure messaging or silent fresh wake. Transcript and Fork remain available. Unexpired and unrelated failures are unchanged. Legacy degraded rows converge without R2 deletion. Backfill is bounded and WHERE guarded with recorded counts.

## References
Ideas 01M43NCRFC9VF93RPM355FZAKJ and 01M372H3BSH4PFC67MH6J63WS8; tasks/backlog/2026-09-26-trustworthy-task-status.md; rules 31, 62, 79; reliability-wave-1008.

## Validation evidence (local)
- Real purge/sweep/terminal suites: initial62 passed; expanded race suite35 passed, migration2 and fallback31 passed. Amended guard assertions and full package reruns pending.
- Build9packages and typecheck19packages passed; migration safety0violations.
- Playwright mobile375x667 and desktop1280x800 passed; header/list screenshots reviewed by local UI specialist, neutral label/readable transcript/Fork flow verified.
- Specialist reviews: Cloudflare/constitution PASS; task completion/test engineer ADDRESSED (stronger terminal reason/race/event assertions); UI/docs ADDRESSED (reason-only equality and mobile list capture).
- Amended API regression pass:165 tests (real purge/sweep, migration, terminal reconciliation fixtures); web focused78 passed. Isolated Vite mutation probes each fail their intended assertion when expiry reason or wake-claim fence is removed; working source untouched.
- Production false-failure refresh14:19Z still four confirmed rows plus the excluded unexpired control. Recheck before production deployment.
- Reviewed screenshots are retained in project library `/engineering/expiry-2026-10-08/`: mobile header `01M4DXTJRN09HE3QT9Q2GPGWAX`, mobile list `01M4DXTN1QF5BEAECW0BSBNNDW`, desktop header `01M4DXTQQKRE9DX2JQJN451284`, desktop list `01M4DXTT8CSSKMA0MZD6B1XPMT`.

Implementation validated and archived by the explicit `/do` workflow. Delivery gates above remain pending and are tracked in the PR and SAM task; ideas will not be completed before verified production deployment.

Final local package runs:826API files/11615tests passed with six old fixture failures; corrected fixtures passed fresh in165-test affected suite. Web335files/4024tests passed with one newly-added cache test running against a pre-edit cached module; fresh78-test run passed. CI will rerun the final committed tree.

Load review: new degraded pass and existing artifact purge each use the configured batch cap (default250), aggregate500maximum candidates. Expected initial49production/11staging degraded expiries; indexed lookup plus existing D1/DO terminal machinery per row; no new VM/R2 operations.

Final frozen-tree root validation14:35Z: `pnpm exec turbo run test --concurrency=1` PASS21/21tasks, web4025tests/336files andAPI11621tests/828files. This supersedes earlier in-flight fixture/cache failures.

## Staging and older-conversation list correction
- First staging deployment37794259672 applied0187. Real cron at15:02Z expired11legacy tasks, exactlyone expiry event each; sixunexpired controls unchanged; all1524transcript messages retained. Degraded snapshot metadata retained with expired status.
- Found and fixed a completeness gap before PR: sidebar's200recent-task page could omit older expired tasks. Session-list API now includes authoritative task outcomes for returned sessions, scoped byproject and uniquechat ID; D1parameter chunking permits at mosttwoqueries for100sessions. Invalid/nonpositive page limits now normalize before both readers, avoiding SQLite's unlimited negative limit.
- Real-route tests13PASS across index/DO fallback, project isolation, negative/invalid limits. Revised Playwright2PASS with emptyrecent-task page; fourupdated screenshots reviewed PASS and replaced in retained libraryfiles. All three localdelta reviewers PASS/ADDRESSED. Final staging redeploy pending.
