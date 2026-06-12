# Named Credential Configurations — Architecture Proposal

**Status:** Design proposal (no implementation)
**Date:** 2026-06-12
**Task:** `01KTYA74H4SP61Q2E18BQYJKXC`

## Problem Statement

SAM currently allows **one active agent credential per `(userId, agentType, credentialKind)` tuple** per scope. A user cannot:

1. Keep two Claude Code API keys (e.g., for two Anthropic accounts/orgs) and choose between them
2. Run one agent profile on an API key and another profile on an OAuth subscription token *simultaneously* — the `isActive` toggle makes the choice global per agent type
3. Bind a specific credential to a specific agent profile, so that "the research profile bills org A, the production profile bills org B"

This proposal evolves credentials into **named credential configurations** that users create/delete freely and **pin to agent profiles**, while preserving the existing scope model (user-level and project-level) and the existing resolution chain as the default behavior.

All claims below cite the current code. Present tense = verified in code; "would/will" = proposed.

---

## 1. Current State (Verified)

### 1.1 Storage

`credentials` table (`apps/api/src/db/schema.ts:171-211`): `id`, `userId` (FK→users, CASCADE), `projectId` (nullable — project-scoped overrides), `provider`, `credentialType` (`'cloud-provider' | 'agent-api-key'`), `agentType` (nullable), `credentialKind` (`'api-key' | 'oauth-token'`), `isActive` (default true), `encryptedToken` + `iv` (AES-256-GCM via `services/encryption.ts`), ISO-8601 timestamps.

The one-per-kind limit is enforced by two **partial unique indexes**:

```
idx_credentials_user_agent_kind_user_scope     (user_id, agent_type, credential_kind)             WHERE credential_type='agent-api-key' AND project_id IS NULL
idx_credentials_user_agent_kind_project_scope  (user_id, project_id, agent_type, credential_kind) WHERE credential_type='agent-api-key' AND project_id IS NOT NULL
```

`isActive` means "this kind is the selected one for this agent type in this scope." `POST /api/credentials/agent/:agentType/toggle` and `PUT /api/credentials/agent` (with `autoActivate`) flip it atomically via D1 `batch()` (deactivate-all-then-activate — `routes/credentials.ts`).

### 1.2 Resolution

`getDecryptedAgentKey(db, userId, agentType, encryptionKey, projectId?)` (`routes/credentials.ts`) resolves:

1. **Project-scoped row** for `(userId, projectId, agentType)` — if a row exists but is **inactive, resolution returns `null` and refuses to fall through** (security invariant: no silent scope crossing; see `.claude/rules/28-credential-resolution-fallback-tests.md`)
2. **User-scoped active row** (`project_id IS NULL AND is_active=1`)
3. **Platform credential** via `getPlatformAgentCredential()`

Its **only caller** is `POST /workspaces/:id/agent-key` (`routes/workspaces/runtime.ts:201-520`, VM-agent callback auth), which then chooses an injection path:

- User API key → **passthrough proxy** URL (`/ai/proxy/{wstoken}/anthropic`)
- OAuth token (`credentialKind='oauth-token'`) → **direct injection** (`CLAUDE_CODE_OAUTH_TOKEN`), no proxy
- No credential + `agentSettings.providerMode === 'sam'` → **platform proxy** (`__platform_proxy__` sentinel)
- Otherwise → 404

It records `tasks.agentCredentialSource` (`'user' | 'platform'`, `schema.ts:586`).

### 1.3 Profiles

`agentProfiles` (`schema.ts:886-938`) has **no credential reference**. Profiles are user-level (`projectId IS NULL`) or project-level. Skills (`schema.ts:943-987`) are a profile-override layer sharing base columns through `services/profile-fields.ts` mappers; `skills.defaultProfileId` uses `ON DELETE SET NULL` — the existing precedent for soft pin references.

