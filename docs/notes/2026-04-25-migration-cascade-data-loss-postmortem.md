# Post-Mortem: Migration 0047 Destroyed Production Data (2026-04-25)

## Severity: CATASTROPHIC — Total Data Loss Across All Projects

This is the worst incident in SAM's history. An AI agent wrote a migration that nuked production data across every project in the platform, merged it despite the feature being visibly broken on staging, and every layer of review — including five specialist reviewers — missed it completely.

## What Was Destroyed

Migration 0047 triggered `ON DELETE CASCADE` on the `projects` table, which wiped **every row** in every child table:

| Table | What was lost |
|-------|--------------|
| `triggers` | Every cron trigger across all projects — carefully configured automation, gone |
| `trigger_executions` | Complete execution history and audit trail |
| `tasks` | Every idea, every task, every piece of work tracked through the platform — hundreds of items representing thousands of dollars of agent compute |
| `agent_profiles` | All custom agent configurations |
| `project_deployment_credentials` | All project deployment credentials |
| `credentials` (project-scoped) | All per-project credential overrides |
| `project_runtime_env_vars` | All project environment variable configs |
| `project_runtime_files` | All project runtime file configs |

The `projects` table itself survived (the migration copies it before dropping). The children did not. The data vanished silently — no error, no warning, no alert. The user discovered it hours later when their triggers stopped firing.

## Root Cause

Migration `0047_artifacts_repo_provider.sql` used the SQLite "table recreation" pattern:

```sql
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS projects_new (...);
INSERT OR IGNORE INTO projects_new SELECT ... FROM projects;
DROP TABLE IF EXISTS projects;          -- THIS LINE DESTROYED EVERYTHING
ALTER TABLE projects_new RENAME TO projects;
PRAGMA foreign_keys = ON;
```

The agent used this pattern to make `installation_id` nullable — a change that **did not require table recreation at all**. Two simple `ALTER TABLE ADD COLUMN` statements would have done the job:

```sql
ALTER TABLE projects ADD COLUMN repo_provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE projects ADD COLUMN artifacts_repo_id TEXT;
```

The agent chose the most dangerous possible approach for a problem that had a trivial safe solution.

## The Cascade of Failures

This wasn't one mistake. It was a chain of failures where every safeguard failed simultaneously.

### Failure 1: The agent wrote a destructive migration without understanding the FK graph

The agent never checked what other tables reference `projects`. A single `grep` for `REFERENCES projects` would have revealed 7+ child tables with `ON DELETE CASCADE`. The agent didn't look.

### Failure 2: The agent chose table recreation when it wasn't needed

SQLite's `ALTER TABLE ADD COLUMN` handles adding new columns. The only reason for table recreation was making `installation_id` nullable — which could have been solved with a sentinel value. The agent reached for the most complex, most dangerous tool in the box for a problem that didn't require it.

### Failure 3: Five specialist reviewers missed it

The PR went through **five** specialist review agents:

- `task-completion-validator` — didn't check migration safety
- `go-specialist` — not relevant, but also didn't flag it
- `cloudflare-specialist` — **explicitly addressed "migration safety" findings** and still missed the CASCADE. Focused on the migration's internal logic without ever asking: "what other tables reference this one?"
- `ui-ux-specialist` — not relevant
- `security-auditor` — reviewed auth and credential safety but not data integrity

The cloudflare-specialist failure is the most damning. "Migration safety" was literally in their review findings, and they still didn't catch a `DROP TABLE` on the most-referenced table in the entire schema.

### Failure 4: The agent merged a known-broken feature

The PR's own staging verification section says:

> _"form submits with artifacts provider and returns clear error about missing binding (expected -- Wrangler v3 doesn't support `[[artifacts]]` binding type)"_

The agent watched the feature **error on staging**, wrote "expected" next to it, and merged anyway. The feature was broken. The agent shipped it. This is the exact scenario that Rule 30 ("Never Ship Broken Features") was written to prevent — except Rule 30 was added to the codebase in a commit *after* this PR was already merged, in response to this very incident's precursor.

### Failure 5: No automated check existed for destructive migrations

No CI check scanned migration files for `DROP TABLE` on FK parent tables. The migration passed lint, typecheck, build, and 2,700+ tests — none of which execute migration SQL against a database with realistic FK relationships.

### Failure 6: No pre-deploy database backup

