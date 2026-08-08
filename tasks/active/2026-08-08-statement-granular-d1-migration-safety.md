# Parse D1 migration safety at statement granularity

## Problem

The D1 migration safety guard scans one physical line at a time. A destructive SQL statement whose keywords are separated by a newline, such as `DROP\nTABLE projects;`, is valid SQL but is accepted by the guard. This is R10-008 (HIGH): a migration can bypass the pre-apply data-loss protection without changing the destructive operation itself.

This remediation must preserve public/API/CLI/data behavior, the historical migration allowlist, the post-apply row-count checks, and both clean-install and upgrade migration paths. It must not absorb unrelated D1 findings or add a migration.

## Research findings

- `scripts/quality/check-migration-safety.ts` splits each migration into lines and applies every destructive-operation regex to a single line. The exact current-main script at `8eed3b740` accepted an isolated `9999_multiline_bypass.sql` containing `DROP\nTABLE projects;` with exit status 0 and “0 violations.”
- `scripts/quality/check-migration-safety.test.ts` duplicates simplified regex logic inside generated wrapper scripts instead of executing the production checker against fixture directories. Those tests can stay green while the real checker is bypassed.
- SQL comments and quoted strings/identifiers can contain whitespace, semicolons, and destructive-looking words. The parser must remove comments, retain quoted identifiers as identifiers, ignore string-literal contents, and preserve token source lines for diagnostics.
- The same token stream must drive foreign-key extraction and violation scanning; otherwise multiline/quoted FK definitions can create an incomplete CASCADE map and leave a second bypass.
- Trigger bodies contain semicolon-delimited SQL statements. Tokenization must not confuse semicolons in strings/comments with statement boundaries, and safe trigger statements with scoped `WHERE` clauses must remain allowed.
- Historical allowlist keys are `filename:line`. Destructive-operation tokens must retain their original start line so the three already-applied allowlist entries continue to match exactly.
- The checker currently scans the primary migration directory plus its observability subdirectory. A fixture-directory CLI input is an additive test seam that lets scenario tests invoke the actual checker without modifying repository migrations.
- `.github/workflows/ci.yml` already runs `pnpm quality:migration-safety`, `pnpm quality:migration-ordering`, and the complete quality-script Vitest suite. No workflow behavior change is expected unless test discovery proves otherwise.
- Cloudflare D1 records applied filenames in `d1_migrations`, applies outstanding files sequentially, rolls back a migration that errors, and supports local application through Wrangler. Validation must exercise both an empty database and a persisted database with prior migrations applied.
- `.claude/rules/31-migration-safety.md` preserves additive migrations and the existing post-apply guard in `scripts/deploy/d1-migration-safety.ts`; this task changes only the pre-apply source parser.

## Implementation checklist

- [x] Add a fail-closed SQL tokenizer that spans lines, skips line/block comments, distinguishes string literals from quoted identifiers, preserves semicolon statement boundaries, and reports unterminated lexical constructs with file/line context.
- [x] Use tokenized statements for FK/CASCADE extraction, including multiline and quoted identifiers.
- [x] Apply the existing DROP, unscoped DELETE/UPDATE, TRUNCATE, and `PRAGMA foreign_keys = OFF` rules to complete tokenized statements while preserving temporary-table and historical allowlist behavior.
- [x] Add an optional migration-directory CLI seam and replace duplicated-regex tests with production-checker scenarios plus a CLI diagnostic capability test.
- [x] Cover the known multiline bypass, multiline DROP/ALTER/rename forms, comments between tokens, strings, quoted identifiers, triggers, safe SQL, malformed SQL diagnostics, historical clean-install corpus, and upgrade-style fixture corpus.
- [x] Prove current migration ordering, clean D1 application, upgrade D1 application, and post-apply safety checks remain successful.
- [ ] Run all requested local reviewers and address every correctness/security/test-quality finding.
- [ ] Rebase conservatively on current `origin/main`, open one focused PR, and wait for every applicable GitHub check.
- [ ] Preserve the user release contract: no shared-staging deployment and no merge.

## Acceptance criteria

- The exact `DROP\nTABLE projects;` bypass fails the production checker with an actionable `file:line`, destructive pattern, target table, and safe alternative.
- Equivalent destructive statements remain blocked across whitespace, comments, CRLF, and supported SQLite quoted-identifier forms.
- Destructive-looking text inside comments and strings is not flagged; safe additive migrations and scoped trigger body statements pass.
- Multiline/quoted FK definitions populate the CASCADE map so destructive operations against their parents are blocked.
- Historical allowlisted migrations and the complete checked-in primary/observability migration corpus pass unchanged.
- Clean-install and persisted-upgrade D1 migration application succeeds, and the existing post-apply integrity suite remains green.
- Migration ordering, lint, typecheck, tests, coverage, build, and all applicable GitHub checks are green.
- Review evidence includes cloudflare-specialist, constitution-validator, test-engineer/test-quality critic, task-completion-validator, and an independent defensive bypass review.
- The PR remains open and unmerged, with staging explicitly skipped only because the user prohibited it for this integration packet.

## References

- Finding R10-008 / WP-104
- `scripts/quality/check-migration-safety.ts`
- `scripts/quality/check-migration-safety.test.ts`
- `scripts/deploy/d1-migration-safety.ts`
- `.github/workflows/ci.yml`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- Cloudflare D1 migration and Wrangler command documentation

## Implementation notes

- The first test-first run failed 23/23 scenarios against the old implementation. In particular, the production CLI fixture expected exit 1 for `DROP\nTABLE parent_table;` but received exit 0.
- `scripts/quality/sql-migration-parser.ts` now retains token line/column data, keeps trigger programs intact across body semicolons/`CASE ... END`, and rejects unterminated comments/quotes.
- `scripts/quality/check-migration-safety.ts` loads each migration once, shares the parsed statements between FK extraction and destructive scanning, normalizes SQLite identifiers case-insensitively, and checks trigger body DML as independent logical statements.
- The current parser reports 140 FK relationships instead of the old regex's 145 because the old extractor double-counted all five table-level `FOREIGN KEY` declarations (its inline and table-level regexes both matched them). The resulting CASCADE parent/child map is preserved.
- Focused suite: 26/26 passed. Complete `pnpm quality:scripts:test`: 225/225 passed. `quality:migration-safety`, `quality:migration-ordering`, TypeScript deploy-script checking, formatting, and file-size checks passed.
- First formal defensive review found SQLite-valid single-quoted table identifiers, qualified/parenthesized `PRAGMA foreign_keys` forms, numeric-zero PRAGMA variants, and qualified trigger identifiers that needed more contextual handling. Regression tests were added before fixes; the focused suite now passes 44/44 scenarios.
- Real Wrangler 4.118.0 clean install applied all 121 primary and 2 observability migrations to fresh local D1 stores; both ledgers matched and both `PRAGMA foreign_key_check` results were empty.
- Real persisted upgrade applied the checked-in chain through 0047, seeded a `users` parent plus `credentials` child, applied the remaining history through 0108, and preserved both rows (`user_rows=1`, `credential_rows=1`) with 121 ledger entries and an empty `foreign_key_check`. A second apply completed with no pending migrations.
