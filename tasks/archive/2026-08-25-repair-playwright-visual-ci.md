# Repair Playwright visual CI job

## Problem

The `Playwright Visual Tests` CI job currently runs the visual audit corpus on UI PRs, but it is not a real gate:

- it runs every non-staging `*audit*.spec.ts` file;
- many audit specs are stale and time out on current `main`;
- the job is marked `continue-on-error`;
- the follow-up failure step only emits a warning.

The result is bad in both directions: UI PRs pay roughly 34 minutes of wall-clock time, but the job still concludes success and does not protect the merge.

## Research findings

- The August CI/CD performance analysis is stored as SAM idea `01M0QED2G61RWM8Z3TPFCHEQXS`.
- That analysis found the Playwright job spent roughly 93% of worker time in timeouts and still returned success.
- It recommended quarantining the stale/red visual audit specs and making the remaining healthy suite blocking.
- The workflow is currently path-gated to PRs touching `web-ui`, which is correct and should be preserved.
- Existing quality tests in `scripts/quality/` parse `.github/workflows/ci.yml` and are the right place to add regression coverage for workflow wiring.
- Older backlog `tasks/backlog/2026-07-17-stale-playwright-audit-specs.md` documents examples of stale audit specs, but the CI repair should not wait for every stale spec to be fixed.

## Implementation checklist

- [x] Add an explicit quarantine file for stale Playwright audit specs.
- [x] Add a deterministic Playwright audit selector script that:
  - includes non-staging `*audit*.spec.ts` files;
  - excludes quarantined specs;
  - fails closed if the quarantine references missing files, non-audit files, or staging specs;
  - prints newline-delimited spec paths suitable for `xargs`.
- [x] Update `.github/workflows/ci.yml` so `playwright-visual`:
  - keeps PR + `web-ui` path gating;
  - runs only selected, non-quarantined audit specs;
  - removes `continue-on-error`;
  - removes the warning-only fake failure step;
  - uploads screenshots on normal failure.
- [x] Add quality tests covering the selector and workflow wiring.
- [x] Run targeted validation, then the repository quality suite in proportion to risk.
- [x] Archive this task after validation.

## Acceptance criteria

- [x] CI no longer contains a warn-only Playwright visual gate.
- [x] The healthy Playwright visual audit subset is blocking.
- [x] Quarantined specs are explicit, reviewable, and have a tracked follow-up.
- [x] Workflow regression tests fail if someone reintroduces `continue-on-error` or bypasses the selector.
- [x] The implementation preserves the existing PR + `web-ui` path gate.
