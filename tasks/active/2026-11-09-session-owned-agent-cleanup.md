# Session-owned agent process cleanup

## Problem
Stopping one ACP session currently runs container-wide pkill by adapter/release command, terminating same-type peer sessions sharing the workspace container. Idea 01M6Y51G87JNWZ6CGX4ET7EBF3. Third PR in chain after #2595 and #2601 production success.

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
- [ ] Test actual cleanup script/processes via fake Docker transport plus real same-container staging sessions.
- [ ] Targeted Go tests/race/vet/build; full CI.
- [ ] Local specialist reviews (Go, test/completion, constitution/docs).
- [ ] Coordinate staging slot, provision fresh binary/node, heartbeat, peer survival stop/restart and no child leak, immediate cleanup.

## Acceptance
Two same-type live sessions share one workspace container; stopping/restarting one leaves its peer running and able to return a result. All owned processes are cleaned, including TERM-resistant child, with no command-pattern cross-session kills. Missing ownership never broadens scope.

## Release hold
Draft PR + needs-human-review. Do not mark ready/remove label/merge until coordinator approves PR number and exact head. Any new commit voids approval. No direct main commits; archive notes separate draft PR. Staging slot required, explicit small resources CPU0.2/RAM0.5/disk5GB; immediately delete own staging node.

## Local evidence
New real-process shim tests passed3 repeats including orphan/env-cleared child, peer survival through stop/restart, marker override and PID reuse. Race run3 repeats passed before final orphan control addition. Full ACP/coverage, vet and vm-agent build running. Initial new tests failed compilation against missing owned-cleanup interface. Behavioral mutation removing post-host-exit KILL failed the owned-orphan regression. Full ACP passed in40.774s with82.9% coverage; vet/build passed.

Staging queue confirmed by coordinator: #2605 → model catalog task → this task. Wait direct release message before deploy. Claudecode test agents requested due OpenCode installer504.

## Review correction
Go and test reviewers confirmed that an env-cleared child orphaned before Stop cannot be inferred from a late ancestry snapshot. Added launch-time Linux session ownership via setsid (already required by secret-exec supervisor), plus a consumed stdout readiness header proving session ID/starttime before returning the adapter. No PID files or profiles. Session membership covers env-cleared/reparented children; inherited marker covers ordinary detached descendants. PID/session leader reuse fenced by starttime. Added combined env-cleared/pre-Stop-orphan regression. Re-review required.

## Session-continuity correction
Review found that a saved SID without a live original leader could be recycled after extinction. A small in-container shell supervisor now retains leadership until adapter exit cleanup finishes (TERM/grace/KILL and child reap), preserving adapter stdin/stdout and exit status. Go SID selection requires the exact live leader starttime; missing/reused leaders never establish ownership. Added absent/recycled-leader controls plus malformed/EOF/timeout launch-failure cleanup, peer survival, first buffered ACP output and exit-status tests. Supervisor excludes its own launch ancestors so setsid --wait can preserve the adapter exit status. Docker transport stays alive during container grace; LocalLauncher still receives host TERM.

## Static-analysis corrections
SonarCloud reported snapshot parser cognitive complexity, duplicated orphan test cases and host Docker PATH lookup. Split metadata parsing from ownership retention, table-drive both orphan variants, and use configurable absolute ProcessConfig.DockerExecutable with cloud-init-installed /usr/bin/docker default. Local tests inject the transport path explicitly. Added relative host path rejection test. Final prior supervisor ACP42.909s82.8%, vet/build and reviewers all passed; targeted race after static-analysis correction passed3.814s; re-review/final CI pending.

## Container compatibility correction
Coordinator requested compatibility with arbitrary devcontainer images before staging. Launch now caches a bounded capability probe per immutable container ID. Missing `setsid` or unsupported `--wait` uses the same unique marker and a captured launch-root PID/starttime with ancestry cleanup; a private SID is optional. Missing NUL-safe batch grep retains root/ancestry/SID ownership without failing launch; `tr` is no longer used. Missing `/proc` degrades to direct launch with a warning and an explicit cleanup error rather than broader signals. Warn records containerId and reason, never environment contents.

Real launch-path tests cover absent setsid, BusyBox-style no --wait, missing grep, missing tr, and absent setsid+grep. Every case proves owned env-cleared children are cleaned at Stop, same-type peer replies survive Stop/replacement, and the probe runs once for three launches. Mutation forcing setsid despite failed probing makes both setsid compatibility tests fail at the real ownership handshake (expected red; restored).

Replaced per-process tr/grep forks with one batched grep per snapshot and builtin shell stat reads. The production capture entry point processes 2,001 synthetic Linux process records plus ~8 MiB environments in 0.819 seconds locally, ~2,443 processes/s, within the default 3-second per-command deadline. This is a metadata/environment fixture, not 2,001 spawned host processes (host PID quota); it runs the actual Docker transport and snapshot/parser/retention path. At that measured throughput three capture phases cost ~2.46 seconds total; each has its own deadline, with no scheduled retries. Container signal phases add two bounded Docker commands; default grace is 5 seconds and host wait is bounded separately at 10 seconds. Slow/I/O-blocked scans time out visibly and never broaden ownership.

Staging queue changed: catalog releases to coordinator, who must grant our slot after this correction is pushed and re-reviewed. Do not deploy on a catalog release alone.
The conservative default Stop budget is 25 seconds: at most three snapshots × 3 seconds, two signals × 3 seconds, plus the 10-second host wait (these overlap in practice). The host deadline uses a context completion channel so it remains readable during both escalation and final wait. Startup adds at most a 3-second cached capability probe and a 3-second readiness wait.

## Batch-scan and capability-cache review corrections
Go and safety review caught an ownership race: collecting marker PIDs before stat metadata could attach old ownership to a recycled PID's new starttime. Both scan paths now capture identity before marker discovery. The supervisor rechecks the captured starttime immediately before signals; host cleanup retains the earlier identity for its existing signal-time check. Deterministic replacement fixtures exercise production capture and supervisor signaling without touching a real peer PID. Reverting to ff6c04b makes both controls fail (replacement start999 adopted / unexpected signal). A failed-then-successful real launch control also fails under the old permanently failed cache and passes after failed probes are evicted. Successful probes include launch user/PATH in their cache key and run in that environment; a separate launch-PATH control covers an image default that has setsid while the agent's PATH does not.
