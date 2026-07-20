# List/Snapshot Reads Must Tolerate a Single Malformed Row

## When This Applies

This rule applies to any function that reads **multiple** rows from D1 or a
Durable Object's embedded SQLite and maps each row through a **throwing** schema
parser (valibot `parseRow`, `parseX`, a `JSON.parse`, a `z.parse`, etc.) before
returning them. The canonical shape is:

```ts
const rows = sql.exec('SELECT ... FROM some_table ...').toArray();
return rows.map((row) => parseSomeRow(row)); // <-- one bad row throws the whole read
```

It is the list/collection analogue of
`.claude/rules/41-credential-snapshot-resilience.md` (which covers credential
snapshots): rule 41 is about credential rows specifically; this rule is about
**any** multi-row list/snapshot read.

## Why This Rule Exists

`ProjectData.listSessions` mapped every `chat_sessions` row through
`parseChatSessionListRow` → `parseRow` (which throws) with no per-row try/catch.
A single legacy row that violated the current valibot schema (e.g. a NULL in a
field typed `v.number()`) threw the entire Durable Object RPC, so
`GET /api/projects/:id/sessions` returned `INTERNAL_ERROR`. Because the query is
`ORDER BY updated_at DESC LIMIT 100` and the project was write-hot, the bad row
drifted in and out of the top-100 window, producing an **intermittent**,
**project-specific** 500 that made the project chat unusable. See
`tasks/active/2026-07-16-fix-sessions-list-internal-error-large-projects.md`.

## Class of Bug

**A multi-row list/snapshot read where one malformed row throws the whole
read.** The schema tightens over time while legacy rows persist; small datasets
rarely surface a bad row, so it only manifests at scale — exactly when the
failure is most damaging. A `.map(parseRow)` with no per-row isolation is the
tell.

## Hard Requirements

1. **Isolate the per-row parse.** When mapping multiple rows through a throwing
   parser, wrap each row's parse (and any per-row enrichment) in its own
   try/catch. On failure, **skip the row and emit a structured warn log** that
   includes a best-effort row identifier and the error — never let one row throw
   the whole read. A single bad row must degrade to "that row is missing from
   this response", not a 500.

2. **The skip must be diagnosable.** The log MUST carry enough context (row id,
   table/context name, the parser error message) to identify the offending
   field in production without re-triggering the throw. "Skipped silently" is
   not acceptable — the whole point is to surface the bad row so it can be fixed.

3. **Bound the serialized result only when per-row payloads can be large.** A
   Durable Object RPC has a hard 32 MiB serialization ceiling. If a read can
   return large per-row payloads (e.g. message content/tool metadata), apply an
   env-configurable size budget with a `Default*` constant and return a
   `hasMore`/continuation signal rather than risking overflow — but ONLY with a
   pagination model that can actually resume the trimmed tail. Cursor pagination
   (`messages.ts`, keyed by `before: timestamp`) resumes cleanly; **offset
   pagination cannot** re-fetch a mid-page truncation, so do NOT bolt a
   truncating byte-budget onto an offset-paginated read — bound the row size on
   the write path instead. For small, fixed-shape rows (session summaries), a
   per-page `LIMIT` is sufficient; a byte budget adds silent-data-loss edge
   cases for no real benefit.

4. **Single-row getters** need not skip-and-continue (there is nothing to fall
   back to), but a malformed row must NOT surface as an opaque 500. Prefer
   degrading to `null` (so the caller returns a clean 404) with a structured
   skip log naming the offending field, over a bare throw that `app.onError`
   downgrades to `INTERNAL_ERROR`. The canonical example is
   `sessions.ts:getSession` → `sessions.get_row_skipped`.

## Required Tests

Any change that adds or modifies a multi-row list/snapshot read MUST include a
regression test that:

- Seeds a good/bad/good row set (the bad row failing the schema) and asserts the
  read returns the good rows and does NOT throw.
- Asserts the all-bad case returns an empty (non-throwing) result.
- Is proven discriminating: it MUST fail on the pre-fix (`rows.map(parseRow)`
  without isolation) code. Verify this once before relying on it.

## Quick Compliance Check

Before merging a change to any D1/DO-SQLite multi-row read:
- [ ] Each row's parse/enrichment is isolated; a bad row is skipped + warn-logged
      (list reads) or degraded to `null` + warn-logged (single-row getters)
- [ ] The skip log carries a row id + context + parser error (diagnosable)
- [ ] If per-row payloads can be large AND pagination is cursor-based, a size
      budget + `hasMore` guards the 32 MiB DO-RPC ceiling (never bolt a
      truncating budget onto an offset-paginated read)
- [ ] A discriminating regression test (good/bad/good) exists and fails pre-fix

## Known Follow-Up

The identical unguarded `rows.map(parseRow)` pattern exists in other
`apps/api/src/durable-objects/project-data/` modules (messages, activity,
attention, ideas, knowledge, mailbox, policies, materialization, idle-cleanup).
Hardening those is tracked in
`tasks/backlog/2026-07-16-project-data-row-fault-isolation-audit.md`.

## References

- Post-mortem/task: `tasks/active/2026-07-16-fix-sessions-list-internal-error-large-projects.md`
- `.claude/rules/41-credential-snapshot-resilience.md` — the credential-snapshot analogue
- `.claude/rules/11-fail-fast-patterns.md` — structured logging at boundaries
- `.claude/rules/02-quality-gates.md` — regression + process-fix requirements
