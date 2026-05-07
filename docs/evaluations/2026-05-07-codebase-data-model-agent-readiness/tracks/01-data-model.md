# Track 1: Data Model Integrity & Schema Design

**Status**: Complete
**Evaluator**: Claude Opus 4.6 (automated evaluation)
**Date**: 2026-05-07
**Branch**: `sam/execute-task-using-skill-01kr08`

---

## Executive Summary

SAM's hybrid D1 + Durable Object storage architecture is well-motivated and generally well-executed. The ADR-004 split (D1 for cross-project relational metadata, DO SQLite for per-project write-heavy data) is sound. However, the schema has accumulated several risks through rapid iteration:

- **1 CRITICAL finding**: KV token budget uses non-atomic read-modify-write, enabling race-condition budget overruns
- **4 HIGH findings**: duplicate migration numbers, missing FK onDelete on `workspaces.installationId`, unvalidated JSON columns, and ProjectData DO taking on too many concerns (19 migrations, 15+ tables)
- **6 MEDIUM findings**: timestamp convention inconsistency, missing indexes on FK columns, unbounded DO table growth, FTS5 sync gaps, D1/DO data duplication without sync guarantees, and soft FK orphan risk
- **3 LOW/INFO findings**: naming inconsistencies, CASCADE tree depth, sentinel pattern usage

Total: **14 findings** across D1 schema, DO schema, and KV/R2 usage.

---

## 1. D1 Schema Review

### 1.1 Normalization Assessment

The D1 schema is broadly in 3NF. Tables have clear single-entity focus. Notable observations:

- **`projects` table** has 28 columns (`apps/api/src/db/schema.ts:237-318`), which is wide but justified — most are nullable per-project scaling overrides that avoid a separate config table join on every project query.
- **`agentDefaults`** on `projects` (line 269) stores a JSON blob for per-agent-type model/permission overrides. This is a deliberate denormalization trading query simplicity for schema expressiveness — acceptable given the small cardinality per project.
- **`tasks` table** has 27 columns (lines 460-533), similarly wide but justified — task metadata is always loaded together.
- **No accidental denormalization found** — no data is duplicated across D1 tables without justification.

### 1.2 Naming Consistency

Overall naming is consistent: snake_case for all D1 columns, camelCase in Drizzle schema definitions (mapped to snake_case via column name strings). Minor outliers:

- **`githubRepoId` vs `github_repo_node_id`**: The Drizzle field names mix `github_repo_id` (integer, line 255) and `github_repo_node_id` (text, line 256). Both map to snake_case columns correctly, but the semantic distinction (numeric GitHub ID vs GraphQL node ID) could be clearer.
- **`vmSize` vs `vm_size`**: Used consistently but the abbreviation `vm` could be `virtualMachine` for clarity — though this is an established convention in the codebase and would be disruptive to change.

### 1.3 Foreign Key CASCADE Safety

**44 `ON DELETE CASCADE` relationships** exist in the D1 schema. The CASCADE dependency tree has been mapped:

```
users (ROOT — MOST DANGEROUS)
├── sessions (cascade)
├── accounts (cascade)
├── credentials (cascade)
├── github_installations (cascade)
│   └── projects (cascade) ← SECOND MOST DANGEROUS
│       ├── project_runtime_env_vars (cascade)
│       ├── project_runtime_files (cascade)
│       ├── project_deployment_credentials (cascade)
│       ├── missions (cascade)
│       ├── agent_profiles (cascade)
│       ├── triggers (cascade)
│       │   └── trigger_executions (cascade)
│       ├── tasks (cascade)
│       │   ├── task_dependencies (cascade, both columns)
│       │   └── task_status_events (cascade)
│       └── credentials (cascade, project_id FK)
├── projects (cascade, user_id FK)
├── tasks (cascade, user_id FK)
├── nodes (cascade)
├── workspaces (cascade)
├── agent_sessions (cascade)
├── agent_settings (cascade)
├── smoke_test_tokens (cascade)
├── compute_usage (cascade)
├── user_quotas (cascade)
└── project_runtime_env_vars (cascade)

ui_standards (ISOLATED SUBTREE)
├── theme_tokens (cascade)
├── component_definitions (cascade)
├── compliance_checklists (cascade)
├── agent_instruction_sets (cascade)
├── exception_requests (cascade)
│   └── compliance_runs (set null)
├── compliance_runs (cascade)
└── migration_work_items (cascade)
```

**Risk assessment**:

| Parent | Direct CASCADE Children | Total Transitive Children | Risk |
|--------|------------------------|--------------------------|------|
| `users` | 14 | 25+ | EXTREME — accidental user deletion destroys everything |
| `projects` | 8 | 11 | VERY HIGH — confirmed by 2026-04-25 incident |
| `github_installations` | 1 (`projects`) | 12 | HIGH — cascades through projects |
| `ui_standards` | 7 | 8 | MEDIUM — isolated subtree, lower blast radius |
| `triggers` | 1 | 1 | LOW |
| `tasks` | 2 | 2 | LOW |

The CI check `pnpm quality:migration-safety` now blocks `DROP TABLE` on CASCADE parents, which is the correct mitigation. The existing CASCADE choices are reasonable: child rows genuinely are meaningless without their parents in most cases.

**One exception worth reviewing**: `projects.createdBy` references `users.id` with `ON DELETE CASCADE` (line 287). This means deleting the user who *created* a project also deletes the project, even if `projects.userId` (the *owner*) is a different user. In practice, `createdBy` and `userId` are always the same user today, but if project ownership transfer is ever added, this would be a latent bug.

### 1.4 Index Coverage

Index coverage is generally good. Each FK column has an index, and compound indexes exist for common query patterns. Specific observations:

