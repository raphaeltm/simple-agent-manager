# No Untracked Behavior-Degrading Placeholders

## The Problem

It is sometimes tempting to ship a conservative placeholder that intentionally
produces a *worse* user-visible outcome "for now", pending some future
validation (a staging test, a coherence check, a load test). When that
placeholder merges without a tracked follow-up, three things go wrong at once:

1. The placeholder is strictly worse for the user than the real behavior.
2. The "validate later" intent lives only in a TODO comment or an archived task
   file — invisible to future agents, with no expiry and no owner.
3. A passing test suite that asserts the *degraded* behavior as the expected
   outcome locks the bug in: the tests are green, so nothing flags it.

## Incident That Created This Rule

PR #1256 added `resumeShouldReportTerminalErrorLocked(agentType) == "openai-codex"`
in `packages/vm-agent/internal/acp/session_host_process.go`. It converted every
*successful* codex `LoadSession` crash recovery into a terminal `"error"` →
`failed` task, "until codex LoadSession coherence is staging-validated." The
validation was never scheduled, no backlog task or idea tracked it, and a test
(`…_ReportsTerminalError`) asserted the degraded behavior as correct. The
placeholder shipped to production and produced recurring false task failures on
every codex mid-prompt disconnect until it was removed on 2026-06-15.

## Rule

When you introduce any guard, flag, branch, or placeholder that **intentionally
produces a worse user-visible outcome** pending future validation or work, you
MUST in the **same PR**:

1. **File a tracking backlog task or idea** describing exactly what validation /
   work must happen to lift the placeholder, and what the correct behavior is.
2. **Reference that task/idea ID in a code comment** directly adjacent to the
   guard, so any future reader (human or agent) can find the follow-up.
3. **Not assert the degraded behavior as the desired outcome in tests.** If you
   must test the placeholder, the test name and comment must mark it as a
   known-temporary state (e.g. `…_TemporarilyReportsX_PendingValidation`) and
   reference the tracking ID — never a name that implies the degraded result is
   the intended contract.

A "validate-later" placeholder with no tracked follow-up is a latent bug with a
self-justifying green test suite. Reviewers MUST reject it.

## Reviewer Checklist

When reviewing a PR that adds a guard/flag/branch that degrades behavior:

- [ ] Is there a backlog task or idea filed in this PR that tracks lifting it?
- [ ] Is that task/idea ID referenced in a comment next to the guard?
- [ ] Do the tests avoid asserting the degraded behavior as the desired contract?
- [ ] Is the degradation actually necessary, or can the correct behavior ship now?

## Preferred Alternative

Prefer shipping the correct behavior with a precise check over shipping a blanket
placeholder. If you cannot validate now, it is usually better to keep the
existing (working) behavior than to introduce a guard that makes it worse — a
placeholder that degrades behavior should be the rare exception, always tracked.
