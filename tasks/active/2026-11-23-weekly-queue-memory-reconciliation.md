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

- [x] Audit every `tasks/active/` file against merged PRs and deploys
- [x] Archive the 24 shipped files: tick evidenced gate lines and append a dated reconciliation note
- [x] Move `2026-11-14-merge-streamed-chunks.md` back to backlog with its open remainder
- [ ] Audit all 348 backlog files (4 read-only slices); spot-check evidence for every non-KEEP verdict
- [ ] Delete shipped, obsolete, superseded and duplicate backlog files; annotate PARTIAL ones
- [ ] Comment a weekly status/park note on #2265 and #1788
- [ ] PR description lists a one-line rationale for each deletion
- [ ] Part 2: SAM knowledge/idea/policy hygiene (outside the repo)
- [ ] Digest via `update_task_status`

## Acceptance criteria

- [ ] `tasks/active/` contains only this file until merge (then nothing)
- [ ] Every deleted backlog file has a verdict and evidence in the PR description
- [ ] No backlog file deleted without a cited merged PR, commit or code check
- [ ] Each PR older than 7 days has one comment from this run
- [ ] The change touches only files under `tasks/`: no staging deploy (task-file-only exemption)