Critically, the boot-time hook already exists: **`workspaces.agentProfileHint`** (`schema.ts:761`) stores the profile ID used for the workspace's task, and `resolveWorkspaceGitHubTokenOptions()` (`services/github-cli-policy.ts:91-120`) already reads `workspace → agentProfileHint → agentProfiles` row to apply per-profile policy at runtime. Credential pinning reuses this exact pattern.

### 1.4 UI

Settings → Agents renders one `AgentCard` per agent type (`apps/web/src/components/AgentsSection.tsx`), combining the credential form (`AgentKeyCard.tsx`) and agent settings. The card shows at most one API-key credential and one OAuth credential per agent, with an active/inactive toggle.

---

## 2. Data Model Changes

### 2.1 Design choice: extend `credentials`, don't add a table

Two options were considered:

| Option | Pros | Cons |
|--------|------|------|
| **A. Add `name` to `credentials`, relax unique indexes** | Additive `ALTER TABLE`; zero data movement; encryption columns, scope columns, and all decrypt paths untouched | Index swap needed |
| B. New `agent_credential_configs` table | Clean slate | Requires copying encrypted rows (data-migration risk on the most sensitive table in the system); duplicate resolution code during transition |

**Recommendation: Option A.** It is fully additive (compliant with `.claude/rules/31-migration-safety.md` — no `DROP TABLE`, no row deletion), and `DROP INDEX`/`CREATE INDEX` carry no data-loss risk.

### 2.2 Schema changes

```sql
-- 0071_named_agent_credentials.sql (next number after 0070_agent_effort.sql)

-- 1. Name column (nullable for cloud-provider rows, required by app logic for agent rows)
ALTER TABLE credentials ADD COLUMN name TEXT;

-- 2. Backfill names for existing agent credentials (one row per kind exists today,
--    so this is collision-free under the new uniqueness rule)
UPDATE credentials
SET name = CASE credential_kind
  WHEN 'oauth-token' THEN 'OAuth (subscription)'
  ELSE 'API key'
END
WHERE credential_type = 'agent-api-key' AND name IS NULL;

-- 3. Defensive normalization: guarantee at most one active (default) row per
--    (user, agent, scope) before creating the default-uniqueness index. App logic
--    already maintains this invariant (atomic batch toggle), this is belt-and-braces.
UPDATE credentials SET is_active = 0
WHERE credential_type = 'agent-api-key' AND is_active = 1
  AND id NOT IN (
    SELECT id FROM credentials c2
    WHERE c2.credential_type = 'agent-api-key' AND c2.is_active = 1
    GROUP BY c2.user_id, c2.agent_type, COALESCE(c2.project_id, '')
    HAVING c2.id = MAX(c2.id)
  );

-- 4. Swap uniqueness: per-kind limit → per-name limit
DROP INDEX IF EXISTS idx_credentials_user_agent_kind_user_scope;
DROP INDEX IF EXISTS idx_credentials_user_agent_kind_project_scope;

CREATE UNIQUE INDEX idx_credentials_agent_name_user_scope
  ON credentials (user_id, agent_type, name)
  WHERE credential_type = 'agent-api-key' AND project_id IS NULL;

CREATE UNIQUE INDEX idx_credentials_agent_name_project_scope
  ON credentials (user_id, project_id, agent_type, name)
  WHERE credential_type = 'agent-api-key' AND project_id IS NOT NULL;

-- 5. "Default" uniqueness: at most one active row per (user, agent, scope).
--    is_active is REDEFINED from "selected kind" to "default credential for this
--    agent in this scope" (see §4.1).
CREATE UNIQUE INDEX idx_credentials_agent_default_user_scope
  ON credentials (user_id, agent_type)
  WHERE credential_type = 'agent-api-key' AND project_id IS NULL AND is_active = 1;

CREATE UNIQUE INDEX idx_credentials_agent_default_project_scope
  ON credentials (user_id, project_id, agent_type)
  WHERE credential_type = 'agent-api-key' AND project_id IS NOT NULL AND is_active = 1;

-- 6. Profile pinning (skills get the same column — they are the profile-override layer)
ALTER TABLE agent_profiles ADD COLUMN credential_id TEXT
  REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE skills ADD COLUMN credential_id TEXT
  REFERENCES credentials(id) ON DELETE SET NULL;
```

