# CI browser install: survive an unreachable Ubuntu apt mirror

SAM task `01M75JHJG4MSGSDZ39Y34D4STH`, dispatched by PR Shepherd
`cron-cdfe920ab713f2aa3eca414f064181f72d7843e5d79e058c9427638bdb0f38cc`.
Branch `sam/repair-ci-browser-installation-4d4sth`.

## Problem

From about 13:48 UTC on 2026-11-11 every CI job that installs Chromium failed at
`playwright install --with-deps chromium`, before any test ran:

```text
Temporary failure resolving 'azure.archive.ubuntu.com'
E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?
Failed to install browsers
Error: Installation process exited with code: 100
```

Main CI run 43037509441 at `5344962e49f93760c27fc67c46b26d2d9698eae4` failed in Marketing Site
and Workspace Quality Surfaces, and failed again on a failed-jobs rerun. Production deploys only
after green main CI, so the merged #2653 could not ship. The same failure hit PR runs
43034946392, 43032608604, 43037176840, 43038655514 and 43042266334.

## Hold conditions (from the task brief)

- The PR stays **draft** with `needs-human-review` until the parent Shepherd approves the exact PR
  number and full head SHA. No ready-for-review, no merge before that.
- CI-only change. Shared staging is in use by other tasks and is not needed here.
- No main CI reruns and no deployments from this task. The self-host coordinator
  `01M72KTXWD8FJ0Z7TXKN5GF20J` owns the production rollout.

## Research findings

1. **Cause is upstream, not the repo.** `status.canonical.com` reports "DNS - Major Outage" since
   14:26 UTC. `actions/runner-images` #15296 and #15297, both opened today, report the same
   failure on 22.04, 24.04 and 26.04 hosted runners from about 13:48 UTC.
2. **Why apt has no way out.** Hosted Ubuntu runners read mirrors from `/etc/apt/apt-mirrors.txt`
   (144 bytes in the failing logs). The fall-through order in the logs is
   `azure.archive.ubuntu.com`, `archive.ubuntu.com`, `security.ubuntu.com`: three names in one DNS
   zone. apt's mirror method tries each in turn and all three fail together.
3. **Cost of the failure.** The runner image sets apt to retry, so `apt-get update` alone took
   3 min 20 s to 6 min 55 s and the whole step 10 to 21 minutes before exiting 100. A healthy
   step takes 20 to 35 seconds (runs 43030397563, 43024950540, 43023908470).
4. **What is actually missing.** Only nine font packages (`fonts-ipafont-gothic`,
   `fonts-freefont-ttf`, `fonts-tlwg-loma-otf`, `fonts-unifont`, `fonts-wqy-zenhei`,
   `xfonts-encodings`, `xfonts-utils`, `xfonts-cyrillic`, `xfonts-scalable`). Chromium's shared
   libraries are already on the image. The fonts still matter: they change how pages render, so
   skipping them would make browser results depend on the day.
5. **A retry or rerun does not help.** apt already retries. The failed-jobs rerun of main failed
   the same way 20 minutes later, and runs kept failing at 15:25 UTC.
6. **History.** Of the last 100 failed CI runs (2026-11-02 to 11-11), 25 failed install-step jobs
   in 5 runs, all today. No earlier failure of this step in that window. Upstream shows the same
   class recurring on hosted runners: #14594 (Aug), #14823 (Sep), #15040 and #15142 (Oct).
7. **Fallback mirror.** `https://mirrors.edge.kernel.org/ubuntu/` is outside the `ubuntu.com`
   zone. Checked 2026-11-11 15:35 UTC: it serves `InRelease` for noble, noble-updates,
   noble-backports, noble-security, resolute and resolute-security (Ubuntu-signed, dated the same
   day) and the font `.deb` files. apt verifies indexes and packages against the Ubuntu archive
   keyring on the runner, so the mirror only changes where signed bytes come from.
8. **apt mirrorlist format** (`apt-transport-mirror(1)`): one URI per line, metadata after a tab,
   `priority:N` with the lowest number tried first, unprioritised mirrors last.
9. **`timeout` cannot stop apt on its own.** Playwright starts apt through `sudo`, and sudo does
   not pass on a signal sent from its own process group. A timed-out attempt leaves a root-owned
   `apt-get` holding the apt locks, so it has to be stopped as root before a second attempt.
10. **Existing patterns.** No retry or mirror helper exists for apt in `scripts/ci/` or the
    workflows. CI wiring is tested with vitest in `scripts/quality/ci*.test.ts`, run by the
    `CI Workflow` job. `ci-worker-suite.test.ts` pins the visual job's `if`.
11. **The browser jobs would not run on this PR.** Their path filters (`repo-quality`,
    `marketing-site`, `web-ui`) do not match a change to `ci.yml` or `scripts/ci/`. Without a
    filter for the helper, a change to it would merge without ever running on a real runner.
