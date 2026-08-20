# A Test Must Reach the Feature the Way Production Does

## When This Applies

Any test for a feature whose value depends on a **delivery path** — a broadcast, a
socket push, a callback, a scheduled emit — rather than on a pure function's return
value. Also any UI test that asserts a component is present rather than that a user
could see and use it.

## Why This Rule Exists

The phase-level wake-progress feature (idea `01KY...D1WSZ`, branch
`sam/wake-progress-push-phases`) was found **non-functional four separate times**, by
four different reviewers, across two review rounds. Every layer was individually
correct and every test was green:

1. **Playwright screenshots captured the wrong surface.** The first-run onboarding modal
   covered the chat. The banner was in the DOM and Playwright reported it "visible", so
   every assertion passed — while the overflow check measured the modal's layout and all
   ten screenshots were byte-identical.
2. **The terminal broadcast was unreachable dead code.** `transitionToInProgress` writes
   `execution_step='running'` through its own raw `UPDATE`, bypassing the choke point the
   emit was attached to. Three tests "covered" it — server, hook, and E2E — and every one
   hand-fed the terminal value instead of driving the real transition.
3. **The socket was closed for the entire wake.** `useChatWebSocket` was gated on
   `status === 'active'`, but a waking session is `sleeping` until the very end. The hook
   tests passed `enabled` in directly, so they never saw the gate.
4. **The stale-guard swallowed the payload on the common path.** Typing into a sleeping
   session routed hydration down a branch that dropped every phase update. No test
   combined "user triggers the wake" with "server reports wake data".

The pattern is one bug wearing four costumes: **a test that reaches the feature by a
path production never takes.**

## Class of Bug

**A green test that cannot observe the failure it exists to prevent.** It is the
generalization of the layout-specific case in rule 56 and the reporting case in rule 02
("a green test count is not a green suite"). The tell is that the test constructs the
condition it is meant to detect, instead of causing it.

## Hard Requirements

1. **Enter through the real trigger.** If production reaches the code via a state
   transition, a socket message, or a user action, the test must too. Calling the handler
   directly proves the handler works; it does not prove anything reaches the handler.

2. **Never hand-feed the value under test.** If the assertion is "X is emitted when Y
   happens", the test must cause Y. A test that passes X in and asserts X comes out is
   tautological — this is what let a dead code path ship with three green tests.

3. **Gates and guards are part of the feature.** Any `enabled:`, early return, or
   conditional branch between the trigger and the effect must be exercised at its real
   value, not overridden by the test. If a test sets `enabled: true` directly, it has
   deleted the gate from its own coverage.

4. **Prove every new guard discriminating, and prove the proof.** Delete the guard,
   confirm exactly the intended test goes red, restore it. If the test still passes,
   the test is wrong — investigate *why* before rewriting the assertion. Sticky state is
   the usual culprit: a value already latched by an earlier step makes the later
   assertion unfalsifiable regardless of the guard.

5. **An absence assertion needs a liveness assertion beside it.** "The banner is not
   shown" is also satisfied by a crashed page, a closed socket, or a component that never
   mounted. Assert something positive rendered in the same test.

6. **Screenshot evidence must be checked, not just produced.** Open the images. Identical
   file sizes across cases that should differ means the run captured the same thing every
   time — the audit is measuring something other than the feature.

## Quick Compliance Check

- [ ] The test triggers the feature the way a user or the runtime does
- [ ] No test supplies the value it is asserting on
- [ ] No test overrides a production gate to reach the code under it
- [ ] Every guard was deleted once and the intended test went red
- [ ] Absence assertions are paired with a positive-render assertion
- [ ] Screenshots were opened and differ where the scenarios differ

## References

- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md` — the layout case
- `.claude/rules/02-quality-gates.md` — "a green test count is not a green suite"
- `.claude/rules/35-vertical-slice-testing.md` — realistic state at boundaries
- `.claude/rules/10-e2e-verification.md` — trace the path, then test the path
- Task: `tasks/archive/2026-08-19-wake-progress-push-and-phases.md`
