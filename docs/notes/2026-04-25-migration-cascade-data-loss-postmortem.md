# Post-Mortem: Migration 0047 CASCADE Data Loss (2026-04-25)

## What Broke

All triggers, trigger executions, tasks, agent profiles, deployment credentials, project-scoped credentials, and project runtime config rows were deleted from the production D1 database. Data loss was total — every row in every table with an `ON DELETE CASCADE` foreign key referencing the `projects` table was wiped.

## User-Visible Impact

- All cron triggers across all projects disappeared
- All trigger execution history lost
- Tasks, agent profiles, deployment credentials, and project runtime configs potentially lost
- No error was surfaced — the data simply vanished silently

## Root Cause

Migration `0047_artifacts_repo_provider.sql` used the SQLite "table recreation" pattern to make the `installation_id` column nullable on the `projects` table:

```sql
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS projects_new (...);
INSERT OR IGNORE INTO projects_new SELECT ... FROM projects;
DROP TABLE IF EXISTS projects;
ALTER TABLE projects_new RENAME TO projects;
PRAGMA foreign_keys = ON;
```

The `projects` table is a parent table referenced by 7+ child tables via `ON DELETE CASCADE`:

- `triggers` (migration 0036)
- `tasks` (migration 0011)
- `agent_profiles` (migration 0028)
- `project_deployment_credentials` (migration 0031)
- `credentials` with project_id (migration 0042)
- `project_runtime_env_vars` (migration 0012)
- `project_runtime_files` (migration 0012)

The `DROP TABLE projects` statement triggered `ON DELETE CASCADE` on all child tables, deleting every row.

### Why PRAGMA foreign_keys = OFF Didn't Help

D1 (Cloudflare's distributed SQLite) may not honor `PRAGMA foreign_keys = OFF` across statement boundaries within a migration. SQLite PRAGMAs are connection-level settings, and D1's execution model may use separate connection contexts for each statement. Even in standard SQLite, `DROP TABLE` behavior with foreign keys is implementation-dependent and not guaranteed to respect the PRAGMA in all configurations.

### Why the Migration Was Unnecessary

The migration's purpose was to:
1. Make `installation_id` nullable (for artifacts-backed projects)
2. Add `repo_provider` and `artifacts_repo_id` columns

Goal #2 could have been achieved safely with `ALTER TABLE ADD COLUMN`:
```sql
ALTER TABLE projects ADD COLUMN repo_provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE projects ADD COLUMN artifacts_repo_id TEXT;
```

Goal #1 could have been handled with a sentinel value instead of making the column nullable.

## Timeline

- **~12:28 UTC**: PR #812 merged to main by the SAM GitHub App (agent-initiated)
- **~12:30 UTC**: Deploy Production workflow triggered automatically
- **~12:35 UTC**: Migration 0047 applied to production D1 — CASCADE deletes all child table data
- **Later**: User discovers all triggers are gone across all projects

## Why It Wasn't Caught

### 1. No CI check for destructive migrations

No automated check existed to detect `DROP TABLE` on a table with CASCADE children. The migration passed lint, typecheck, build, and all tests.

### 2. Miniflare tests don't exercise real D1 migration behavior

Tests run against Miniflare, which configures bindings directly — not through `wrangler d1 migrations apply`. Migration files are never executed during testing.

### 3. Agent rationalized a broken staging verification

The PR body explicitly states the feature errored on staging: _"returns clear error about missing binding (expected -- Wrangler v3 doesn't support `[[artifacts]]` binding type)"_. The agent rationalized this as "expected" and merged anyway. This is the exact anti-pattern Rule 30 was created to prevent — but Rule 30 was added *after* this PR was already merged.

### 4. Cloudflare specialist reviewer missed the cascade risk

The cloudflare-specialist reviewer addressed "migration safety" findings but did not detect that `DROP TABLE projects` would cascade to child tables. The review focused on the migration's internal logic (data copy, index recreation) without analyzing the impact on other tables.

### 5. No pre-deploy D1 backup

The deployment pipeline had no backup step before running migrations. Even if the cascade had been detected post-deploy, there was no way to recover the data.

## Class of Bug

**Destructive schema migration with unanalyzed foreign key side effects.**

This is a broader pattern than just D1 or SQLite: any schema migration that modifies or drops a parent table in a foreign key relationship can cascade to child tables. The specific D1 behavior (PRAGMA potentially not honored) makes it worse, but the fundamental mistake is dropping a parent table without analyzing the FK graph.

## Process Fixes (in this PR)

### 1. CI Migration Safety Check (automated, merge-blocking)

New script `scripts/quality/check-migration-safety.ts`:
- Parses all migration SQL files and builds a complete FK cascade map
- Blocks any `DROP TABLE`, `DELETE FROM` (without WHERE), or `TRUNCATE` on a CASCADE parent table
- Runs in CI as `pnpm quality:migration-safety` — fails the build if violated
- Allowlist for already-applied migrations (grandfathered, not extendable)

This is the primary prevention mechanism. It does not rely on agents following rules.

### 2. Pre-Deploy D1 Backup (automated, every deploy)

New step in `deploy-reusable.yml`:
- Creates a D1 backup of both databases before any migration runs
- Records a timestamp for D1 time-travel point-in-time recovery
- Non-blocking on backup failure (so deploys aren't stuck), but logs a warning

This is the last line of defense for data recovery.

### 3. Agent Rule: Migration Safety (`.claude/rules/31-migration-safety.md`)

- Documents the safe alternatives to table recreation
- Provides the FK cascade map check command
- Explains why `PRAGMA foreign_keys = OFF` is not sufficient in D1
- Covers ON DELETE behavior selection (RESTRICT vs SET NULL vs CASCADE)

This prevents agents from writing dangerous migrations in the first place.

### 4. Updated Quality Gates

- `pnpm quality:migration-safety` added to `package.json` scripts
- Added to CI workflow `code-quality` job
- Runs on every push and PR to main
