# Policy lifecycle controls: expiry + scope, then stale-policy cleanup

**Task ID**: `01M0QHJBP38F4E566RKAJRNT7N`
**Idea**: `01M0QGZQ15WE9DDQENGV6S9XZ5`
**Branch**: `sam/add-lifecycle-controls-sam-jrnt7n`
**Source**: token-optimization research (library `/engineering/research/token-optimization-research.md`,
fileId `01M0QGYKH9PCSM5E7N58ZD98JT`), sections 3.3 and 8/R2.

## Problem

`getActivePolicies` (`apps/api/src/durable-objects/project-data/policies.ts:146`) injects **every**
active policy into **every** session, unranked and with no shelf life. The SAM project currently has
81 active policies against a cap of 100.

Reading through them, the research found two failure modes:

1. **One-shot workflow policies that never die.** "Use Codex 5.5 High Chat VMs for current
   reliability workflow" names a specific 2026-08-21 workstream. "Commenting delivery root is
   coordination-only" names a specific delivery. "Scheduler lifecycle test work is CI-only" names a
   specific 2026-08-15 request. All three describe work that is finished, and all three will keep
   loading into every future session's opening turn until a human notices and deactivates them.
2. **Policies that restate `.claude/rules` verbatim.** The same sentence is paid for in the rules
   file *and* in the policy directives block, every session.

There is no mechanism today for an agent capturing a genuinely-temporary constraint to mark it as
temporary. `add_policy` has no expiry and no scope, so every policy is implicitly permanent. The
capture instruction in `instruction-tools.ts` tells agents to save user statements as policies
without ever mentioning that some of them should expire.

Estimated saving from R2: ~10–25k tokens/session.

## Research findings

### Storage

- Table created in DO migration `019-project-policies` (`apps/api/src/durable-objects/migrations.ts:596`).
  Columns: `id, category, title, content, source, source_session_id, confidence, active, created_at,
  updated_at`. Two indexes: partial `idx_project_policies_active WHERE active = 1`, and
  `idx_project_policies_category(category, active)`.
- **No `CHECK` constraints on `category` or `source`** — both are validated in application code via
  `isPolicyCategory` / `isPolicySource`. A new `scope` column follows the same convention, which
  also means it needs no table recreation (SQLite cannot `ALTER ... ADD CHECK`).
- Latest DO migration on `origin/main` is `033-library-file-comment-threads`. Mine is therefore
  `034-`. The array is append-only (rule 07); if a sibling task lands `034` first, renumber to `035`.

### Every query that reads `project_policies` (rule 63 requirement 2)

| Query | Location | Authorization predicate? | Change |
|---|---|---|---|
| `SELECT COUNT(*) ... WHERE active = 1` (per-project cap) | `policies.ts:34` | No | Exclude expired — an expired policy is inert and must not consume cap headroom |
| `SELECT * WHERE id = ?` | `getPolicy`, `policies.ts:52` | No | **Unchanged** — a human must still be able to read an expired policy |
| `SELECT * [WHERE active/category]` | `listPolicies`, `policies.ts:67-93` | No | **Unchanged** — the UI must still show expired policies so a human can see *why* one stopped applying |
| `UPDATE ... WHERE id = ?` | `updatePolicy`, `policies.ts:117` | No | Persist `expires_at` / `scope` |
| `UPDATE ... SET active = 0 WHERE id = ?` | `removePolicy`, `policies.ts:135` | No | Unchanged |
| `SELECT * WHERE active = 1 ORDER BY ... LIMIT ?` | `getActivePolicies`, `policies.ts:148` | No | **Add expiry filter** |

**None of these is an authorization predicate.** Project scoping is structural: the ProjectData DO
*is* the project (`env.PROJECT_DATA.idFromName(projectId)`), so there is no `project_id` column to
drop from a `WHERE`. Rule 63's failure mode (a widened column silently deleting a scoping conjunct)
therefore does not apply here — but the enumeration above is recorded because the rule requires it.