12. **Other apt users, out of scope.** `deploy-installer.yml` runs the same Playwright install in
    a deploy workflow, `codspeed.yml` installs valgrind inside a third-party action, and
    `acp-codex-review-build.yml` calls `apt-get` directly. See "Not in this change".

## Options considered

| Option | Verdict |
| --- | --- |
| Retry the step with backoff | Rejected. The outage lasted hours; apt already retries. |
| Drop `--with-deps`, or skip apt when `ldd` finds no missing library | Rejected. Leaves the fonts out and makes rendering differ between healthy and outage days. |
| Cache the `.deb` files | Rejected. New cache infrastructure, and stale packages by design. |
| Run the jobs in the Playwright container image | Rejected. Changes the whole job environment for all three jobs. |
| Rerun the same install once against a mirror outside the failing DNS zone | **Chosen.** Smallest change that would have passed today, with nothing skipped. |

## Implementation checklist

- [x] `scripts/ci/run-with-apt-mirror-fallback.sh`: bounded first attempt, stop leftover
      `apt-get`, put the fallback mirror first in the mirrorlist, one bounded second attempt, fail
      closed. Defaults in `DEFAULT_*` constants with environment overrides (finding 2, 3, 7, 8, 9).
- [x] Reject a non-https or malformed fallback URL and non-numeric timeouts before running.
- [x] `ci.yml`: the three install steps call the helper with the unchanged
      `playwright install --with-deps chromium` command.
- [x] `ci.yml`: `browser-install` path filter for the helper, added to the three browser jobs'
      conditions and to the `ci-workflow` filter (finding 11).
- [x] `scripts/quality/ci-browser-install.test.ts`: behaviour tests through the real script plus
      wiring tests; added to the `CI Workflow` job's test list (finding 10).
- [x] `scripts/quality/ci-worker-suite.test.ts`: updated the pinned visual-job condition.
- [ ] Mutation checks: each guard removed once, the intended test goes red.
- [ ] Draft PR; all three browser jobs green on the candidate head on real runners.
- [ ] Real-runner evidence that the fallback path itself works (live outage, or a temporary
      commit that makes the runner mirrors unreachable, removed again before review).
- [ ] Local reviewers: task-completion-validator, security-auditor, test-engineer,
      constitution-validator.
- [ ] Follow-up idea filed for the other apt users (finding 12).

## Acceptance criteria

- [ ] With the runner's mirrors unreachable, the three browser jobs install Chromium **with** its
      system dependencies and run their full test suites. Verified on real runners.
- [ ] With healthy mirrors, the step behaves as before: one attempt, mirrorlist untouched.
      Verified by test and on real runners.
- [ ] When the fallback cannot serve the install either, the step fails. Verified by test.
- [ ] `--with-deps chromium` is present in every attempt. Verified by test.
- [ ] apt signature verification is untouched: the helper changes only the mirrorlist file.
      Verified by reading the diff and by the security review.
- [ ] No new credentials, no changes to concurrency, runners, timeouts of jobs, or schedules.
- [ ] A change to the helper runs every job that uses it. Verified by test and by this PR's run.

## Bounds (rule 81)

Per attempt: 180 s plus 10 s kill grace. Between attempts: up to 30 s for apt to exit. Worst case
for the step: 180 + 10 + 30 + 180 + 10 = 410 s, against 600 to 1,260 s for today's failure and
20 to 35 s when healthy. Job timeouts (25, 30 and 45 minutes) are unchanged and still hold:
Marketing Site ran 8.5 minutes in total when healthy, so about 15 minutes worst case.

## Not in this change

- `deploy-installer.yml` browser audit. It is a deploy workflow that only runs with an installer
  deploy, which this task may not trigger, so the change could not be proven.
- `codspeed.yml`. apt runs inside `CodSpeedHQ/action`; a wrapper around a command cannot reach it.
- `acp-codex-review-build.yml`. Manual, branch-specific build.

All three recover when the upstream outage ends. Tracked as a follow-up idea.

## Staging

Exempt: the change touches only CI workflow configuration, a CI helper script and tests. Nothing
in it is deployed. The proof is the CI run on the candidate head.

## Deviation from `/do`

The task file was committed on the feature branch instead of being pushed to `main` first. A push
to `main` starts main CI and, when green, a production deploy, and the brief leaves release timing
with the rollout coordinator.

## References

- Runs: 43037509441 (main), 43034946392 job 130571384550 (#2656), 43042266334
- `actions/runner-images` #15296, #15297, #15040, #14823, #14594
- `apt-transport-mirror(1)`
- Rules: `.claude/rules/62`, `.claude/rules/74`, `.claude/rules/81`, `.claude/rules/03`
