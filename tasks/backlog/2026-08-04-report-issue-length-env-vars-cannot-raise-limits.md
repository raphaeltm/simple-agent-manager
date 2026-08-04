# Report Issue length env vars cannot raise the limits they document

## Problem

`REPORT_ISSUE_TITLE_MAX_LENGTH` (default 200) and `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH`
(default 5000) are declared as operator-configurable limits in `apps/api/src/env.ts:851-852`
and read in `apps/api/src/services/report-issue.ts:215-221`. But they are applied only
**after** request validation, as a `.slice()` on already-validated input.

Validation itself uses the shared constants, not the env vars:

- `apps/api/src/schemas/report.ts:16-17` — `v.maxLength(DEFAULT_REPORT_ISSUE_TITLE_MAX_LENGTH)`
  and `v.maxLength(DEFAULT_REPORT_ISSUE_DESCRIPTION_MAX_LENGTH)`
- `apps/web/src/components/ReportIssueDialog.tsx:128,140` — `maxLength={DEFAULT_...}`

So setting `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH=20000` still rejects a 5,001-character
description with a `400`. The variables can only ever **lower** the stored length; raising
them has no effect an operator can observe.

## Context

Found on 2026-08-04 while documenting the Report an Issue flow
(`apps/www/src/content/docs/docs/guides/reporting-issues.md`). The docs currently describe
the actual behavior ("truncation ceiling — lowers only") with a caution callout, so users
are not misled, but the config surface is still misleading on its own terms.

The same asymmetry does **not** affect `REPORT_ISSUE_CONTENT_MAX_LENGTH`, which bounds the
stored Idea body and has no schema counterpart.

## Options

1. **Make the vars authoritative** — resolve the limits from env before validation and pass
   them into the schema (valibot schemas would need to be constructed per-request, or the
   check moved into the handler). The dialog would need the effective limits from
   `GET /api/report-issue/config`.
2. **Remove the vars** and keep only the shared constants, so there is one source of truth.
3. **Rename them** to reflect what they actually do (e.g. `REPORT_ISSUE_TITLE_STORED_MAX_LENGTH`).

Option 1 matches operator expectations; option 2 is the smallest change. Either way the
docs caution in `reporting-issues.md` and `reference/configuration.md` must be updated to
match.

## Acceptance Criteria

- [ ] A single, documented source of truth decides the max title/description length
- [ ] Behavioral test: with `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH` set **above** the default,
      a description longer than the default either succeeds (option 1) or the variable no
      longer exists (option 2) — no silent no-op
- [ ] Behavioral test: with the variable set **below** the default, the boundary behaves as
      documented
- [ ] The report dialog's client-side `maxLength` agrees with what the server accepts
- [ ] `reporting-issues.md` and `reference/configuration.md` updated to match the new behavior
      (the current caution callouts removed or rewritten)