Notes:

- **Partial unique indexes cannot be expressed by Drizzle** for the `WHERE ... IS NULL` scope split; per the existing convention (see the `0028_agent_profiles.sql` comment pattern in `schema.ts`), they live in raw SQL with documenting comments on the Drizzle table definition.
- `ON DELETE SET NULL` follows the `skills.defaultProfileId` precedent: deleting a credential never breaks a profile, it reverts it to chain resolution (§6.1).
- Migration-safety compliance: no `DROP TABLE`, no `DELETE`, the two `UPDATE`s have `WHERE` clauses, index operations are loss-free. `credentials` is not a CASCADE parent of any table (the new FKs are `SET NULL`).
- Name uniqueness is scoped **per `(user, agentType)`**, not globally — "Work account" can exist for both Claude Code and Codex. Profiles reference credentials by `id`, so names are purely display/disambiguation.

### 2.3 Drizzle schema additions

- `credentials.name: text('name')` + comments documenting the four raw-SQL partial unique indexes
- `agentProfiles.credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'set null' })`
- `skills.credentialId` — same

`credentialId` should **not** go into the shared `BaseProfileFieldKeys` mapper plumbing blindly — but since skills override profiles field-by-field and a skill plausibly wants its own billing identity, the cleanest integration is to add it to `profile-fields.ts` (`BaseProfileFieldKeys`, `toBaseProfileFields`, `baseProfileInsertValues`, `applyBaseProfileUpdates`) so both entities get it for free, mirroring how `vmSizeOverride`/`provider` flow today. Skill→profile override semantics: skill's `credentialId` wins when set, else profile's, else chain (consistent with the skill → profile → project → platform layering).

---

## 3. API Changes

All under the existing `routes/credentials.ts` mount (`/api/credentials`), session-cookie auth, same rate limits as the current agent-credential endpoints.

### 3.1 Named credential CRUD