Rule 63 requirement 1 (prefer a separate table) was considered and rejected in writing: `expires_at`
and `scope` are attributes *of a policy*, not a new row kind. Every existing column still applies to
every row, no column becomes nullable-because-a-new-kind-lacks-it, and both new columns are purely
additive. A second table would need a 1:1 join on every read for no benefit.

### Call chain to update

```
MCP add_policy/update_policy      apps/api/src/routes/mcp/policy-tools.ts
REST POST/PATCH  /policies        apps/api/src/routes/policies.ts (+ schemas/policies.ts)
SAM add_policy (orchestrator)     apps/api/src/durable-objects/sam-session/tools/add-policy.ts
   ↓
service layer                     apps/api/src/services/project-data-policies.ts
   ↓
DO class methods                  apps/api/src/durable-objects/project-data/index.ts:1567-1620
   ↓
pure SQL functions                apps/api/src/durable-objects/project-data/policies.ts
   ↓
row parser                        apps/api/src/durable-objects/project-data/row-schemas/policies.ts
```

**Three writers, not two** (rule 44 / rule 61). The initial enumeration listed only the MCP and
REST callers and missed `sam-session/tools/add-policy.ts` — the SAM orchestrator's own
`add_policy` tool, which calls `projectDataService.createPolicy` directly. Left unfixed, every
policy created from an orchestrator surface would have been permanently non-expiring: the exact
failure mode this feature exists to remove, reintroduced through the one door nobody counted. It
was caught in specialist review and now calls the same shared `validatePolicyLifecycle`.

The complete writer set was re-derived from `grep -rl project_policies` (only `migrations.ts` and
`project-data/policies.ts` touch the table by name — no raw-SQL bypass exists) plus every caller
of `createPolicy(` / `updatePolicy(`: 3 create callers and 2 update callers, all funnelling
through the service layer into the DO choke point, which re-checks the invariant against
freshly-read state immediately before the write.

Consumers of the parsed row: `instruction-tools.ts` (agent injection),
`apps/web/src/lib/api/policies.ts` + `AgentContextPage/PoliciesTab.tsx` (UI),
shared types in `packages/shared/src/types/policy.ts`.

### Test infrastructure

`apps/api/tests/workers/policy-do.test.ts` runs under `@cloudflare/vitest-pool-workers` — real
workerd, real DO SQLite, real migrations. That **is** the "real SQL engine" rule 28 requires; the
expiry predicate tests belong there, not in a mock-based unit test whose `.where()` ignores its
arguments.

### Coordination (sibling tasks editing the same file)

- **R1** removes the duplicated `policyContext` array from `instruction-tools.ts`. My changes must
  not reintroduce it — I only touch `formatPolicyDirectives` and `buildPolicyInstructions`, plus the
  two extra fields on the entry `.map()`.
- **R3** changes knowledge selection in the same file — different function, should not conflict.
- Rebase on `origin/main` frequently.

## Design

Two additive columns, one of which is load-bearing for the other:

- `expires_at INTEGER` (nullable) — the **filter**. `NULL` means "never expires", which is exactly
  today's behavior, so all 81 existing rows are unaffected.
- `scope TEXT NOT NULL DEFAULT 'always'` — the **discriminator**, `'always' | 'task'`. Backfills to
  `'always'` for every existing row, preserving current behavior by construction.

`scope` is not a write-only field (rule 57): `scope = 'task'` **requires** `expires_at`, enforced at
the write boundary. That invariant is the actual mechanism that stops the "Codex 5.5 High Chat VMs
for the 2026-08-21 wave" class of policy from becoming permanent — an agent capturing a one-shot
constraint cannot mark it task-scoped without also giving it a shelf life. `scope` is also rendered
in the injected directives so an agent can see at a glance that a directive is temporary rather than
a permanent gate.

