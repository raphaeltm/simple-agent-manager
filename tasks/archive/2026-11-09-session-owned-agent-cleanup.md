# Session-owned agent process cleanup

## Problem

Before this fix, stopping one ACP session ran container-wide pkill by adapter/release command, terminating same-type peer sessions sharing the workspace container. Idea 01M6Y51G87JNWZ6CGX4ET7EBF3. Third PR in chain after #2595 and #2601 production success.

## Research

- process.go launches docker exec with host-only process group; host signals do not reach container descendants.
- killContainerProcesses uses command-pattern matching, including pinned Codex release paths.
- Stop returns when docker CLI exits; a TERM-resistant orphan may survive.
- Ownership must survive exec wrappers and parent exits; never use command identity as session identity.
- Same user VM boundary/nested privileged containers remain unchanged.

## Plan

- [x] Assign a random ownership marker to each Docker agent launch, overriding profile env collisions.
- [x] Snapshot container process identities and ancestry; select only marked processes and their descendants, fence signals against PID reuse.
- [x] Preserve owned targets across TERM/KILL, including an env-cleared child and orphaned TERM-resistant descendant.
- [x] Remove command-pattern cleanup and obsolete pattern-based tests.
- [x] Test actual cleanup script/processes via fake Docker transport plus real same-container staging sessions.
- [x] Targeted Go tests/race/vet/build; full CI.
- [x] Local specialist reviews (Go, test/completion, constitution/docs).
- [x] Coordinate staging slot, provision exact binary/fresh small node, confirm heartbeat and live Stop/peer/replacement continuity; prove child/orphan cleanup through local real-process and mutation controls, as accepted by coordinator. Explicitly delete the test node and verify cleanup.

## Acceptance

Two same-type live sessions share one workspace container; stopping/restarting one leaves its peer running and able to return a result. Cleanup targets proven session ownership rather than command patterns, including the TERM-resistant and orphan-child cases exercised by local tests. Missing ownership never broadens scope. Capability limits below qualify this guarantee; universal cleanup of deliberately unidentifiable processes is not claimed.

## Release constraints (satisfied for implementation)

Draft PR + needs-human-review. Do not mark ready/remove label/merge until coordinator approves PR number and exact head. Any new commit voids approval. No direct main commits; archive notes separate draft PR. Staging slot required, explicit small resources CPU0.2/RAM0.5/disk5GB; immediately delete own staging node.

## Local evidence

New real-process shim tests passed3 repeats including orphan/env-cleared child, peer survival through stop/restart, marker override and PID reuse. Race run3 repeats passed before final orphan control addition. Full ACP/coverage, vet and vm-agent build subsequently passed. Initial new tests failed compilation against missing owned-cleanup interface. Behavioral mutation removing post-host-exit KILL failed the owned-orphan regression. Full ACP passed in40.774s with82.9% coverage; vet/build passed.

Historical staging queue was #2605 → model catalog → this task. Direct coordinator grants were obtained before testing. Claude Code test agents were used because the OpenCode installer returned 504.

## Review correction

Go and test reviewers confirmed that an env-cleared child orphaned before Stop cannot be inferred from a late ancestry snapshot. Added launch-time Linux session ownership via setsid (already required by secret-exec supervisor), plus a consumed stdout readiness header proving session ID/starttime before returning the adapter. No PID files or profiles. Session membership covers env-cleared/reparented children; inherited marker covers ordinary detached descendants. PID/session leader reuse fenced by starttime. Added combined env-cleared/pre-Stop-orphan regression. The subsequent specialist re-review passed.

## Session-continuity correction

Review found that a saved SID without a live original leader could be recycled after extinction. A small in-container shell supervisor now retains leadership until adapter exit cleanup finishes (TERM/grace/KILL and child reap), preserving adapter stdin/stdout and exit status. Go SID selection requires the exact live leader starttime; missing/reused leaders never establish ownership. Added absent/recycled-leader controls plus malformed/EOF/timeout launch-failure cleanup, peer survival, first buffered ACP output and exit-status tests. Supervisor excludes its own launch ancestors so setsid --wait can preserve the adapter exit status. Docker transport stays alive during container grace; LocalLauncher still receives host TERM.

## Static-analysis corrections

SonarCloud reported snapshot parser cognitive complexity, duplicated orphan test cases and host Docker PATH lookup. Split metadata parsing from ownership retention, table-drive both orphan variants, and use configurable absolute ProcessConfig.DockerExecutable with cloud-init-installed /usr/bin/docker default. Local tests inject the transport path explicitly. Added relative host path rejection test. Final prior supervisor ACP42.909s82.8%, vet/build and reviewers all passed; targeted race after static-analysis correction passed3.814s; subsequent re-review and final CI passed.

## Container compatibility correction

Coordinator requested compatibility with arbitrary devcontainer images before staging. Launch now caches a bounded capability probe per immutable container ID. Missing `setsid` or unsupported `--wait` uses the same unique marker and a captured launch-root PID/starttime with ancestry cleanup; a private SID is optional. Missing NUL-safe batch grep retains root/ancestry/SID ownership without failing launch; `tr` is no longer used. Missing `/proc` degrades to direct launch with a warning and an explicit cleanup error rather than broader signals. Warn records containerId and reason, never environment contents.

Real launch-path tests cover absent setsid, BusyBox-style no --wait, missing grep, missing tr, and absent setsid+grep. Every case proves owned env-cleared children are cleaned at Stop, same-type peer replies survive Stop/replacement, and the probe runs once for three launches. Mutation forcing setsid despite failed probing makes both setsid compatibility tests fail at the real ownership handshake (expected red; restored).

