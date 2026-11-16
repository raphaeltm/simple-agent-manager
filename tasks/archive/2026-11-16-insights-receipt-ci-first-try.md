# Run receipt: CI first try from the opening commit

Follow-up of Insights slice F (task 01M7HVVXN621MQR9XDVT2Z1GPD, idea 01M7HTS38KX2G78JD0ESAGMKKH,
PR #2789). The slice F brief: "After merge, wire first-try into runReceipt if slice R has merged."
Slice R (#2786) merged before #2789.

## Problem

`runReceipt` (slice R) returned `outcome.ciFirstTry: 'not_recorded'` for every run, because SAM did
not record which commit a pull request opened with. Slice F added `pull_request_heads.from_open` and
`pull_request_checks.first_failed_at`, and Insights · Flow already reads first try from them.

## Checklist

- [x] Extract the first-try rule from `ciFirstTryStatement` into shared SQL (`firstTryVerdictSql`,
      `FIRST_TRY_*_SQL` in `packages/operations/src/insights-flow-sql.ts`); Flow uses it unchanged.
- [x] Receipt `PULL_REQUEST_SQL` reads the verdict for the run's pull request in the same statement
      (no new round trip); every predicate project-scoped.
- [x] `RunReceiptCiFirstTry = 'passed' | 'failed' | 'pending' | 'not_recorded'` in shared types.
- [x] Receipt outcome line says "first push passed" / "first push failed"; nothing for pending or
      not recorded.
- [x] Tests on real SQLite: passed, failed after a green rerun, pending (running / no checks),
      moved on, not recorded, foreign head and foreign check attacks with owner controls (each
      project predicate removed once: exactly its attack test went red).
- [x] Web unit test for the outcome line; Playwright receipt audit at 375 and 1280 with the verdict.
- [x] Docs: `guides/chat-features.md` (Run Receipt), `reference/api.md` (receipt `ciFirstTry`).

## Acceptance

- A run whose pull request SAM saw opened shows the verdict of its opening commit in the receipt
  (API and UI); a run without one reads `not_recorded` as before.