**Well-indexed patterns**:
- `tasks` has compound indexes for `(projectId, status, priority, updatedAt)` (line 521) covering the primary listing query
- `workspaces` has compound indexes for `(userId, status)`, `(userId, projectId, status)`, and `(nodeId, status)` (lines 666-672)
- `credentials` has partial unique indexes for user-scope vs project-scope (lines 193-201)
- `triggers` has a partial index for cron sweep `(sourceType, status, nextFireAt)` WHERE `source_type = 'cron' AND status = 'active'` (line 1190)

**Missing or questionable indexes**:
- `nodes` only has `idx_nodes_user_id` (line 613). Queries filtering by `status` (e.g., finding active/warm nodes) would benefit from a `(userId, status)` compound index.
- `trigger_executions.projectId` (line 1211) has no index despite being used for project-scoped execution queries.
- `workspaces.installationId` (line 632) has no index — queries joining workspaces to installations would scan.

### 1.5 Nullable vs Sentinel Patterns

The codebase uses **both** nullable columns and sentinel values, which creates a mixed pattern:

**Sentinels used**:
- `TRIAL_ANONYMOUS_INSTALLATION_ID` — sentinel row in `github_installations` for anonymous trial projects (`apps/api/src/db/migrations/0045_trial_sentinel_installation.sql`)
- `system_anonymous_trials` — sentinel user ID for trial projects (`apps/api/src/db/migrations/0043_trial_foundation.sql`)
- The `projects` unique index explicitly excludes the sentinel user (line 310): `WHERE user_id != 'system_anonymous_trials'`

**Nullables used** (in contrast):
- `tasks.workspaceId` — null until assigned (line 473)
- `tasks.parentTaskId` — null for top-level tasks (line 471)
- `tasks.missionId` — null for standalone tasks, with `ON DELETE SET NULL` (line 504)
- `projects.agentDefaults` — null means "use platform defaults" (line 269)
- All scaling parameter columns on `projects` — null means "use env default" (lines 271-281)

The sentinel pattern is used specifically for the trial system's FK constraint satisfaction, which is reasonable — making `installationId` nullable on `projects` would have required the dangerous table recreation pattern. The two approaches coexist without conflict, but the sentinel rows should be documented more prominently.

### 1.6 Schema Evolution Safety

**Last 10 D1 migrations** (0039-0048) were reviewed:

| Migration | Pattern | Safe? |
|-----------|---------|-------|
| 0039 | CREATE TABLE (new) | Yes |
| 0040 | ALTER TABLE ADD COLUMN (x3) | Yes |
| 0041 | ALTER TABLE ADD COLUMN (x3) | Yes |
| 0042 (both) | CREATE INDEX, ALTER TABLE ADD COLUMN | Yes |
| 0043 | CREATE TABLE, INSERT seed data | Yes |
| 0044 | CREATE TABLE (new) | Yes |
| 0045 | INSERT seed data | Yes |
| 0046 | DROP INDEX + CREATE INDEX (index only) | Yes |
| 0047 | ALTER TABLE ADD COLUMN (x2) — corrected after incident | Yes |
| 0048 | CREATE TABLE + ALTER TABLE ADD COLUMN (x2) | Yes |

All recent migrations use safe patterns. The 0047 migration was rewritten after the cascade data loss incident to use `ALTER TABLE ADD COLUMN` instead of table recreation.

### 1.7 Soft FK Audit

11 soft FK relationships identified (columns referencing other tables without database FK constraints):

| Table | Column | References | Justification | Risk |
|-------|--------|-----------|---------------|------|
| `tasks` | `parentTaskId` | `tasks.id` (cross-project) | Agent dispatch crosses project boundaries | LOW — validated in application layer |
| `tasks` | `workspaceId` | `workspaces.id` | Null until assigned; task outlives workspace | LOW — workspace deletion sets null via app logic |
| `tasks` | `triggerId` | `triggers.id` | Trigger may be deleted independently | LOW — trigger deletion doesn't affect task |
| `tasks` | `triggerExecutionId` | `trigger_executions.id` | Execution record may be cleaned up independently | LOW — audit trail only |
| `workspaces` | `chatSessionId` | ProjectData DO `chat_sessions` | Cross-storage-system reference (D1 → DO SQLite) | MEDIUM — no referential integrity check possible |
| `compute_usage` | `workspaceId` | `workspaces.id` | Billing data outlives resource deletion | LOW — intentional for billing |
| `compute_usage` | `nodeId` | `nodes.id` | Billing data outlives resource deletion | LOW — intentional for billing |
| `project_files` | `projectId` | `projects.id` | R2 cleanup handled separately | MEDIUM — orphaned metadata if project deleted |
| `trigger_executions` | `taskId` | `tasks.id` | Null when execution skipped | LOW — audit trail only |
| `missions` | `rootTaskId` | `tasks.id` | Task may be deleted before mission | LOW — informational reference |
| `trials` | `projectId` | `projects.id` | Trial may outlive project | LOW — trial lifecycle independent |

**Key risk**: `project_files.projectId` has no FK constraint and no CASCADE — if a project is deleted, the `project_files` metadata rows and their R2 blobs become orphaned. The comment says "R2 cleanup handled separately" but no cleanup mechanism was found in the codebase.

### 1.8 JSON Column Audit

8+ JSON columns identified in D1, **none with runtime validation** (Valibot or otherwise):

