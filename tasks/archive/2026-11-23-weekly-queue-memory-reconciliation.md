# Weekly queue and memory reconciliation (2026-11-23)

SAM task `cron-4ca9946ee9ff8a56beec991380c9fd4a79906298e9e4da2872ea9135e1a77846`, output branch
`sam/weekly-queue-memory-reconciliation-a77846`.

## Problem

The repo task queue drifts from reality. Implementing PRs move their task file into
`tasks/active/` and merge without archiving it, so `active/` fills with shipped work, and
`backlog/` keeps entries whose work shipped or was superseded. This makes the queue a poor
guide to what is genuinely open.

## Research findings

- `tasks/active/` held 25 files (the brief estimated ~75). Every one was moved there by its own
  implementing PR, and 24 of those PRs merged between 2026-11-14 and 2026-11-22. Production deploys
  from `main` have succeeded continuously (latest `7d40cfb2d`, 2026-11-23 02:04Z).
- The exception, `2026-11-14-merge-streamed-chunks.md`: [#2760](https://github.com/raphaeltm/simple-agent-manager/pull/2760)
  shipped chunk merging switched off (`DEFAULT_MESSAGE_MERGE_CONFIG.enabled = false`). The activation,
  observation and default-ON PR are still open, and the owning SAM task was cancelled on 2026-11-23.
- `tasks/backlog/` held 348 files (the brief estimated ~260). They were audited in four read-only
  slices, and each non-KEEP verdict needed a merged PR, commit or code check as evidence.
- Open PRs older than 7 days: [#2265](https://github.com/raphaeltm/simple-agent-manager/pull/2265)
  (Sonar coverage, a credential hold) and [#1788](https://github.com/raphaeltm/simple-agent-manager/pull/1788)
  (OSV scan, an explicit human draft hold). The PR Shepherd (task `cron-7518eb...`) confirmed both holds
  are unchanged: `SONAR_CI_ENABLED=false`, and the Sonar and OSV routing secrets are absent. This
  run agreed to post the one weekly comment on each.
- Deviation from /do: the task file ships in this PR rather than as a direct push to `main`.
  The brief asks for ONE cleanup PR, and a direct push would trigger an extra production deploy.

## Checklist

- [x] Repoint the four code/config pointers that named the moved `tasks/active/` paths (comments, plus the `baselineBacklogLink` string in `packages/eslint-plugin-sam/rules.manifest.json`). No logic changes

- [x] Audit every `tasks/active/` file against merged PRs and deploys
- [x] Archive the 24 shipped files: tick evidenced gate lines and append a dated reconciliation note
- [x] Move `2026-11-14-merge-streamed-chunks.md` back to backlog with its open remainder
- [x] Audit all 348 backlog files (4 read-only slices); spot-check evidence for every non-KEEP verdict
- [x] Delete shipped, obsolete, superseded and duplicate backlog files; annotate PARTIAL ones
- [x] Comment a weekly status/park note on #2265 and #1788
- [x] PR description lists a one-line rationale for each deletion
- [x] Part 2: SAM knowledge/idea/policy hygiene (outside the repo)
- [x] Digest via `update_task_status` (plus one inbox result and one inbox decision on the two parked PRs)

## Acceptance criteria

- [x] `tasks/active/` contains only this file until merge (then nothing)
- [x] Every deleted backlog file has a verdict and evidence in the PR description
- [x] No backlog file deleted without a cited merged PR, commit or code check
- [x] Each PR older than 7 days has one comment from this run
- [x] Outside `tasks/`, the change touches only comments and one non-functional manifest string (`baselineBacklogLink`, read by nothing else): no staging deploy (docs-only exemption)

## Backlog audit results

- 348 files. KEEP 276, PARTIAL 64, SHIPPED 7, SUPERSEDED 1, OBSOLETE 0, DUPLICATE 0.
- The task-completion validator challenged the SUPERSEDED verdict on `2026-02-23-suppress-background-subagents-in-acp.md`: #1845 leases background work, but nothing shows the interleaved-output symptom is fixed. The file was restored and kept, with a note. Final: 7 deleted.
- I checked the merged PR and the code path for all 8 deletions myself (listed in the PR description).
- 61 of the 64 PARTIAL files already carry earlier reconciliation notes. A dated note was added only
  to the 7 whose evidence cites a PR the file did not mention yet.
- Noted, not fixed (pre-existing drift): about 11 code and config comments still name older
  `tasks/active/` paths from earlier PRs, among them applied D1 migration headers, which must not be
  edited. Only the four pointers this PR's moves broke were repointed.

## Outcome

- Cleanup shipped in [#2983](https://github.com/raphaeltm/simple-agent-manager/pull/2983), merged as `a1de24b4` on 2026-11-23 06:44Z. Main CI passed, and Deploy Production run 45127605791 succeeded at 07:04Z.
- Reviews:
  - task-completion-validator: ADDRESSED (4 MEDIUM fixed in `932cdf34e`).
  - CodeRabbit: "Review skipped" (auto reviews disabled).
  - Codex: two inline P2s raised on the first head; both were already fixed in `932cdf34e` and are answered on the PR.
- Process note: the merge happened before those inline threads were read. Read `pulls/<n>/comments` before merging, because a Codex "Completed" summary does not mean it found nothing.
- Memory hygiene:
  - Knowledge: added SecurityPolicy and ResponseStyle observations; updated 3 (two InboxDesign, one SelfDebuggingSystem); confirmed 4.
  - Ideas: completed 01M7VTNAG1HMCE18GCNPS052X3 (#2952); narrowed 01M7W6ZTZETXE75N8NRKR3R0CF; added two tracking notes on 01M7CX61WVX72T7CFQNRTX0DVM.
