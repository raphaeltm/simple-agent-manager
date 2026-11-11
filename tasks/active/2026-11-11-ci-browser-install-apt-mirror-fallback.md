# Restore required CI installs during the Ubuntu mirror DNS outage

## Problem and authorization

Production releases require green main CI. On 2026-11-11, main run43037509441 at
5344962e49f93760c27fc67c46b26d2d9698eae4 and multiple PRs failed while installing signed
Ubuntu packages, before their browser or benchmark tests ran. Raphaël requested a fix with
Claudiii/Fable5.2/high. Task01M75JHJG4MSGSDZ39Y34D4STH produced the initial candidate
8fd94b15b1e2aef097329ff938388b188f4e168e in draft PR2659.

This is a CI-only repair. No shared staging or production deployment is triggered by this task;
the existing rollout coordinator owns deployment timing.

## Research and cause

- Canonical's status RSS reported DNS Major Outage at14:26UTC. GitHub runner-image reports
  actions/runner-images#15296 and #15297 corroborate unresolved Ubuntu mirror names across
  hosted Ubuntu images. SAM failed logs identify azure.archive.ubuntu.com resolution failures.
- The runner mirrorlist /etc/apt/apt-mirrors.txt uses three names under ubuntu.com. Built-in apt
  retries consumed10-21minutes and still failed. Ordinary installs took20-35seconds.
- Chromium shared libraries were already present, but nine font packages were missing.
  Dropping --with-deps would change rendering and weaken validation.
- The independent HTTPS mirror mirrors.edge.kernel.org/ubuntu serves the same Ubuntu archive;
  apt retains its existing Ubuntu-keyring index/package authentication. No trust relaxation.
- A timed-out parent can leave root-owned apt-get descendants. The helper terminates leftover
  apt-get and waits for both apt-get and dpkg to exit before another attempt.
- The same outage blocked CodSpeed's internal valgrind/libc6-dbg installation and the installer
  workflow's browser audit. Reuse the helper at those boundaries; retain the pinned upstream
  benchmark action and all tests. CodSpeed's existing path filters/concurrency stay unchanged.
- Initial helper tests accidentally performed live DNS lookups. Five tests exceeded the5second
  test limit during the actual outage. Fake DNS at the process boundary, while exercising the
  real helper and mirrorlist state; do not mask the defect with a blanket timeout increase.

## Implementation checklist

- [x] Bounded unchanged command, one signed-mirror fallback retry, nonzero exit on failure.
- [x] Explicit HTTPS-only fallback validation and positive configurable durations within the shell integer range.
- [x] DNS diagnostic and settle-poll durations have defaults/environment overrides; clamp each
      poll to the remaining settle budget. Capture positional status once (Sonar shell:S7679).
- [x] CI's three browser installs and the installer browser audit retain --with-deps chromium
      and use the same helper; relative paths are checked from each step's working directory.
- [x] Prepare apt indexes with Error-Mode=any through the helper before the pinned CodSpeed
      action. This exposes partial apt-update failures and preserves benchmark execution.
- [x] Helper changes select all three CI browser jobs. CI wiring tests also run when installer
      or CodSpeed wiring changes. Original CodSpeed path filters and all concurrency defaults
      remain unchanged; one manual candidate-only CodSpeed run will prove that adapter.
- [x] Hermetic shell-boundary tests cover ordinary success, fallback ordering, HTTPS validation,
      failed fallback, disabled fallback, absent mirrorlist, stuck/delayed apt-get, dpkg-only
      cleanup, SIGTERM-resistant commands, bounded second attempts and hanging DNS lookups.
- [x] Wiring assertions check installer helper paths/system-dependency flags and benchmark
      preparation order/mode; source review verifies the existing action pin and test commands.
- [x] Final focused validation and discriminating mutation checks recorded below.
- [ ] Fresh security/constitution/test/completion local reviewers complete and findings resolved.
- [ ] Fresh final-candidate CI and candidate-only CodSpeed run pass; no gate is bypassed.
- [ ] Best-effort CodeRabbit request/wait and binding findings resolved before merge.