| Table | Column | Content Shape | Validated? | Risk |
|-------|--------|--------------|-----------|------|
| `projects` | `agentDefaults` | `Record<AgentType, { model?, permissionMode? }>` | No — resolved at runtime | MEDIUM |
| `missions` | `budgetConfig` | `MissionBudgetConfig` | No — parsed but not enforced | LOW (not yet active) |
| `nodes` | `lastMetrics` | Node health metrics JSON | No | LOW — display only |
| `component_definitions` | `supportedSurfacesJson` | UI surface array | No | LOW — admin-only |
| `component_definitions` | `requiredStatesJson` | State enum array | No | LOW — admin-only |
| `compliance_checklists` | `itemsJson` | Checklist items array | No | LOW — admin-only |
| `compliance_checklists` | `appliesToJson` | Target scope array | No | LOW — admin-only |
| `agent_instruction_sets` | `instructionBlocksJson` | Instruction block array | No | LOW — admin-only |
| `compliance_runs` | `findingsJson` | Finding detail array | No | LOW — admin-only |

The UI governance tables (`component_definitions`, `compliance_checklists`, `agent_instruction_sets`, `compliance_runs`) store significant structured data as JSON. These appear to be a governance framework that was added but may not be actively used in production. If they become active, Valibot validation on write would be appropriate.

---

## 2. Durable Object Schema Review

### 2.1 Migration Safety

All 19 ProjectData DO migrations (`apps/api/src/durable-objects/migrations.ts:23-567`) were reviewed:

| Pattern | Count | Safe? |
|---------|-------|-------|
| CREATE TABLE (new) | 10 | Yes |
| CREATE INDEX | 12 | Yes |
| ALTER TABLE ADD COLUMN | 7 | Yes |
| CREATE VIRTUAL TABLE (FTS5) | 2 | Yes (try/catch wrapped) |
| DROP INDEX | 1 | Yes (index replacement) |
| UPDATE (backfill) | 1 | Yes (idempotent) |

**No DROP TABLE or table recreation patterns found.** All migrations are safe and idempotent (using `IF NOT EXISTS` or try/catch for ADD COLUMN).

SamSession DO (3 migrations) and ProjectOrchestrator DO (3 migrations) also use safe patterns.

**DO migration runner** (`migrations.ts:573-600`) runs migrations lazily in `blockConcurrencyWhile()`, which is the correct Cloudflare pattern. Each migration is tracked in a `migrations` table and only run once.

### 2.2 FTS5 Consistency

Three FTS5 virtual tables exist across two DO types:

| DO | FTS5 Table | Content Table | Sync Mechanism | Fallback |
|----|-----------|---------------|----------------|----------|
| ProjectData | `chat_messages_grouped_fts` | `chat_messages_grouped` | Populated during `materializeSession()` when session stops | LIKE query fallback in `searchMessages()` |
| ProjectData | `knowledge_observations_fts` | `knowledge_observations` | **Manual sync on add/update** — `INSERT INTO fts` after entity operations | LIKE query fallback in `searchKnowledge()` |
| SamSession | `messages_fts` | `messages` | Sync in `persistMessage()` with try/catch (non-fatal) | LIKE fallback |

**Consistency gaps**:

1. **`knowledge_observations_fts` sync on delete**: When an observation is deactivated (`is_active = 0`), the FTS5 entry is NOT removed. Stale search results may include deactivated observations. The LIKE fallback correctly filters by `is_active = 1`, but FTS5 does not.

2. **`chat_messages_grouped_fts` timing**: FTS5 is only populated when a session stops (materialization). Active sessions with ongoing messages are not searchable via FTS5 — only via LIKE fallback. This is documented and intentional but creates a search quality gap for active sessions.

3. **FTS5 creation failure handling**: All three FTS5 tables are created in try/catch blocks with graceful degradation. This is correct — FTS5 availability varies by SQLite build. However, there's no monitoring or alerting when FTS5 creation fails, making it invisible.

### 2.3 Data Duplication (D1 ↔ DO)

Several data entities exist in both D1 and DO SQLite:

| Data | D1 Location | DO Location | Sync Mechanism | Divergence Risk |
|------|------------|-------------|----------------|-----------------|
| Task status events | `task_status_events` table | ProjectData `task_status_events` table | Dual-write from API route handlers | MEDIUM — if one write fails, they diverge |
| Task status | `tasks.status` column | Derived from `task_status_events` in DO | D1 is authoritative; DO is audit trail | LOW |
| Session metadata | `workspaces.chatSessionId` | ProjectData `chat_sessions.id` | Soft FK in D1 points to DO | MEDIUM — stale chatSessionId if DO session deleted |
| Project activity | `projects.lastActivityAt`, `activeSessionCount` | ProjectData activity_events, chat_sessions | Debounced callback from DO to D1 | LOW — designed to be eventually consistent |

The task_status_events duplication is the most concerning — both D1 (`apps/api/src/db/schema.ts:557-576`) and ProjectData DO (`apps/api/src/durable-objects/migrations.ts:59-75`) have `task_status_events` tables with nearly identical schemas. If the D1 write succeeds but the DO write fails (or vice versa), the two tables will have different event histories. There is no reconciliation mechanism.

### 2.4 DO Storage Growth Risks

| DO Type | Table | Growth Pattern | Bounded? | Risk |
|---------|-------|---------------|----------|------|
| ProjectData | `chat_messages` | Append-only, per session | Unbounded | HIGH — long agent sessions can generate 100k+ tokens as individual rows |
| ProjectData | `activity_events` | Append-only, per project | Unbounded | MEDIUM — no retention/archival policy |
| ProjectData | `chat_messages_grouped` | Append-only, per materialized session | Unbounded | MEDIUM — derivative of chat_messages |
| ProjectData | `knowledge_entities` | Bounded by `KNOWLEDGE_MAX_ENTITIES_PER_PROJECT` (500) | Yes | LOW |
| ProjectData | `knowledge_observations` | Bounded by `KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY` (100) | Yes | LOW |
| ProjectData | `session_inbox` | Bounded by `MAILBOX_MAX_MESSAGES_PER_PROJECT` (1000) | Yes | LOW |
| ProjectData | `mission_state_entries` | Bounded by `MISSION_MAX_STATE_ENTRIES` (200) | Yes | LOW |
| ProjectOrchestrator | `decision_log` | Bounded by `ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES` (500) | Yes | LOW |
| SamSession | `messages` | Append-only, per conversation | Unbounded | MEDIUM — SAM conversations can be long-running |