Filtering happens **at read time only** (rule 47 — no new sweep, cron, or alarm). The filter is
`active = 1 AND (expires_at IS NULL OR expires_at > ?)`, evaluated against `Date.now()`. With a cap
of 100 rows per project the existing partial index is sufficient; no new index, no extra I/O
round-trip (rule 60).

New configurable limit (Principle XI): `POLICY_MAX_EXPIRY_MS` / `DEFAULT_POLICY_MAX_EXPIRY_MS`
(365 days) bounds how far in the future an expiry may be set.

## Implementation checklist

### Shared types & constants
- [x] `packages/shared/src/types/policy.ts`: `POLICY_SCOPES = ['always','task']`, `PolicyScope`,
      `isPolicyScope`; `scope` + `expiresAt` on `ProjectPolicy`, `CreatePolicyRequest`,
      `UpdatePolicyRequest`
- [x] `packages/shared/src/constants/policies.ts`: `DEFAULT_POLICY_MAX_EXPIRY_MS`, `maxExpiryMs`
      threaded through `PolicyLimits` / `resolvePolicyLimits`
- [x] Single shared write-boundary validator `validatePolicyLifecycle({ scope, expiresAt, now,
      maxExpiryMs })` used by **both** MCP and REST (rule 24 — one implementation per operation)
- [x] New symbols exported from `types/index.ts` / `constants/index.ts`

### Durable Object
- [x] Migration `034-policy-lifecycle-controls`: two `ALTER TABLE ... ADD COLUMN` statements. No
      table recreation, no `DROP` (rules 31/63 — DO SQLite has no time-travel recovery)
- [x] `row-schemas/policies.ts`: parses `expires_at` / `scope`, exposed as `expiresAt` / `scope`,
      tolerant of absence so a stale-schema row degrades to the defaults rather than throwing (rule 50)
- [x] `policies.ts:createPolicy` — persists `expiresAt`/`scope`; cap COUNT excludes expired
- [x] `policies.ts:updatePolicy` — explicit `!== undefined` check so `null` **clears** an expiry
      (the `?? existing` idiom cannot express "clear")
- [x] `policies.ts:getActivePolicies` — `(expires_at IS NULL OR expires_at > ?)` at read time
- [x] `project-data/index.ts` — new params threaded through the DO RPC methods
- [x] DO-level guard on the scope/expiry invariant in both `createPolicy` and `updatePolicy` — the
      choke point a future third writer cannot bypass (rules 44/51)

### API surface
- [x] `services/project-data-policies.ts` — threaded through
- [x] MCP `tool-definitions-policy-tools.ts` — `scope`/`expiresAt` on `add_policy` and
      `update_policy`, with descriptions telling an agent when to use them
- [x] MCP `policy-tools.ts` — validates via the shared helper; returns `scope`/`expiresAt`
- [x] REST `routes/policies.ts` + `schemas/policies.ts` — same fields, same shared validator
- [x] `instruction-tools.ts` — annotates expiring policies in `formatPolicyDirectives`; extends the
      capture instruction in `buildPolicyInstructions`. **Did not reintroduce `policyContext`** (R1):
      the diff is confined to the two formatting functions plus two fields on the existing entry map

### Web UI
- [x] `PoliciesTab.tsx` — `task-scoped` / `expired` badges and an Expires/Expired footer label.
      Display-only; editing an expiry goes through MCP/REST, and adding a date-picker would be an
      unrelated form change
- [x] Playwright visual audit, mobile 375 + desktop 1280, with overflow assertions (rule 17)

### Tests
- [x] `tests/workers/policy-do.test.ts` (real DO SQLite, real migration chain): expired excluded
      from `getActivePolicies`; unexpired included; **null-expiry unchanged**; expired still visible
      via `getPolicy` and `listPolicies`; cap COUNT excludes expired; `expiresAt` round-trips and
      can be cleared; pre-lifecycle rows default to `scope='always'` / `expires_at=NULL`
