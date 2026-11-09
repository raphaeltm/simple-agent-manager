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
- [ ] Assign a random ownership marker to each Docker agent launch, overriding profile env collisions.
- [ ] Snapshot container process identities and ancestry; select only marked processes and their descendants, fence signals against PID reuse.
- [ ] Preserve owned targets across TERM/KILL, including an env-cleared child and orphaned TERM-resistant descendant.
- [ ] Remove command-pattern cleanup and obsolete pattern-based tests.
- [ ] Test actual cleanup script/processes via fake Docker transport plus real same-container staging sessions.
- [ ] Targeted Go tests/race/vet/build; full CI.
- [ ] Local specialist reviews (Go, test/completion, constitution/docs).
- [ ] Coordinate staging slot, provision fresh binary/node, heartbeat, peer survival stop/restart and no child leak, immediate cleanup.

## Acceptance
Two same-type live sessions share one workspace container; stopping/restarting one leaves its peer running and able to return a result. All owned processes are cleaned, including TERM-resistant child, with no command-pattern cross-session kills. Missing ownership never broadens scope.

## Release hold
Draft PR + needs-human-review. Do not mark ready/remove label/merge until coordinator approves PR number and exact head. Any new commit voids approval. No direct main commits; archive notes separate draft PR. Staging slot required, explicit small resources CPU0.2/RAM0.5/disk5GB; immediately delete own staging node.