**`chat_messages` is the primary growth concern.** Each streaming token from Claude Code is stored as a separate row. A single 4-hour agent session can generate 50,000+ message rows. The `chat_messages_grouped` materialization helps for search, but the raw messages remain. No retention policy exists.

Cloudflare DO SQLite has a 10GB per-DO limit. For a project with many long sessions, this could eventually become a concern, though it would take thousands of sessions to approach it.

### 2.5 ProjectData DO Responsibility Assessment

The ProjectData DO manages **15+ tables** across **19 migrations**:

| Concern | Tables |
|---------|--------|
| Chat sessions & messages | `chat_sessions`, `chat_messages`, `chat_messages_grouped`, `chat_messages_grouped_fts` |
| ACP session lifecycle | `acp_sessions`, `acp_session_events` |
| Activity tracking | `activity_events`, `workspace_activity` |
| Task status audit | `task_status_events` |
| Idle cleanup | `idle_cleanup_schedule` |
| Knowledge graph | `knowledge_entities`, `knowledge_observations`, `knowledge_relations`, `knowledge_observations_fts` |
| Chat-idea linking | `chat_session_ideas` |
| Agent mailbox | `session_inbox` |
| Mission state | `mission_state_entries`, `handoff_packets` |
| Project policies | `project_policies` |
| Cached commands | `cached_commands` |
| DO metadata | `do_meta`, `migrations` |

This DO is doing the work of 5-6 separate concerns. While co-locating all per-project data in a single DO has benefits (zero-hop reads, single binding), it creates:

1. **Migration complexity**: 19 migrations that all run in the same `blockConcurrencyWhile()` block
2. **Coupling risk**: A bug in knowledge graph code could affect chat messaging
3. **Context window burden**: An agent working on chat messaging must load code for all 15+ table concerns
4. **Testing complexity**: Miniflare tests must set up the full DO state even when testing a single concern

---

## 3. KV/R2 Usage Review

### 3.1 KV Key Naming Conventions

13 KV key patterns identified. Naming conventions are **mostly consistent** (colon-delimited namespaces) but have some variance:

| Pattern | Format | Convention |
|---------|--------|-----------|
| MCP tokens | `mcp:<token>` | Standard |
| Bootstrap tokens | `bootstrap:<token>` | Standard |
| Trial records | `trial:<trialId>` | Standard |
| Trial fingerprint index | `trial:fingerprint:<fp>` | Standard |
| Trial project index | `trial:project:<projectId>` | Standard |
| AI proxy config | `AI_PROXY_DEFAULT_MODEL` (constant) | SCREAMING_SNAKE — inconsistent with others |
| AI billing mode | `AI_PROXY_BILLING_MODE` (constant) | SCREAMING_SNAKE — inconsistent with others |
| GCP OAuth state | `gcp-deploy-oauth-state:<state>` | Kebab-case — inconsistent |
| GCP OAuth token | `gcp-deploy-oauth-token:<handle>` | Kebab-case — inconsistent |
| AI budget settings | `ai-budget-settings:<userId>` | Kebab-case — inconsistent |
| AI token usage | `ai-usage:<userId>:<date>` | Kebab-case — inconsistent |
| Trial kill switch | `trials:enabled` | Colon-delimited |
| Analytics cursor | `analytics-cursor:<key>` | Kebab-case — inconsistent |

Three naming styles coexist: colon-delimited (`mcp:`, `trial:`), kebab-case (`ai-budget-settings:`), and SCREAMING_SNAKE (`AI_PROXY_DEFAULT_MODEL`). No documented namespace convention exists.

### 3.2 TTL Policy

| Key Type | TTL | Appropriate? |
|----------|-----|-------------|
| MCP tokens | 1 hour | Yes |
| Bootstrap tokens | 5 minutes | Yes |
| Trial records | ~10 hours (configurable) | Yes |
| AI proxy config | Permanent | Yes — admin config |
| GCP OAuth state | 10 minutes | Yes |
| GCP OAuth token cache | 1 hour | Yes |
| AI budget settings | 90 seconds | Yes — quick refresh |
| AI token usage | Configurable (default 25h) | Yes — daily reset |
| Trial kill switch | Permanent | Yes — admin toggle |
| Analytics cursor | Permanent | Questionable — accumulates forever |

The `analytics-cursor:*` keys accumulate without cleanup. Over time, this could become many keys if analytics forwarding runs daily for many event types. Low severity since KV has no storage limit, but a TTL of 90 days would be more hygienic.

### 3.3 Read-After-Write Consistency

KV is eventually consistent. Most usage patterns are safe (tokens are write-once-read-many). However:

**AI token budget** (`apps/api/src/services/ai-token-budget.ts:190-221`) performs a **read-modify-write** pattern:

```typescript
const existing = await getTokenUsage(kv, userId);  // READ
const updated = {
  inputTokens: existing.inputTokens + inputTokens,  // MODIFY
  outputTokens: existing.outputTokens + outputTokens,
};
await kv.put(key, JSON.stringify(updated), { ... });  // WRITE
```

This is **not atomic**. If two concurrent requests increment usage for the same user, the second read may see stale data (KV eventual consistency), causing a lost update. The user's budget counter would undercount, allowing them to exceed their daily limit.

### 3.4 R2 Data Lifecycle