The deployment pipeline ran migrations directly against production D1 with no backup, no snapshot, no time-travel bookmark recorded beforehand. If D1's 30-day time-travel window didn't exist, this data would be permanently gone.

### Failure 7: The PRAGMA was a false safety net

The migration set `PRAGMA foreign_keys = OFF` before the `DROP TABLE`, which in standard SQLite would prevent cascade behavior. But:

1. D1's execution model may not honor connection-level PRAGMAs across statement boundaries
2. Even in standard SQLite, `DROP TABLE` behavior with foreign keys is not consistently guaranteed across all implementations
3. The agent treated `PRAGMA foreign_keys = OFF` as a safety guarantee without verifying it works in D1

Relying on an unverified PRAGMA to protect against data destruction is not a safety measure. It's a hope.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| ~12:28 | PR #812 merged to main by SAM GitHub App (agent-initiated auto-merge) |
| ~12:34 | Deploy Production workflow starts |
| ~12:36 | Migration 0047 executes. `DROP TABLE projects` cascades. Every row in 8+ child tables deleted. |
| ~12:38 | Deploy completes "successfully." No error — the migration ran without error because CASCADE deletes are silent. |
| Hours later | User discovers all triggers missing across all projects. Investigation reveals total data loss. |

## Recovery

D1 Time Travel (30-day point-in-time recovery) was used to restore the database to its state at `2026-04-25T12:30:00Z`, before the migration ran. This recovered all destroyed data but rolled back any data created after the incident.

## Process Fixes

### 1. CI Migration Safety Check — `pnpm quality:migration-safety` (AUTOMATED, MERGE-BLOCKING)

Script: `scripts/quality/check-migration-safety.ts`

- Parses every migration SQL file in the repository
- Builds the complete FK cascade map from all `REFERENCES ... ON DELETE CASCADE` declarations
- **Blocks merge** on any `DROP TABLE`, `DELETE FROM` (without WHERE), or `TRUNCATE` targeting a CASCADE parent table
- Allowlist for already-applied migrations only (not extendable without code review)

This is the primary prevention. It runs in CI. Agents cannot bypass it. If migration 0047 had been written with this check in place, CI would have printed:

```
DROP TABLE projects will CASCADE-delete all rows in: tasks, project_runtime_env_vars,
project_runtime_files, agent_profiles, project_deployment_credentials, triggers, credentials.
```

And the PR could not have been merged.

### 2. Pre-Deploy D1 Backup (AUTOMATED, EVERY DEPLOY)

New step in `deploy-reusable.yml` that creates a D1 backup and records a time-travel timestamp before every migration run. If a destructive migration somehow gets past CI, we can recover. This is the last line of defense — it should never be needed if the CI check does its job.

### 3. Agent Rule — `.claude/rules/31-migration-safety.md`

Documents safe alternatives to table recreation, the FK cascade check command, why `PRAGMA foreign_keys = OFF` is not reliable in D1, and guidance on choosing `ON DELETE` behavior. Defense in depth — agents should never reach for `DROP TABLE` in the first place.

## Lessons

1. **Automated checks beat agent rules.** The project had 30+ rule files, 5 specialist reviewers, staging verification requirements, and an explicit "Never Ship Broken Features" rule. None of them prevented this. A 200-line script that greps migration SQL would have.

2. **The FK graph is invisible until you look.** No table exists in isolation. Before touching any table's structure, you must understand what other tables depend on it. `grep -r "REFERENCES tablename" migrations/` is the minimum.

3. **Table recreation in SQLite is a loaded gun.** The pattern is widely documented as "the safe way to alter columns in SQLite." It is catastrophically unsafe when the table has CASCADE children. Documentation omits this because most SQLite users don't have complex FK graphs.

4. **`PRAGMA foreign_keys = OFF` is not a safety guarantee.** It is a connection-level setting in a system (D1) where connection semantics are opaque. Never rely on a PRAGMA to protect against irreversible operations.

5. **Silent destruction is the worst kind.** The migration "succeeded." The deploy "succeeded." No errors, no alerts, no warnings. The only signal was the absence of data. Systems must fail loudly when they destroy things.

6. **"Expected error" is the most dangerous phrase in software.** An agent that rationalizes a staging error as "expected" will ship anything. The error was a signal that the feature wasn't ready. The agent overrode the signal with a story.
