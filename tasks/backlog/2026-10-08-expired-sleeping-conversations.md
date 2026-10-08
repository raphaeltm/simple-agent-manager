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
- [ ] Add additive expiry reason representation and API propagation.
- [ ] Terminalize expired sleeping tasks through purge, including metadata-only degraded expiry, without broadening R2 deletion.
- [ ] Prevent legacy expiry failures through real sweep path; retain wake fences.
- [ ] Bounded dry-run-first legacy backfill, including verified false failures since Oct 1; unexpired control.
- [ ] Expired chat list/header and clear Fork path; readable transcript.
- [ ] Real purge/sweep regression tests and race/nonexpired controls.
- [ ] Desktop/mobile Playwright screenshots inspected and attached to PR.
- [ ] Lint/typecheck/test/build and local specialist reviews.
- [ ] Exclusive staging lease, deploy and verify, release.
- [ ] PR/CI/CodeRabbit/merge/production deploy and real-row verification.
- [ ] Append evidence to ideas, complete only after verified deployment; channel MERGED/DONE and unsubscribe.

## Acceptance criteria
Expired saved workspaces end as Expired without failure messaging or silent fresh wake. Transcript and Fork remain available. Unexpired and unrelated failures are unchanged. Legacy degraded rows converge without R2 deletion. Backfill is bounded and WHERE guarded with recorded counts.

## References
Ideas 01M43NCRFC9VF93RPM355FZAKJ and 01M372H3BSH4PFC67MH6J63WS8; tasks/backlog/2026-09-26-trustworthy-task-status.md; rules 31, 62, 79; reliability-wave-1008.