| Endpoint | Behavior |
|----------|----------|
| `GET /api/credentials/agent` | **Unchanged shape, more rows.** Each item gains `id` and `name`. Masking behavior (last-4 for API keys, "Pro/Max Subscription" label for OAuth) unchanged. |
| `POST /api/credentials/agent` | **New: create** a named credential. Body: `{ agentType, credentialKind, name, token, projectId?, makeDefault? }`. Validates token (existing `/agent/validate` logic), encrypts, inserts. `makeDefault` runs the existing atomic D1 batch (deactivate scope siblings + activate). 409 on duplicate name in scope. |
| `PATCH /api/credentials/agent/:credentialId` | **New: update** — rename (`name`), rotate secret (`token`, re-validated and re-encrypted), no kind/agentType changes (create a new credential instead). Ownership check: `row.userId === caller` (defence-in-depth per rule 28). |
| `POST /api/credentials/agent/:credentialId/set-default` | **New:** atomic batch — deactivate all rows in the same `(userId, agentType, scope)`, activate this one. Replaces the kind-toggle as the canonical "choose default" operation. |
| `DELETE /api/credentials/agent/:credentialId` | **New: delete by id.** If the deleted row was the default, auto-promote the most recently updated remaining credential in scope (preserves today's behavior in `DELETE /agent/:agentType/:credentialKind`). Response includes `affectedProfiles: [{id, name}]` so the UI can warn (FK has already set their `credential_id` to NULL). |

### 3.2 Legacy endpoints (kept during transition, then removed)

This project is pre-production with a no-dead-code rule, so legacy surface is minimized:

- `PUT /api/credentials/agent` (upsert by kind) — **rewritten internally** as "upsert the credential named by the auto-generated backfill name for that kind"; existing UI and onboarding wizard (`ChoosePathWizard`) keep working unmodified until the UI ships, then this becomes the simple-path alias or is removed alongside the UI change in the same PR.
- `POST /agent/:agentType/toggle` and `DELETE /agent/:agentType/:credentialKind` — removed in the same PR that updates the UI to id-based operations.

### 3.3 Profile assignment

- `CreateAgentProfileRequest` / `UpdateAgentProfileRequest` (`packages/shared/src/types/agent-settings.ts`) gain `credentialId?: string | null` (null = unpin).
- `routes/agent-profiles.ts` POST/PATCH validate on write:
  1. credential exists and `credential.userId === caller` (404 otherwise — don't leak existence)
  2. `credential.credentialType === 'agent-api-key'` and `credential.agentType === profile.agentType` (400 on mismatch; re-validated when `agentType` itself changes)
  3. scope compatibility: credential is user-scoped, **or** `credential.projectId === profile.projectId` (a project-scoped credential cannot be pinned to a global profile or another project's profile)
- `AgentProfile` / `ResolvedAgentProfile` / `AgentSkill` response types gain `credentialId: string | null` and (resolved only) `credentialName: string | null` for display.
- Same fields on the skills routes (`/api/projects/:projectId/skills`).

---

## 4. Resolution Logic Changes

### 4.1 Redefining `isActive`

Today `isActive` means "the selected kind for this agent type." Under named credentials it is **redefined as "the default credential for this `(user, agentType, scope)`"** — the one the chain picks when no profile pins one. Exactly-one-default is enforced by the new partial unique indexes (§2.2 step 5).

This redefinition is behavior-preserving: the currently-active row simply becomes the default, and users who never touch profiles see identical resolution.

The security invariant from rule 28 is **kept verbatim**: an existing-but-inactive *project-scoped* row still blocks fallback to user scope in chain resolution.

### 4.2 New resolution order

`getDecryptedAgentKey()` grows a wrapper (or an options argument) — proposed signature:

```ts
resolveAgentCredential(db, {
  userId,          // workspace.userId — the runtime identity
  agentType,
  projectId,       // workspace.projectId
  profileId,       // workspace.agentProfileHint (may be null)
  encryptionKey,
}): Promise<{ credential, credentialKind, credentialSource } | null>
```

Resolution:

1. **Profile pin** — if `profileId` is set: load the profile row (and, when the workspace was dispatched via a skill, the skill row first — skill `credentialId` overrides profile `credentialId`). If a `credentialId` is pinned:
   - Load the credential row. Guards (each falls through to step 2 with a structured log, per rule 11 fail-fast logging — `workspaceId`, `profileId`, `credentialId`, reason):
     - row missing (deleted between SET NULL races) → fall through
     - `credential.userId !== userId` → **fall through, never use** (see §6.4 — multi-user projects)
     - `credential.agentType !== agentType` → fall through (stale pin after profile agent change)
     - `credential.projectId` set and ≠ `projectId` → fall through
   - Pinned credentials are used **regardless of `isActive`** — `isActive` now only marks the scope default, and a pin is a more explicit selection than the default flag (§6.2).
   - `credentialSource: 'profile'`
2. **Project-scoped default** — unchanged, including the inactive-row-blocks-fallback rule. `credentialSource: 'user'`
3. **User-scoped default** (`is_active = 1`) — unchanged. `credentialSource: 'user'`
4. **Platform** — unchanged. `credentialSource: 'platform'`

### 4.3 Boot flow (`POST /workspaces/:id/agent-key`)

`runtime.ts` already loads the workspace row for `userId`/`projectId`. It additionally reads `workspace.agentProfileHint` — **zero new plumbing**, this is exactly the pattern `resolveWorkspaceGitHubTokenOptions()` uses today (`github-cli-policy.ts:91-120`). The endpoint passes it into `resolveAgentCredential()`.

Injection-path selection is unchanged in structure but now driven by the **resolved row's `credentialKind`**:

- Pinned/default `api-key` → passthrough proxy (as today)
- Pinned/default `oauth-token` → direct OAuth injection (as today)
- Nothing resolved + `providerMode === 'sam'` → platform proxy (as today)

Consequence worth stating explicitly: a profile pin **overrides `agentSettings.providerMode`** for the kind decision. `providerMode` remains the per-user per-agent default for the unpinned path (and the only way to opt into `sam` mode — pins never select the platform proxy).

`tasks.agentCredentialSource` gains the value `'profile'` (currently `'user' | 'platform'`). Optionally a soft `tasks.agent_credential_id` column for audit; recommended but not required for v1.

### 4.4 Required tests (per rule 28)

The full fallback matrix is mandatory, now including the pin tier:

- pinned + valid → used (and `isActive=0` pinned row still used)
- pinned + deleted/missing → chain fallback, source logged
- pinned + wrong user / wrong agentType / wrong project → chain fallback (the wrong-user case must be constructed with a DB stub returning a mismatched row — no tautological mocks)
- no pin + active project row → project row; **inactive project row → null, no fallback** (regression-protect the existing invariant)
- no pin + user default → user row; none → platform → null
- skill pin overrides profile pin
- mismatch responses never include the stored token

---

## 5. UX Flow

### 5.1 Settings → Agents (user scope)

`AgentCard` evolves from "one API-key slot + one OAuth slot with a toggle" to a **credential list per agent**:

```
Claude Code
├─ Credentials
│  ├─ ● Work account (API key ····x4F2)   [Default]   ⋯ (set default / rename / rotate / delete)
│  ├─ ○ Personal Max (OAuth — Pro/Max Subscription)   ⋯
│  └─ [+ Add credential]  → name, kind (API key / OAuth setup-token), secret, validate-on-save
└─ Configuration (model, permission mode, provider mode, …) — unchanged
```

- The Default badge replaces the kind toggle; "set default" calls `set-default`.
- Delete shows the `affectedProfiles` warning from the API: "2 profiles pin this credential and will revert to your default."
- The onboarding wizard (`ChoosePathWizard`) is untouched in v1 — it creates the auto-named credential via the legacy `PUT` path, which now lands as a named credential.

### 5.2 Project settings (project scope)

The existing project-scoped credential override section gets the same list treatment, scoped to the project. No new IA — per project policy, agent control surfaces stay project-scoped, no new top-level nav.

### 5.3 Profile editor (user-level and project-level profiles, and skills)

One new field in the existing profile form, next to the Agent type selector:

```
Credential:  [ Default (use my credential settings) ▾ ]
               Default (use my credential settings)
               ── Claude Code credentials ──
               Work account (API key ····x4F2)
               Personal Max (OAuth)
```

- Options are filtered to the profile's `agentType` and to scope-compatible credentials (user-scoped + this project's, for project profiles).
- When the pinned credential no longer exists, the form shows an inline warning ("Previously pinned credential was deleted — using default") since the FK has nulled the column.
- Per the one-control-per-field rule (`.claude/rules/24-no-duplicate-ui-controls.md`), this dropdown is the **only** place `credentialId` is edited.

### 5.4 Visibility at dispatch/run time

The task detail / chat session header already surfaces the resolved profile; `ResolvedAgentProfile.credentialName` lets it show "billing as: Work account" without an extra fetch. (Nice-to-have, not v1-blocking.)

---

## 6. Edge Cases

### 6.1 Pinned credential deleted

`ON DELETE SET NULL` reverts the profile/skill to chain resolution atomically at the DB layer — no broken references, no 500s mid-boot. The delete API returns `affectedProfiles` for a pre-delete warning; resolution logs the fallback if a race slips through.

### 6.2 Pinned credential deactivated (`isActive = 0`)

`isActive` no longer means "enabled" — it means "scope default." A pinned credential is used regardless of its default flag, because the pin is a *more explicit* user choice than the default marker. There is deliberately **no separate "disabled" state** in v1: to take a credential out of service, delete it (profiles revert safely). If a true kill-switch is later needed, add a distinct `disabled` column rather than overloading `isActive` — and a disabled pinned credential should then **hard-fail the boot (404 'Agent credential')**, not silently fall back, mirroring the inactive-project-row philosophy: explicit deactivation must never silently route to another billing identity.

### 6.3 Profile with no credential pinned

`credentialId IS NULL` = exactly today's behavior: project → user → platform chain, `providerMode` honored. This is the migration default for all existing profiles, so **nothing changes for anyone until they pin**.

### 6.4 Multi-user projects: profile creator ≠ task runner

Project-level profiles are visible to all project members, but credentials are personal (`credential.userId`). If user B runs a task with a profile whose pin references user A's credential, the resolver's `credential.userId !== workspace.userId` guard **falls back to B's own chain** — A's secret is never injected into B's workspace. This is the most security-sensitive rule in this design and needs the rule-28-style mismatched-row test. The profile editor can show "(your credentials only)" copy; cross-member shared credentials are explicitly out of scope.

### 6.5 Profile agentType changed after pinning

Write-path validation rejects a mismatched pin in the same update; if the profile's `agentType` changes without touching `credentialId`, the update handler re-validates and nulls (or 400s — recommended: 400 with explicit message, forcing an intentional unpin). The resolver's agentType guard is the runtime backstop.

### 6.6 OAuth pin vs `providerMode`

A pinned `oauth-token` credential routes through direct OAuth injection even if `providerMode='user-api-key'`, and vice versa — the pin's `credentialKind` decides the path. `providerMode='sam'` is unaffected by pins (pins never select the platform proxy; SAM mode still requires explicit opt-in and applies only when nothing resolves from the user's credentials).

### 6.7 Duplicate names

Enforced unique per `(user, agentType, scope)` at the DB level; API returns 409 with a friendly message. The backfill cannot collide because today at most one row per kind exists per scope.

### 6.8 Platform credentials

Unaffected. Platform fallback has no name, is never pinnable, and keeps its existing never-inject-raw-into-tenant-containers handling in `runtime.ts`.

---

## 7. Backward Compatibility Summary

| Existing state | After migration |
|----------------|-----------------|
| One API-key credential, active | Becomes named credential "API key", remains scope default → identical resolution |
| API key + OAuth, OAuth active | Two named credentials; OAuth is default → identical resolution |
| Project-scoped override rows | Become named project-scoped credentials; inactive-blocks-fallback preserved |
| All existing profiles/skills | `credential_id = NULL` → chain resolution, identical behavior |
| `PUT /api/credentials/agent` clients (current UI, onboarding) | Keep working — upsert lands on the backfill-named credential for that kind |
| VM agent | **No changes** — `/agent-key` request/response contract is unchanged; only server-side resolution is extended |

Rollout order (each independently shippable): ① migration + schema + resolver with pin support (inert — nothing pins yet) → ② credential CRUD API + settings UI → ③ profile/skill pin field + editor UI. Staging verification per rule 13 must exercise an actual pinned-profile task boot, not just CRUD.

---

## 8. Out of Scope

- Sharing credentials between users / org-level credentials
- Pinning a *platform* credential or per-profile `sam`-mode selection
- Per-credential usage attribution in the AI proxy (the `wstoken` → workspace → task chain already identifies the run; per-credential rollups can be derived later from `tasks.agent_credential_id` if added)
- Cloud-provider (`credentialType='cloud-provider'`) credentials — naming applies only to agent credentials in v1, though the `name` column is table-wide and leaves the door open
