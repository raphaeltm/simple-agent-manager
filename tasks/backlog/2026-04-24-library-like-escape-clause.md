# Fix LIKE ESCAPE clause in library search queries

> **Reconciliation 2026-09-30:** still open, and more serious than worded. Without an `ESCAPE`
> clause SQLite treats `\` as a literal, so library searches for names containing `_` or `%` find
> nothing. Affected: `apps/api/src/services/file-library.ts:446,464,469,554,566,570` and
> `file-library-directories.ts:155`. Working pattern:
> `apps/api/src/durable-objects/sam-session/tools/search-tasks.ts:104`.

## Problem

The file library's search queries use Drizzle ORM's `like()` function with manually escaped `%` and `_` characters (backslash-escaping), but Drizzle's `like()` does not emit an `ESCAPE` clause in the SQL. This means the backslash escaping is ineffective — a search for `%` or `_` would match as SQL wildcards.

## Context

Discovered during security audit of the library search performance PR. This is a **pre-existing pattern** that exists in both:
- `apps/api/src/services/file-library.ts` (filename search via `like()`)
- `apps/api/src/services/file-library-directories.ts` (directory path query via `like()`)

The directory path case is not exploitable today because upstream `validateDirectory` allowlists characters. The filename search case is potentially exploitable — a user could craft a search containing `%` or `_` to match unintended patterns.

## Acceptance Criteria

- [ ] All `like()` calls that use manually-escaped patterns include a proper `ESCAPE` clause via Drizzle's `sql` template
- [ ] Unit test verifying that `%` and `_` in search input are treated as literal characters, not SQL wildcards
- [ ] Verify this works correctly on D1/SQLite (which uses backslash escape by default only when `ESCAPE` is specified)