| Use Case | Key Pattern | Lifecycle | Cleanup Mechanism |
|----------|-------------|-----------|-------------------|
| Project file library | `library/<projectId>/<fileId>` | Permanent until explicit delete | Manual delete via API; **no cleanup on project deletion** |
| Task attachments | `attachments/<userId>/<uploadId>/<filename>` | Temporary — deleted after task transfer | `cleanupAttachments()` in TaskRunner DO |
| VM agent binaries | `vm-agent/<goarch>/<version>` | Permanent | Manual — old versions accumulate |

**R2 orphan risk**: When a project is deleted (CASCADE from D1), the `project_files` metadata rows are soft-referenced (no FK) and will remain in D1. The R2 blobs are not cleaned up. Over time, orphaned R2 objects and metadata rows accumulate.

---

## 4. Entity Placement Table

| Entity | Storage | Reason | Optimality | Issues |
|--------|---------|--------|-----------|--------|
| Users | D1 | Auth, cross-user queries | Optimal | None |
| Sessions (auth) | D1 | BetterAuth framework | Optimal | None |
| Accounts (OAuth) | D1 | BetterAuth framework | Optimal | None |
| Credentials (user) | D1 | Cross-project resolution | Optimal | None |
| Platform credentials | D1 | Admin-managed, cross-user | Optimal | None |
| GitHub installations | D1 | Cross-project, FK parent | Optimal | None |
| Projects (metadata) | D1 | Cross-project dashboard | Optimal | Wide table (28 cols) |
| Project env vars | D1 | Encrypted, per-project | Optimal | None |
| Project runtime files | D1 | Encrypted, per-project | Optimal | None |
| Deployment credentials | D1 | Per-project GCP config | Optimal | None |
| Missions | D1 | Cross-project task views | Optimal | None |
| Tasks | D1 | Cross-project dashboard | Optimal | Wide table (27 cols), many soft FKs |
| Task dependencies | D1 | DAG queries | Optimal | None |
| Task status events | D1 + DO | Dual-write audit trail | Suboptimal | Duplicated; no reconciliation |
| Nodes | D1 | Cross-user lifecycle | Optimal | Missing (userId, status) index |
| Workspaces | D1 | Cross-project lifecycle | Optimal | installationId missing onDelete |
| Agent sessions | D1 | Cross-workspace queries | Optimal | None |
| Agent settings | D1 | Per-user, per-agent | Optimal | BetterAuth timestamp convention |
| Agent profiles | D1 | Per-project + global | Optimal | Partial index only in SQL migration |
| UI governance (6 tables) | D1 | Admin config | Questionable | May be unused; heavy JSON columns |
| Triggers | D1 | Cross-project scheduling | Optimal | None |
| Trigger executions | D1 | Audit trail | Optimal | Missing projectId index |
| Project files (metadata) | D1 | Cross-project queries | Optimal | Soft FK — orphan risk |
| Project file tags | D1 | Tag queries | Optimal | None |
| Compute usage | D1 | Billing aggregation | Optimal | Soft FKs — intentional for billing |
| Quotas | D1 | Admin config | Optimal | None |
| Trial records | D1 | Cross-trial queries | Optimal | None |
| Trial waitlist | D1 | Waitlist management | Optimal | None |
| Smoke test tokens | D1 | Auth testing | Optimal | None |
| Chat sessions | DO SQLite | Write-heavy, per-project | Optimal | None |
| Chat messages | DO SQLite | Append-only, per-project | Optimal | Unbounded growth |
| Grouped messages + FTS | DO SQLite | Search, per-project | Optimal | FTS5 not synced on delete |
| ACP sessions | DO SQLite | Session lifecycle, per-project | Optimal | None |
| ACP session events | DO SQLite | Audit trail, per-project | Optimal | None |
| Activity events | DO SQLite | Per-project feed | Optimal | Unbounded growth |
| Knowledge graph (3 tables) | DO SQLite | Per-project memory | Optimal | FTS stale on deactivation |
| Session inbox (mailbox) | DO SQLite | Per-project messaging | Optimal | Bounded (1000 max) |
| Mission state + handoffs | DO SQLite | Per-project orchestration | Optimal | Bounded |
| Project policies | DO SQLite | Per-project rules | Optimal | Bounded (100 max) |
| Workspace activity | DO SQLite | Idle detection | Optimal | None |
| Idle cleanup schedule | DO SQLite | Cleanup scheduling | Optimal | None |
| Chat-idea links | DO SQLite | Per-project linking | Optimal | None |
| Cached commands | DO SQLite | Per-project cache | Optimal | None |
| DO metadata | DO SQLite | Migration tracking | Optimal | None |
| MCP tokens | KV | Ephemeral, 1h TTL | Optimal | None |
| Bootstrap tokens | KV | Ephemeral, 5min TTL | Optimal | None |
| Trial state | KV | Ephemeral, configurable TTL | Optimal | None |
| AI proxy config | KV | Admin toggle | Optimal | Naming inconsistency |
| AI token budgets | KV | Daily counters | Suboptimal | Non-atomic read-modify-write |
| Analytics cursors | KV | Dedup state | Acceptable | No TTL — accumulates |
| Project file content | R2 | Encrypted binary blobs | Optimal | No cleanup on project delete |
| Task attachments | R2 | Temporary upload staging | Optimal | Cleaned up after transfer |
| VM agent binaries | R2 | Binary distribution | Optimal | Old versions accumulate |
| Node lifecycle state | DO Storage | Per-node state machine | Optimal | No SQLite — correct choice |
| Task runner state | DO Storage | Per-task execution | Optimal | No SQLite — correct choice |
| Trial orchestrator state | DO Storage | Per-trial provisioning | Optimal | No SQLite — correct choice |
| Orchestrator state | DO SQLite | Per-project scheduling | Optimal | Bounded decision log |

