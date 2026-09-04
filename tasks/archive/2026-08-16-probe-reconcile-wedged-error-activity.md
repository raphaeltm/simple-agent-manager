# Extend probe reconciliation to sessions wedged in `activity='error'`

**Parent:** SAM idea `01M0644866Q0000M4HP39WNCZW`; completed as review remediation
in PR #2015.

## Problem

`WORKING_ACTIVITIES` deliberately excludes `error`, so the original
SessionHost-backed reconciler selected only stale `prompting` and `recovering`
rows. A partially applied error callback could therefore leave
`session_state.activity='error'` suppressing delivery and idle scheduling
forever.

## Resolution

- [x] Treat `error` as probe-reconcilable without treating it as positive
      working evidence elsewhere in task-runtime classification.
- [x] A fresh error is untouched; stale errors are selected only after the
      configured activity threshold.
- [x] Exact, well-formed SessionHost `working` evidence refreshes the row.
- [x] Exact, well-formed SessionHost `not_working` evidence returns the activity
      gate to `idle` through the canonical fenced transition while preserving
      `status_error` for display.
- [x] Timeout, error, malformed, missing, or ambiguous inventory preserves the
      error state and follows the existing bounded quarantine path.
- [x] Regression tests discriminate stale/fresh, working/not-working, and
      unreachable outcomes; canonical publication continues to nudge delivery
      and re-arm idle scheduling exactly once after a real transition.