- [x] **Proved discriminating** (2026-08-23): with the expiry conjunct replaced by a tautology,
      exactly 2 tests went red ("excludes an expired policy…", "excludes expired policies from the
      per-project cap") and all 15 others — including the null-expiry control — stayed green.
      Conjunct restored, re-verified 17/17.
- [x] Unit tests for `validatePolicyLifecycle`: task-scope-without-expiry, past expiry, exact-now
      boundary, beyond-horizon, caller-supplied horizon, non-finite, fractional, unknown scope
- [x] MCP tool tests: schema advertises the fields; handler rejects `scope:'task'` with no expiry;
      update validated against the merged post-write state
- [x] REST route tests for the same, plus an I/O-budget test proving the extra read only happens
      when the update actually touches a lifecycle field
- [x] `get_instructions` tests asserting the annotation reaches the rendered directives, with a
      control proving standing policies stay unannotated

### Docs
- [x] Checked `apps/www/src/content/docs/docs/` — no public doc describes the policy field set, so
      there is no stale behavioral claim to correct
- [x] Registered `POLICY_MAX_EXPIRY_MS` in `apps/api/src/env.ts`, the canonical registry the other
      five `POLICY_*` vars live in (none of them appear in `.env.example`)

## Part 2 — production data cleanup (AFTER merge + production deploy)

Using SAM MCP policy tools in-session. `remove_policy` only — reversible deactivation, never a
destructive delete.

- [ ] Deactivate `d55af478-5234-4178-8f9c-47dfd5647de2` — "Use Codex 5.5 High Chat VMs for current
      reliability workflow" (2026-08-21 workstream, completed)
- [ ] Deactivate `1e946849-2a4e-4012-b063-898bf6f193e9` — "Commenting delivery root is
      coordination-only" (specific delivery, completed)
- [ ] Verify exact id via `list_policies`, then deactivate "Scheduler lifecycle test work is CI-only"
      (`f8bed08d-07e5-42cc…`)
- [ ] Audit remaining policies for (a) other one-shot policies tied to completed dated work and
      (b) near-verbatim duplicates of `.claude/rules` files
- [ ] A duplicate may be deactivated **only** after verifying the equivalent text exists in a repo
      rule **and**, where Codex-relevant, in the `AGENTS.md` guardrails table. **When in doubt, keep it.**
- [ ] Report every deactivated id + title + justification via `update_task_status` and in the PR

## Acceptance criteria

1. A policy with `expires_at` in the past is **not** returned by `getActivePolicies`, and therefore
   not injected into any agent session.
2. A policy with `expires_at` in the future **is** returned.
3. A policy with `expires_at = NULL` behaves exactly as today — verified by a control test that must
   stay green when the expiry conjunct is deleted.
4. Expired policies remain readable via `get_policy` and visible in `list_policies` / the UI.
5. `add_policy` and `update_policy` accept `scope` and `expiresAt`; `scope: 'task'` without an
   `expiresAt` is rejected at the write boundary in both MCP and REST.
6. The migration is additive only — no `DROP TABLE`, no table recreation, verified by
   `pnpm quality:do-migration-safety`.
7. The capture instruction in `get_instructions` tells agents to set an expiry for workflow-scoped
   policies.
8. The three named stale policies are deactivated in production, with the full deactivation list
   reported.

## References

- `.claude/rules/31-migration-safety.md` — additive migrations only
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md` — enumerate every query
- `.claude/rules/47-control-loop-io-budget.md` — read-time filter, no new sweep
- `.claude/rules/28-credential-resolution-fallback-tests.md` — predicate guards need a real SQL engine
- `.claude/rules/24-no-duplicate-ui-controls.md` / `59-understand-before-adding.md` — one validator
- `.claude/rules/57-write-only-cross-boundary-state.md` — `scope` must be consumed, not just stored
- `.claude/rules/07-env-and-urls.md` — append-only migration sequence
