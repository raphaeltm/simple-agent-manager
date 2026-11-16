# A task fails after three placement refusals instead of provisioning a node

## Problem

On staging (sammy.party, 2026-11-16 15:15–15:19Z) two tasks were submitted a few seconds apart
in one project, with no node running. The first provisioned a `medium` node
(`01M7JETDBKN4DQ4FA2ER3FMC8Q`); the second (a Codex task) was admitted to it. The first task
(`01M7JERJX364WP3G7SJ7MAR4E3`, Claude Code, VM) then failed with:

> Workspace placement was refused 3 times in a row; node 01M7JETDBKN4DQ4FA2ER3FMC8Q cannot admit
> this task: memory budget would be exceeded after host reserve; measured memory use above the host
> reserve leaves no room for this reservation

The task that triggered the node lost it to a sibling and was failed rather than placed on
another node or provisioned a new one. A resubmitted identical task waited in
`provider_transient_capacity` and was placed later.

## Context

Found while verifying inbox slice D (PR #2792) on staging. Not caused by that PR (no scheduler
changes). Rules to read first: `.claude/rules/69-aggregate-capacity-at-final-reservation.md`,
`.claude/rules/74-proxy-signals-must-match-the-condition.md` (measured memory as a veto).

## Acceptance Criteria

- [ ] A task whose own provisioned node is taken by a sibling is re-planned (another node or a new
      one) instead of failing after three refusals on that node
- [ ] The refusal counter does not count refusals caused by a sibling's reservation as terminal
- [ ] A test reproduces two near-simultaneous submissions in one project with one small node