## Acceptance criteria

- [x] The outage fallback actually installs Chromium with system dependencies and runs the full
      three browser jobs: proven on initial8fd94b15 candidate in CI43050959059; see evidence.
- [x] Healthy mirrors require one attempt and no mirrorlist mutation; shell-boundary control.
- [x] Failed/disabled fallback and unsafe input exit nonzero; discriminating negative tests.
- [x] Root package-manager cleanup and both command attempts have finite wait budgets.
- [x] No credentials, package signature/TLS bypass, weaker tests or resource/concurrency changes.
- [ ] Final code candidate passes relevant CI and benchmark adapter validation.
- [ ] Required local reviews and release gates pass before merge.

## Work bounds

The hosted runner has three mirror entries. Configured wait budget:180+10seconds for the first
attempt, at most3*5seconds for diagnostic DNS,30seconds to settle package processes,180+10seconds
for the second attempt =425seconds, plus local process/file operations. Diagnostics scale with
mirror entries if an operator supplies another list. Each value has a CI environment override.
A healthy install remains one20-35second attempt. Existing job timeouts are unchanged.

## Validation evidence

Initial candidate8fd94b15b1e2aef097329ff938388b188f4e168e, CI43050959059:

| Job                        | ID           | Result |
| -------------------------- | ------------ | ------ |
| Marketing Site             | 130627805598 | PASS   |
| Workspace Quality Surfaces | 130627805995 | PASS   |
| Playwright Visual Tests    | 130627805783 | PASS   |

Parent independently read the first two completed logs: each first attempt hit180seconds, then
fetched Ubuntu indexes and all required font packages through the independent mirror. The tests
then completed successfully. This is real fallback evidence during the outage, rather than a
simulated DNS configuration or a claim based only on an install step. Initial CI Workflow failed
five non-hermetic DNS tests; that failure remains visible and must be fixed on the final head.

Final local validation: 5 focused CI quality files / 44 tests PASS; ESLint, Prettier,
shell syntax and git diff whitespace checks PASS. Seven final guard mutations were detected:

| Removed or weakened guard       | Discriminating result                                                    |
| ------------------------------- | ------------------------------------------------------------------------ |
| Positive duration validation    | Negative diagnostic-timeout test failed                                  |
| dpkg process detection          | dpkg-only cleanup test failed                                            |
| Nonzero second-attempt result   | Failed-fallback test failed                                              |
| Installer helper adapter        | Cross-workflow install wiring test failed                                |
| Strict apt-index error mode     | Benchmark setup wiring test failed                                       |
| Poll clamped to settle deadline | Long-poll case exceeded the12second harness budget; process group killed |

All mutated files were restored. Six results are assertion failures; the poll-bound result is
an externally enforced liveness deadline, rather than a claimed completed assertion. The intact
baseline completed that case in about3seconds. Fresh specialist reports and final CI remain
pending in the PR body.
Staging exemption: config-only CI scripts/workflow wiring and tests; no application runtime or
cloud infrastructure change. A staging deploy would not exercise the changed mechanism. Actual
candidate Actions runs provide the equivalent evidence; no shared staging mutation is required.

## Scope disposition and references

Manual acp-codex-review-build.yml also uses apt but is not a current release gate or incident
owner's branch. Follow-up Idea01M75Q9AWW6PBQQ6X7R0HND2EB records this manual builder rather than expanding the
current repair into an unexercised workload. This does not waive any failing required check on the current candidate.

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/2659
- Primary incident evidence: main43037509441; PR2656 job130571384550;
  backend benchmark130615570490 and installer130614950572.
- https://status.canonical.com/rss
- https://github.com/actions/runner-images/issues/15296
- https://github.com/actions/runner-images/issues/15297
- https://manpages.debian.org/trixie/apt/apt-transport-mirror.1.en.html
- Rules25,62,74,81 and ConstitutionXI apply. Planning/task file stays on the candidate branch
  because the rollout coordinator owns main; no extra main push for planning.