---

## 5. Findings

### [CRITICAL] C1: KV Token Budget Non-Atomic Read-Modify-Write

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/services/ai-token-budget.ts:190-221`
**Category**: data-model

**Finding**: The `incrementTokenUsage()` function reads the current token count from KV, adds to it locally, and writes back. KV is eventually consistent — concurrent requests can read stale values, causing lost updates. Under concurrent agent sessions for the same user, the budget counter will undercount, allowing users to exceed their configured daily token limits.

**Impact**: Budget enforcement is unreliable for users with multiple concurrent agent sessions. Overruns could result in unexpected costs.

**Recommendation**: Replace KV read-modify-write with an atomic counter. Options:
1. Move token counting to a Durable Object (atomic writes within a single DO)
2. Use D1 with `UPDATE SET input_tokens = input_tokens + ?` (atomic SQL increment)
3. Accept the race condition as tolerable for a soft budget (document the known gap)

**Implementation Owner**: `apps/api` — AI proxy team
**Effort**: M

---

### [HIGH] H1: Duplicate D1 Migration Number Prefixes

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/migrations/`
**Category**: data-model

**Finding**: 8 migration number prefixes are duplicated: 0002, 0013, 0016, 0024, 0029, 0036, 0037, 0042. For example, both `0042_project_agent_defaults.sql` and `0042_project_scoped_credentials.sql` exist. Wrangler D1 migrations use filename sort order, which means the migration with the alphabetically-first suffix runs first. This has worked so far because the duplicates don't conflict, but it creates:
1. Confusion about migration ordering
2. Risk that a future duplicate pair could have ordering dependencies
3. No way to insert a migration "between" two with the same number

**Impact**: Future migrations could accidentally share a number, and ordering-dependent migrations could silently run in the wrong order.