Replaced per-process tr/grep forks with one batched grep per snapshot and builtin shell stat reads. The production capture entry point processes 2,001 synthetic Linux process records plus ~8 MiB environments in 0.819 seconds locally, ~2,443 processes/s, within the default 3-second per-command deadline. This is a metadata/environment fixture, not 2,001 spawned host processes (host PID quota); it runs the actual Docker transport and snapshot/parser/retention path. At that measured throughput three capture phases cost ~2.46 seconds total; each has its own deadline, with no scheduled retries. Container signal phases add two bounded Docker commands; default grace is 5 seconds and host wait is bounded separately at 10 seconds. Slow/I/O-blocked scans time out visibly and never broaden ownership.

The staging queue subsequently changed to coordinator-controlled grants. The correction was pushed and re-reviewed before the coordinator granted each test slot.
The conservative default Stop budget is 25 seconds: at most three snapshots × 3 seconds, two signals × 3 seconds, plus the 10-second host wait (these overlap in practice). The host deadline uses a context completion channel so it remains readable during both escalation and final wait. Startup adds at most a 3-second cached capability probe and a 3-second readiness wait.

## Batch-scan and capability-cache review corrections

Go and safety review caught an ownership race: collecting marker PIDs before stat metadata could attach old ownership to a recycled PID's new starttime. Both scan paths now capture identity before marker discovery. The supervisor rechecks the captured starttime immediately before signals; host cleanup retains the earlier identity for its existing signal-time check. Deterministic replacement fixtures exercise production capture and supervisor signaling without touching a real peer PID. Reverting to ff6c04b makes both controls fail (replacement start999 adopted / unexpected signal). A failed-then-successful real launch control also fails under the old permanently failed cache and passes after failed probes are evicted. Successful probes include launch user/PATH in their cache key and run in that environment; a separate launch-PATH control covers an image default that has setsid while the agent's PATH does not.

## Final acceptance and evidence (2026-11-09)

[PR #2606](https://github.com/raphaeltm/simple-agent-manager/pull/2606) completed at approved head `a554048af0bed6e910efc3268761dbd101132dae`. The coordinator explicitly accepted this split: live real-API Stop/peer/replacement continuity; local real-process and mutation controls for orphan, env-cleared and TERM-resistant children. Earlier attempts timed out during workspace readiness and then child-PID fixture setup; neither proved live isolation. Each attempt explicitly deleted its node and independently verified cleanup.

- Full ACP race suite passed in 49.083 seconds with 83.1% coverage; Go vet passed. All three specialist reviewers passed/addressed findings. Final Sonar analysis reported zero new issues. Refreshed [CI 42693477288](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42693477288) and [E2E 42693477184](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42693477184) passed.
- Exact-head staging [42685635571](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42685635571) succeeded. The final small node `01M70YK4S42HT7EBJM0DN90QH5` reported the exact candidate and heartbeat at 20:08:45 UTC. Workspace `01M70YK52QJQVBM6VS4JJTVYHK` hosted two ready Claude sessions.
- Real API Stop A and owner runtime socket closure completed at 20:09:45; the existing peer replied at 20:09:56; replacement A replied at 20:10:21; the same peer replied again at 20:10:24. Full post-ready history rejected restart/recovery/crash/socket closure, preventing automatic recovery from masking a killed peer.
- Filtered node logs contained one stop entry, retained only as a count. This supports the result and does not independently prove ownership scope. Three Playwright app smoke pages returned HTTP 200 with zero page errors.
- Node DELETE returned HTTP 200 at 20:10:41. Independent D1 at 20:11:07 confirmed node/workspace absent and zero active staging nodes. Slot released to the coordinator. Library evidence: `bug3-live-v3.cjs`, `pr2606-live-state-v3.json`, `pr2606-v3-node-d1.json`, `pr2606-v3-cleanup-d1.json`.
- Trusted CodeRabbit request [42690460714](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42690460714) succeeded; response was rate limited. The required wait completed via the accepted 20:27 UTC fallback, with no review or inline findings. Readiness/reopen also automatically requested review and received rate-limit responses; no findings arrived before merge.
- Coordinator approval named PR #2606 and the full head SHA in SAM event `90be1871-159b-4b60-a965-92f736eda3ce`. The coordinator marked ready; the hold label was removed and the frozen evidence check refreshed as authorized. Squash merge used an exact-head guard and produced `e8064c61ed9e93e2e253a6aa2a0de58ef97987fe` at 20:44:52 UTC, after confirming no active production deployment.
- Main [CI 42695899633](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42695899633) and [production 42698417838](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42698417838) succeeded. Cloudflare served that exact main/merge commit at 100%, version `f0f8860c-bb73-4ef1-8862-d4a07bd7b258`; independent read at 21:13:41 UTC confirmed `/health` HTTP 200 and healthy. Evidence: library `pr2606-production-check.json`. No production lifecycle/provisioning tests were run.

## Capability limits and completion validation

Without `setsid`, an env-cleared orphan whose ancestry was lost before capture is outside the fallback ownership fence. Missing `/proc` permits launch but reports unavailable cleanup ownership. Children deliberately removing marker, ancestry and original Linux-session ownership before capture are outside detection. The implementation never compensates by broad command-pattern killing.

Final task-completion review passed research/checklist, criteria/test and vertical-slice coverage (no UI inputs changed). Stale workflow notes are reconciled above. The coordinator accepted `process.go` at 717 lines versus 703 on main because container logic moved to `process_container.go`. All three implementation PRs are merged and production-verified. This archival reconciliation is submitted as a separate draft PR for coordinator review, with no direct main commits.
