# Making a Scoping Column Nullable Silently Deletes Every Check That Used It

## When This Applies

Any schema change that relaxes a column from `NOT NULL` to nullable, or widens a
`CHECK` constraint, where that column is **also used as a scoping predicate** —
`WHERE session_id = ?`, `WHERE project_id = ?`, `WHERE user_id = ?`,
`WHERE file_id = ?`. In this codebase that means D1 migrations, Durable Object
SQLite migrations, and the query helpers layered over them.

It applies with equal force when the motivation is benign: "this table now serves
a second kind of row, and the second kind has no session".

## Why This Rule Exists

Library file commenting (idea `01M0N1250YESBW2R497KXDZVSC`) needed comments
anchored to a file rather than a chat message. The plan reused the existing
`comment_threads` table and widened it: `anchor_kind` gained `'library_file'`,
and `session_id` / `message_id` became nullable because a file comment has
neither.

That is where the authorization check died. `getCommentThread(sql, sessionId,
threadId)` had scoped its lookup `WHERE id = ? AND session_id = ?`, and its
`UPDATE`s carried the same predicate. With `session_id` nullable, that signature
no longer type-checked for file threads — so the parameter was removed. The
resulting `getCommentThread(sql, threadId)` compiled cleanly, every existing test
passed, and **reply / resolve / reopen stopped enforcing session ownership**: any
project collaborator could mutate any other session's message threads by id.

Nothing was deleted. No type broke. No test went red. An `AND session_id = ?`
quietly became unnecessary and then absent.

The same widening had a second consequence: SQLite cannot `ALTER ... CHECK` or
drop a `NOT NULL`, so it forced a table recreation — a drop-and-restore on a
Durable Object, which has no time-travel recovery (rule 31).

## Class of Bug

**A schema relaxation that removes an authorization predicate as a side effect.**

The tells:

- A migration makes a column nullable _because a new row kind does not have it_.
- A shared function's scope parameter becomes optional (`sessionId?: string | null`)
  or disappears, and the diff reads as a type fix rather than a security change.
- A `WHERE` clause loses a conjunct, or an `UPDATE ... WHERE id = ?` no longer
  carries the tenant/scope column.
- The new row kind and the old one now share a table, an index, and a getter.

It is the schema-level sibling of rule 51 (never trust a client-supplied
identifier): here the server stops _having_ the identifier to check against.

## Hard Requirements

1. **Prefer a separate table over a nullable scoping column.** When a new row
   kind does not have the column that scopes the existing kind, that is strong
   evidence the two are different entities. Separate tables keep every existing
   predicate intact by construction, keep the migration additive, and let each
   kind carry its own non-null scope. Unify the kinds at the **type** layer
   (a discriminated union) rather than in storage.

2. **If you widen anyway, enumerate every query that reads the column** —
   `WHERE`, `UPDATE`, `DELETE`, unique indexes and constraints — and state, per
   query, whether it is an authorization predicate. List them in the PR. This is
   the schema analogue of rule 44's "enumerate every writer".

3. **A scope parameter may never be deleted in the same change that makes its
   column nullable.** If a signature must change, the new kind gets its own
   entry point with its own non-null scope (`getFileCommentThread(sql, fileId,
threadId)`). Do not make the shared one accept `null`.

4. **Every entry point keeps a non-null scope in its predicate.** Whatever scopes
   a row — `session_id`, `file_id`, `project_id` — belongs in the `WHERE` of every
   read and every mutate for that row, not just the read.

## Required Tests

- **Cross-scope attack, per mutating entry point.** A real id from scope A,
  addressed through scope B. Assert rejection AND that nothing mutated (version
  unchanged, no rows written).
- **An owner-path control beside every attack case** (rule 28). "Nothing was torn
  down" is also satisfied by the endpoint being broken outright.
- **Proven discriminating.** Delete the scope conjunct from the predicate;
  exactly the attack tests must go red while the owner controls stay green.
  Verify this once, then restore.
- **A separation assertion** when the fix is separate tables: each getter must
  return `null` for the other kind's id, and the row counts must confirm the two
  live in physically distinct tables.
- **At production RPC fidelity.** If the guard sits behind a Durable Object hop,
  the test's error path must reproduce what actually crosses it — a plain `Error`
  with only `name` and `message`. An `instanceof`- or `code`-based mapping passes
  a richer simulation and 500s in production.

## Quick Compliance Check

Before merging a migration that relaxes a constraint:

- [ ] The new row kind genuinely belongs in this table, and separate tables were
      considered and rejected in writing
- [ ] Every query reading the relaxed column is enumerated in the PR, each marked
      authorization-predicate or not
- [ ] No scope parameter was removed or made optional in this change
- [ ] Every read and mutate still carries a non-null scope predicate
- [ ] Cross-scope attack tests exist per entry point, each with an owner control
- [ ] The pair was verified discriminating by deleting the predicate

## References

- Task: `tasks/active/2026-08-22-library-file-commenting.md` (moves to
  `tasks/archive/` on completion)
- Implementation: `apps/api/src/durable-objects/project-data/library-file-comments.ts`,
  DO migration `033-library-file-comment-threads`
- `.claude/rules/31-migration-safety.md` — why the recreation this forced is unrecoverable on a DO
- `.claude/rules/51-server-side-node-class-gates.md` — the server must decide from values it verified
- `.claude/rules/28-credential-resolution-fallback-tests.md` — SQL-predicate guards need a real SQL engine, and every attack case needs an owner control
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every path before a storage change
