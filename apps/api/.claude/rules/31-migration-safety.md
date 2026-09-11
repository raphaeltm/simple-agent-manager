# Migration Safety (ABSOLUTE RULE — DATA LOSS PREVENTION)

## This Rule Exists Because of a Production Data Loss Incident

On 2026-04-25, migration 0047 dropped and recreated the `projects` table to make a column nullable. The `triggers`, `tasks`, `agent_profiles`, `deployment_credentials`, and other tables had `ON DELETE CASCADE` referencing `projects`. The DROP TABLE cascaded and wiped all data from every child table in production. See the retained incident lesson in this rule.

## Hard Rule: NEVER DROP TABLE on a FK Parent

**You MUST NEVER write a migration that uses `DROP TABLE` on any table that is referenced by another table's foreign key.** This applies even if:

- You set `PRAGMA foreign_keys = OFF` first (D1 may not honor this across statement boundaries)
- You plan to recreate the table immediately after
- The "standard SQLite table recreation pattern" says to do it this way
- You believe the data will be preserved because you're copying it first

The data in the **child** tables is what gets destroyed — not the parent table's data. The parent data survives (you copy it). The children are wiped by CASCADE.

## CI Enforcement

The `pnpm quality:migration-safety` check runs in CI and blocks merge on any migration that:

1. Uses `DROP TABLE` on a table that is a CASCADE parent
2. Uses `DELETE FROM` without `WHERE` on a CASCADE parent
3. Uses `TRUNCATE` on a CASCADE parent

This check cannot be bypassed. Do not add new migrations to the allowlist.

## Safe Alternatives for Schema Changes

### Adding a Column (Most Common Case)

```sql
-- SAFE: ALTER TABLE ADD COLUMN works in SQLite for new nullable columns
ALTER TABLE projects ADD COLUMN repo_provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE projects ADD COLUMN artifacts_repo_id TEXT;
```

This is what migration 0047 should have done. SQLite supports `ALTER TABLE ADD COLUMN` for adding new columns with defaults. No table recreation needed.

### Making a Column Nullable (The Hard Case)

SQLite does not support `ALTER COLUMN` to remove a NOT NULL constraint. The standard recommendation is table recreation. **That recommendation assumes no foreign key children exist.**

If the table HAS FK children, you have three options:

**Option A: Don't make it nullable.** Use a sentinel value instead.

```sql
-- Instead of making installation_id nullable, use a sentinel
INSERT OR IGNORE INTO github_installations (id, ...) VALUES ('NONE', ...);
-- Now artifacts projects can reference 'NONE' instead of NULL
```

**Option B: Add a new nullable column and deprecate the old one.**

```sql
ALTER TABLE projects ADD COLUMN installation_id_v2 TEXT;
-- Backfill: UPDATE projects SET installation_id_v2 = installation_id;
-- Then update code to read from installation_id_v2
-- The old NOT NULL column stays but is no longer authoritative
```

**Option C: Table recreation with explicit child table handling.**
If you absolutely must recreate the table, you must also recreate every child table that references it, preserving their data. This is complex and error-prone — prefer Options A or B.

```sql
PRAGMA foreign_keys = OFF;

-- 1. Recreate parent
CREATE TABLE projects_new (...);
INSERT INTO projects_new SELECT ... FROM projects;

-- 2. For EACH child table with ON DELETE CASCADE:
CREATE TABLE triggers_new AS SELECT * FROM triggers;
CREATE TABLE tasks_new AS SELECT * FROM tasks;
-- ... every child table

-- 3. Drop parent (children are now orphaned but we have copies)
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

-- 4. Drop and recreate each child table
DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
-- ... every child table

-- 5. Recreate all indexes on all affected tables

PRAGMA foreign_keys = ON;
```

**This is why Option A or B are strongly preferred.** Option C requires touching every child table perfectly.

## Before Writing Any Migration

1. **Check the CASCADE map.** Run `pnpm quality:migration-safety` locally. It prints the full FK cascade tree at the top of its output.
2. **If your target table appears as a parent**, do NOT use DROP TABLE. Use ALTER TABLE ADD COLUMN or one of the safe alternatives above.
3. **If you're unsure**, ask. The cost of asking is zero. The cost of a wrong migration in production is catastrophic and irreversible.

### Persisted Enum and State-Machine Changes

When application code adds a new persisted enum/state value, updating a TypeScript union or
Drizzle enum is not enough. Before merge, you MUST:

1. Inspect the already-applied `CREATE TABLE` migration for `CHECK` constraints and defaults.
2. Add an additive migration for the new canonical representation when the existing constraint
   cannot be changed safely. Never recreate an FK parent just to widen a `CHECK` constraint.
3. Add a behavioral test that applies the relevant real migration chain, writes every new state,
   and reads it back through the canonical column.
4. For a long-running state machine, add a barrier-controlled test where terminal mutation lands
   while external work is suspended. The late completion must lose through a compare-and-set
   predicate and must not create orphan result/event rows.

This checklist exists because the durable diagnosis runner added `cancelled` in application types
without widening the shipped D1 `CHECK`, and used unconditional terminal writes that could overwrite
cancellation after an awaited model/tool call.

## The CASCADE Map Changes Over Time

A table that has no children today may have children tomorrow. When adding a new `ON DELETE CASCADE` foreign key, you are also making the parent table more dangerous to recreate in the future. Consider whether `ON DELETE SET NULL` or `ON DELETE RESTRICT` would be more appropriate.

### Choosing ON DELETE Behavior

| Behavior             | When to use                                            | Risk level                                      |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `ON DELETE RESTRICT` | Child rows should prevent parent deletion              | Safest — forces explicit cleanup                |
| `ON DELETE SET NULL` | Child rows should survive parent deletion with null FK | Safe — no data loss                             |
| `ON DELETE CASCADE`  | Child rows are meaningless without parent              | Dangerous — amplifies any parent table accident |

Prefer `RESTRICT` or `SET NULL` unless the child data is truly worthless without the parent.

## Pre-Deploy Backup

The deployment pipeline creates a D1 backup before every migration run. If a migration causes data loss despite this rule, the backup enables point-in-time recovery. This is the last line of defense — it should never be needed if this rule is followed.

## Wrangler JSON Is a Framed Output Contract

Wrangler may append human-readable diagnostics after a valid `--json` document. Deployment safety
code MUST parse exactly one complete leading JSON object or array, with string/escape-aware framing,
and MUST continue to reject leading garbage, incomplete JSON, or structurally invalid JSON. Do not
call `JSON.parse` on the entire stdout buffer and do not recover by searching for an arbitrary `[` or
`{` later in the output. Add a regression fixture with valid multiline JSON plus trailing diagnostics
whenever a deployment gate consumes Wrangler JSON.

This rule was added after exact-head staging deployment `31558884950` was blocked before migrations:
Wrangler 4.118 emitted a valid JSON response followed by a diagnostic, while the safety runner treated
the whole stdout stream as one JSON value.
