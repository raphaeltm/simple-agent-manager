# Wrangler JSON framing blocked exact-head staging

## Impact

Exact-head staging deployment run `31558884950` stopped before database migrations or application
deployment. No data was changed and production was untouched, but the durable-session PR could not be
validated at its final commit.

## Root cause

The D1 migration-safety runner invoked Wrangler with `--json` and passed the entire stdout string to
`JSON.parse`. Wrangler 4.118 emitted one valid multiline JSON document and then appended a diagnostic.
The parser consequently failed with `Unexpected non-whitespace character after JSON` even though the
D1 response itself was valid.

## Why tests missed it

Tests replaced the runner with already-parsed JavaScript values. They exercised table discovery,
counts, migration ordering, and failure behavior, but never exercised the process-output framing
boundary used in CI.

## Correction

The runner now extracts exactly one complete leading JSON object or array using a string- and
escape-aware scanner, then parses that frame. It remains fail-closed for leading garbage, malformed
nesting, and incomplete JSON. Regression tests cover trailing diagnostics, embedded brackets and
escaped quotes, leading garbage, and incomplete output.

## Process change

`.claude/rules/31-migration-safety.md` now requires framed parsing and an external-output fixture for
every deployment gate that consumes Wrangler JSON.