**Recommendation**: Adopt a policy of never reusing numbers. Add a CI check that fails on duplicate prefixes. Do NOT renumber existing migrations (they've already been applied to production).

**Implementation Owner**: `scripts/quality/` — CI team
**Effort**: S

---

### [HIGH] H2: Missing onDelete on workspaces.installationId FK

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts:632`
**Category**: data-model

**Finding**: `workspaces.installationId` references `githubInstallations.id` with no `onDelete` behavior specified. In SQLite, this defaults to `NO ACTION`, which means deleting a `github_installations` row while workspaces reference it will silently succeed, leaving orphaned `installationId` values pointing to non-existent installations.

Since `github_installations` CASCADEs from `users`, deleting a user will delete their installations, which will leave their workspaces with dangling `installationId` references. The workspaces themselves survive (they CASCADE from `users.id` via the separate `userId` FK), so this is a data integrity issue, not a data loss issue.

**Impact**: Orphaned `installationId` values on workspace records after user/installation deletion. Could cause null reference errors if code assumes the installation exists.

**Recommendation**: Add `onDelete: 'set null'` to `workspaces.installationId` (line 632). This is consistent with how `workspaces.nodeId` handles the same pattern (line 625).

**Implementation Owner**: `apps/api/src/db/` — migration
**Effort**: S

---

### [HIGH] H3: No Runtime Validation on JSON Columns

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts` — multiple tables
**Category**: data-model

**Finding**: 8+ JSON columns store structured data as text with no Valibot/Zod runtime validation on write. The project explicitly prefers Valibot (`CodeQuality` knowledge: "Let's choose one. I like Valibot.") but no JSON columns use it. `projects.agentDefaults` (line 269) is the highest-risk because it's written by users via the Settings UI and read on every task dispatch.

**Impact**: Malformed JSON in `agentDefaults` could crash task dispatch. Invalid JSON in UI governance tables could break admin workflows. No schema evolution protection for JSON column shapes.

**Recommendation**: Add Valibot schemas for the top-3 user-facing JSON columns:
1. `projects.agentDefaults` — validate on PATCH `/api/projects/:id`
2. `missions.budgetConfig` — validate on POST create mission
3. `nodes.lastMetrics` — validate on heartbeat write

Leave admin-only UI governance JSON columns for a later pass.

**Implementation Owner**: `apps/api/src/routes/` + `packages/shared/src/types/`
**Effort**: M

---

### [HIGH] H4: ProjectData DO Responsibility Overload

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/durable-objects/project-data/` + `apps/api/src/durable-objects/migrations.ts`
**Category**: data-model

**Finding**: The ProjectData DO manages 15+ tables across 6+ distinct concerns (chat, ACP lifecycle, activity tracking, knowledge graph, mailbox, mission state, policies, cached commands). This creates:
- 19 migrations running in a single `blockConcurrencyWhile()` block
- All concerns sharing a single DO instance limit (10GB SQLite, single-threaded)
- High coupling between unrelated features
- Large code surface for agents to navigate

**Impact**: Adding new per-project features continues to bloat this DO. A bug in one concern (e.g., knowledge graph FTS sync) could affect chat messaging availability. Migration complexity grows linearly with feature count.

**Recommendation**: This is an architectural observation, not an immediate fix. When adding the next major per-project feature, evaluate whether it should be a separate DO type (e.g., `PROJECT_KNOWLEDGE` for the knowledge graph). The chat + ACP + activity core should remain together since they're tightly coupled. Knowledge graph, mailbox, and policies could be separate DOs.

**Implementation Owner**: Architecture decision — defer until next major DO feature
**Effort**: XL (if undertaken)

---

### [MEDIUM] M1: Timestamp Convention Inconsistency

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts:8-13`
**Category**: data-model

**Finding**: Two timestamp conventions coexist in D1:
- **BetterAuth tables** (users, sessions, accounts, verifications, agentSettings, smokeTestTokens): `integer('...', { mode: 'timestamp_ms' })` storing millisecond epoch integers
- **All other tables**: `text('...')` with `DEFAULT CURRENT_TIMESTAMP` storing ISO-8601 strings

This is documented in the schema header (lines 8-13) and is a deliberate choice (BetterAuth requires integer timestamps). However, it creates:
- Confusion when joining BetterAuth tables with other tables on timestamps
- Different comparison semantics (integer comparison vs string comparison)
- Inconsistent Date parsing in TypeScript (Drizzle auto-converts integers; strings need `new Date()`)

**Impact**: Agents working on cross-table timestamp queries must know which convention each table uses. Risk of incorrect timestamp comparisons in JOINs.

**Recommendation**: Document this more prominently. Add a TypeScript helper that normalizes both formats to a common representation when needed. Do NOT migrate existing tables — the risk outweighs the benefit.

**Implementation Owner**: `packages/shared/` — utility function
**Effort**: S

---

### [MEDIUM] M2: Missing Indexes on Commonly-Queried FK Columns

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts`
**Category**: data-model

**Finding**: Several FK or frequently-queried columns lack indexes:
1. `nodes` table: no `(userId, status)` compound index (line 613) — node listing by status requires full scan
2. `trigger_executions.projectId` (line 1211): no index despite project-scoped queries
3. `workspaces.installationId` (line 632): no index for installation-based lookups

**Impact**: Performance degradation on node listing, trigger execution history, and installation-based workspace queries as data grows.

**Recommendation**: Add three indexes in a single migration:
```sql
CREATE INDEX idx_nodes_user_status ON nodes(user_id, status);
CREATE INDEX idx_trigger_executions_project ON trigger_executions(project_id);
CREATE INDEX idx_workspaces_installation ON workspaces(installation_id);
```

**Implementation Owner**: `apps/api/src/db/migrations/`
**Effort**: S

---

### [MEDIUM] M3: Unbounded chat_messages Growth in ProjectData DO

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/durable-objects/migrations.ts:46-58`
**Category**: data-model

**Finding**: `chat_messages` is append-only with no retention policy. Each streaming token is stored as a separate row. A single 4-hour agent session can generate 50,000+ rows. Over many sessions, this could approach the 10GB DO SQLite limit.

The `chat_messages_grouped` materialization creates a more compact representation for search, but the raw `chat_messages` rows remain indefinitely.

**Impact**: Long-running projects with many agent sessions will accumulate large message tables, eventually degrading query performance and potentially hitting the 10GB DO limit.

**Recommendation**: Implement a retention policy — after materialization, archive or delete raw `chat_messages` rows for completed sessions older than a configurable threshold (e.g., 30 days). Keep `chat_messages_grouped` as the durable representation.

**Implementation Owner**: `apps/api/src/durable-objects/project-data/`
**Effort**: M

---

### [MEDIUM] M4: FTS5 Not Synced on Knowledge Observation Deactivation

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/durable-objects/migrations.ts:423-431` + knowledge tools implementation
**Category**: data-model

**Finding**: When a knowledge observation is deactivated (`is_active = 0`), the corresponding `knowledge_observations_fts` entry is not removed. FTS5 search results will include deactivated observations. The LIKE fallback correctly filters by `is_active = 1`, but FTS5 does not apply this filter.

**Impact**: Knowledge search via FTS5 may return stale/contradicted observations, confusing agents that rely on the knowledge graph for context.

**Recommendation**: Add `DELETE FROM knowledge_observations_fts WHERE rowid = ?` when deactivating an observation. FTS5 external content tables support row deletion.

**Implementation Owner**: `apps/api/src/routes/mcp/knowledge-tools.ts`
**Effort**: S

---

### [MEDIUM] M5: D1/DO Dual-Write for task_status_events Without Reconciliation

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts:557-576` (D1) + `apps/api/src/durable-objects/migrations.ts:59-75` (DO)
**Category**: data-model

**Finding**: Task status events are written to both D1 `task_status_events` and ProjectData DO `task_status_events`. There is no reconciliation mechanism if one write fails. The two tables can diverge silently.

**Impact**: Inconsistent audit trails between D1 and DO. D1 is authoritative for cross-project queries; DO is authoritative for per-project views. If they disagree, which one is correct?

**Recommendation**: Either:
1. Make one storage authoritative and query it from both contexts (D1 for cross-project, DO proxied for per-project)
2. Add a reconciliation job that compares counts and flags discrepancies
3. Document the eventual consistency contract and accept the gap

**Implementation Owner**: Architecture decision
**Effort**: M

---

### [MEDIUM] M6: project_files Soft FK Creates Orphan Risk with R2

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts:1096-1127`
**Category**: data-model

**Finding**: `project_files.projectId` is a soft reference (no FK constraint). When a project is deleted via CASCADE, the `project_files` rows remain in D1 and the corresponding R2 blobs remain in the bucket. No cleanup mechanism was found for either.

**Impact**: Orphaned metadata rows and R2 blobs accumulate over time, consuming storage and potentially leaking data.

**Recommendation**: Add a project deletion hook (or cron job) that:
1. Queries `project_files` for the deleted project ID
2. Deletes R2 objects by `r2Key`
3. Deletes the metadata rows

Alternatively, add a real FK with `ON DELETE CASCADE` to `project_files.projectId` (this handles the metadata rows) and add a Cloudflare R2 lifecycle rule for the `library/` prefix.

**Implementation Owner**: `apps/api/src/services/file-library.ts`
**Effort**: M

---

### [LOW] L1: KV Key Naming Inconsistency

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: Various files in `apps/api/src/services/`
**Category**: data-model

**Finding**: KV keys use three different naming conventions: colon-delimited (`mcp:`, `trial:`), kebab-case (`ai-budget-settings:`), and SCREAMING_SNAKE (`AI_PROXY_DEFAULT_MODEL`).

**Impact**: Agents and developers must remember which convention each key type uses. No way to list/debug keys by namespace.

**Recommendation**: Standardize on colon-delimited namespacing (`ai-proxy:default-model`, `ai-budget:settings:<userId>`). Add a `KV_KEYS` constants object in `packages/shared/`. Migrate existing keys gradually (KV keys are ephemeral so old keys expire naturally).

**Implementation Owner**: `packages/shared/src/constants/`
**Effort**: S

---

### [LOW] L2: CASCADE Tree Depth Through github_installations

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts:248`
**Category**: data-model

**Finding**: `projects.installationId` references `github_installations.id` with `ON DELETE CASCADE`. Since `github_installations` itself CASCADEs from `users`, deleting a user triggers: users → github_installations → projects → (8 child tables). The total cascade depth is 4 levels, with the widest fan-out at the `projects` level.

This is the same cascade path that caused the 2026-04-25 incident. While the CI migration safety check now prevents `DROP TABLE` on these parents, the architectural risk remains: any D1 bug or manual query that deletes a `github_installations` row would cascade through all projects.

**Impact**: Deep CASCADE chains amplify the blast radius of any accidental deletion.

**Recommendation**: Consider changing `projects.installationId` from `ON DELETE CASCADE` to `ON DELETE RESTRICT`, which would prevent installation deletion while projects reference it. Project deletion should be an explicit user action, not a side effect of installation removal.

**Implementation Owner**: `apps/api/src/db/migrations/`
**Effort**: S (migration), but requires careful analysis of installation deletion flows

---

### [INFO] I1: UI Governance Tables May Be Unused

**Track**: 1 — Data Model Integrity & Schema Design
**Location**: `apps/api/src/db/schema.ts:819-1012`
**Category**: data-model

**Finding**: 7 tables (`ui_standards`, `theme_tokens`, `component_definitions`, `compliance_checklists`, `agent_instruction_sets`, `exception_requests`, `compliance_runs`, `migration_work_items`) form a UI governance framework. These tables use heavy JSON columns and have their own CASCADE subtree. No routes or services were found actively writing to or reading from these tables in production workflows.

**Impact**: Dead or dormant tables add schema complexity, migration surface area, and cognitive load without providing value.

**Recommendation**: Verify whether these tables are actively used. If not, consider removing them in a future cleanup to simplify the schema. If they are planned for future use, document the timeline.

**Implementation Owner**: Product decision
**Effort**: S (if removing)

---

## 6. Follow-Up Task Packets

### Task Packet 1: Fix KV Token Budget Race Condition (P0)

**Priority**: P0 — CRITICAL
**Relates to**: Finding C1

**Description**: Replace the non-atomic KV read-modify-write in `incrementTokenUsage()` with an atomic counter. Recommended approach: move daily token counting to a per-user Durable Object or use D1 atomic increment.

**Files to modify**:
- `apps/api/src/services/ai-token-budget.ts` — replace `getTokenUsage()` + `kv.put()` with atomic operation
- `apps/api/src/routes/ai-proxy-shared.ts` — update callers
- `apps/api/tests/` — add concurrent increment test

**Acceptance criteria**:
- [ ] Two concurrent `incrementTokenUsage()` calls for the same user both contribute their full token count
- [ ] Budget enforcement blocks requests when the limit is reached (no overrun)
- [ ] Test proves concurrent safety

---

### Task Packet 2: Add CI Check for Duplicate Migration Numbers (P1)

**Priority**: P1 — HIGH
**Relates to**: Finding H1

**Description**: Add a quality check script that fails CI when two migration files share the same numeric prefix.

**Files to modify**:
- `scripts/quality/check-migration-numbers.ts` — new script
- `package.json` — add `quality:migration-numbers` script
- `.github/workflows/ci.yml` — add to quality checks

**Acceptance criteria**:
- [ ] CI fails when two `.sql` files in `apps/api/src/db/migrations/` share the same 4-digit prefix
- [ ] Existing duplicates are documented in an allowlist (they've been applied to production)

---

### Task Packet 3: Fix workspaces.installationId Missing onDelete (P1)

**Priority**: P1 — HIGH
**Relates to**: Finding H2

**Description**: Add a D1 migration to set `ON DELETE SET NULL` on `workspaces.installationId`. Since SQLite doesn't support `ALTER COLUMN`, use `ALTER TABLE ADD COLUMN` to add a new column and migrate data if needed, or use application-level cleanup.

**Files to modify**:
- `apps/api/src/db/migrations/0049_*.sql` — new migration
- `apps/api/src/db/schema.ts` — add `onDelete: 'set null'` to the reference

**Acceptance criteria**:
- [ ] Deleting a `github_installations` row sets `workspaces.installationId` to NULL (not orphaned)
- [ ] No DROP TABLE used in the migration
- [ ] Migration safety CI check passes

---

### Task Packet 4: Add Missing FK Indexes (P1)

**Priority**: P1 — HIGH
**Relates to**: Finding M2

**Description**: Add three missing indexes for commonly-queried columns.

**Files to modify**:
- `apps/api/src/db/migrations/0049_*.sql` — new migration (can be combined with Task 3)
- `apps/api/src/db/schema.ts` — add index definitions

**Acceptance criteria**:
- [ ] `idx_nodes_user_status` on `nodes(user_id, status)`
- [ ] `idx_trigger_executions_project` on `trigger_executions(project_id)`
- [ ] `idx_workspaces_installation` on `workspaces(installation_id)`
- [ ] Migration uses CREATE INDEX (no DROP TABLE)
