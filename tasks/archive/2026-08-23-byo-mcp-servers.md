# Bring-Your-Own MCP Servers (Phase 1)

**Created**: 2026-08-23
**Status**: Active
**Idea**: `01M0QDASJCK3YWVX1GETZTSFWZ`
**Prior art**: `tasks/backlog/2026-02-15-user-configurable-mcp-servers.md` (stale mechanism — predates the ACP `mcpServers` pipeline; this task supersedes it)

## Problem

Users want their agents to reach third-party services (Zapier, executor.sh, Composio/Rube,
Klavis, official Notion/Linear/Stripe/GitHub MCP endpoints). Building per-service OAuth
connectors is an orthogonal product and wasteful for SAM.

The cut: **SAM speaks MCP. The endpoint owns the OAuth.** Users do the OAuth dance in their
chosen provider's dashboard (a browser), and paste the resulting MCP endpoint (URL + optional
bearer token) into SAM. SAM stores `url + secret` encrypted and injects it next to `sam-mcp`
into every agent session. SAM never learns what LinkedIn is — no vendor dependency, and
self-hosters can point at a fully self-hosted gateway.

## Research Findings

### F1. The injection pipeline already exists but is single-valued

- `packages/shared/src/vm-agent-contract.ts:101-108` — `mcpServers` is already an **array**.
- But `McpServerConfig` (`apps/api/src/services/node-agent.ts:491-495`) is a single
  `{ url, token }`, and the array is literally constructed in only two places
  (`node-agent.ts:473`, `:536`), always length 1.
- **Action**: widen the plumbing from "one server" to "N servers". → checklist C3, C4.

### F2. `agent-session-bootstrap.ts` is the shared path for BOTH runtimes

`instant-session.ts:446` (cf-container) and `task-runner/agent-session-step.ts:76` (VM) both
call `startSamAwareAgentSession`. Injection added at `agent-session-bootstrap.ts:271/:329`
therefore satisfies rule 61 for both runtimes with one implementation.

Two **other** producers exist that do not go through the bootstrap:
- `apps/api/src/routes/workspaces/agent-sessions.ts:163-168` — manual workspace agent session.
- `apps/api/src/durable-objects/trial-orchestrator/steps.ts:763` — anonymous trial.

**Action**: enumerate all four in the PR (rule 61 req. 2). Inject in the bootstrap AND the
manual route. **Deliberately exclude the trial path** — it runs as the anonymous sentinel
user (`resolveAnonymousUserId`), which owns no connections; injecting there would be a
cross-tenant leak. Assert the exclusion with a test. → checklist C5, C6, T6.

### F3. NAMING COLLISION — "Connections" is already taken

`apps/web/src/pages/SettingsConnections.tsx` and
`apps/web/src/components/project-settings/ProjectConnectionsSection.tsx` are the
**composable-credentials** surface (LLM provider + cloud provider credentials). The idea
proposed calling this feature "Connections"; that would collide head-on (rule 24).

**Decision**: name the feature **MCP Servers** throughout — matches the vocabulary users
already know from Claude Code / Codex / Cursor. → checklist C10.

### F4. Codex hard-fails when ANY injected MCP server has no token

`packages/vm-agent/internal/acp/session_host_startup.go:446-457` aborts Codex startup with
`"mcp server %d is missing its bearer token"` if any entry has a blank token. A no-auth
connection (Composio pre-signed URLs put the credential *in the URL*) would therefore break
every Codex session.

Meanwhile `generateCodexMcpConfig` (`gateway.go:1257-1296`), `buildAcpMcpServers`
(`session_host.go:74-104`), `buildAmpMcpServer` (`:113-135`) and `generateVibeConfig`
(`gateway.go:1392-1400`) **already** handle `Token == ""` correctly by omitting auth.

**Action**: relax the precondition to require a token only for the SAM MCP server itself
(identified by name), not for user connections. → checklist C13, T9.

### F5. Three copies of the server-naming rule, and they already disagree

- `internal/acp/session_host.go:106-111` `mcpServerName` → `sam-mcp` when N==1, else `sam-mcp-%d`
- `internal/acp/gateway.go:1075-1080` `codexMcpServerName` → same rule, re-implemented
- `internal/acp/gateway.go:1395` inline → **always** `sam-mcp-%d`, so N==1 yields `sam-mcp-0`

All are positional; nothing in the payload influences the name. With N servers the agent sees
`sam-mcp-0__create_post` and cannot tell Zapier from Notion.

**Action**: add `Name` to the entry, consolidate into ONE resolver used by all three call
sites, preferring `entry.Name` and falling back to the legacy index scheme. Fixing the Vibe
N==1 inconsistency is a deliberate side effect. → checklist C12.

### F6. New entry fields are silently dropped at three field-by-field conversions

`normalizeMcpServers` (`internal/server/workspaces.go:1078-1095`) rebuilds the struct field by
field; `registerSessionMcpServers` (`:1114-1116`) converts acp→persistence; `agent_ws.go:233`
converts persistence→acp. A new field added to the struct but not to all three is dropped with
no error. → checklist C11, C14, T8.

### F7. Encryption + scoping patterns to mirror exactly

- `encrypt/decrypt` — `apps/api/src/services/encryption.ts:33-92`, AES-256-GCM, returns
  `{ ciphertext, iv }` as two columns. Key via `getCredentialEncryptionKey(env)`
  (`apps/api/src/lib/secrets.ts:24-26`), NOT `env.ENCRYPTION_KEY` directly.
- Partial-unique-index idiom for nullable project scope — `0063_skills.sql:26-32`.
- Route auth — `requireProjectRuntimeAuthorization` + `secret:write` for writes,
  `project:read` for reads (`apps/api/src/routes/skill-runtime.ts:100-110`).
  Note `maintainer` has `secret:read` but NOT `secret:write`.
- Next migration number: `0120_` (0119 is already triple-used).

### F8. The URL is itself a secret

Composio Tool Router and several providers issue **pre-signed MCP URLs** with the credential
embedded in the path/query. Storing the URL in plaintext would leak the credential.

**Action**: encrypt `url` as well as the token; never return either from the API — return a
masked host-only display value. → checklist C1, C2, T3.

### F9. Row-level fault isolation is required (rule 50)

Resolution runs on the agent-session start path. One undecryptable or malformed connection row
must skip-and-warn, not throw — otherwise a single bad row bricks every session start for that
user/project. This is exactly the class in `.claude/rules/41` and `.claude/rules/50`.
→ checklist C7, T4.

### F10. Rollout is safe by construction

`VM_AGENT_REQUIRED_VERSION` is generated from the deploy SHA
(`.github/workflows/deploy-reusable.yml:378`), so after deploy only nodes running the new agent
receive new work (rule 54). The contract change is additive (`name` optional, unknown JSON
fields ignored by Go), so old agent + new control plane still works — it just falls back to
index naming. The one exception is F4 (no-auth + Codex on an old agent), which the version gate
already prevents. → documented in the PR.

### Scope decisions for v1 (deferrals tracked in the idea, per rule 42)

| Deferred | Why |
|---|---|
| **Custom auth headers** (`X-API-Key`, …) | Codex's `bearer_token_env_var` is bearer-only; an arbitrary-header Codex config key cannot be verified without a live Codex session (rule 30). `bearer` + `none` covers Zapier, executor, Klavis, official service MCPs, and Composio pre-signed URLs. |
| **Profile/skill attachment** | Would require threading `agentProfileId`/`skillId` through `TaskRunConfig` (which has no `skillId` field at all) and 2 join tables + 2 UI pickers. User+project scope already covers every session and every entry point. Purely additive later — the resolver signature is designed to take the extra scopes. |
| **stdio servers** | Arbitrary command config from a web UI is an unnecessary RCE surface. All serious platforms are remote-first. |
| **OAuth broker, tool allowlists, call audit** | Only if demand appears. |

## Implementation Checklist

### Storage & types
- [ ] C1. `apps/api/src/db/schema.ts` — `mcpConnections` table: `id`, `userId` (FK users cascade),
      `projectId` (nullable FK projects cascade; NULL = personal), `name`, `encryptedUrl`, `urlIv`,
      `authType` ('none'|'bearer'), `encryptedToken` (nullable), `tokenIv` (nullable), `enabled`,
      `createdAt`, `updatedAt`. Partial unique indexes on `(projectId,name) WHERE projectId IS NOT NULL`
      and `(userId,name) WHERE projectId IS NULL`. Export `$inferSelect`/`$inferInsert` types.
- [ ] C2. `apps/api/src/db/migrations/0120_mcp_connections.sql` — additive `CREATE TABLE` + indexes
      only. No DROP/ALTER of existing tables (rule 31).
- [ ] C3. `packages/shared/src/types/mcp-connection.ts` + barrel export — wire types, masked
      display shape, `MCP_CONNECTION_AUTH_TYPES`, name charset constant.
- [ ] C4. `packages/shared/src/vm-agent-contract.ts` — add optional `name` to the `mcpServers`
      entry schema. Keep `token` a required string (empty means no auth) for old-agent compat.

### Control plane
- [ ] C5. `apps/api/src/services/mcp-connections.ts` — CRUD (create/list/update/delete) with
      encryption, limit guard, name validation, ownership checks.
- [ ] C6. `apps/api/src/services/mcp-connection-resolution.ts` — `resolveMcpServersForSession`
      returning decrypted enabled connections; project entries override user entries by name;
      per-row try/catch skip-and-warn (F9). Signature accepts optional profile/skill scopes for
      future extension.
- [ ] C7. `apps/api/src/services/node-agent.ts` — change `McpServerConfig` plumbing from a single
      object to an array end to end (`createAgentSessionOnNode`, `startAgentSessionOnNode`).
- [ ] C8. `apps/api/src/services/agent-session-bootstrap.ts:271,:329` — build
      `[samMcpEntry, ...resolvedConnections]`. sam-mcp keeps the reserved name `sam-mcp`.
- [ ] C9. `apps/api/src/routes/workspaces/agent-sessions.ts:163` — same resolution for the manual
      workspace path.
- [ ] C10. Routes: `apps/api/src/routes/mcp-connections.ts` (user scope, `/api/mcp-connections`) and
      project scope mounted at `/api/projects/:projectId/mcp-connections`. Valibot schemas in
      `apps/api/src/schemas/`. Reads never return url or token. Mount in `index.ts`.
- [ ] C11. `apps/api/src/services/limits.ts` + `env.ts` — `MAX_MCP_CONNECTIONS_PER_SCOPE`,
      `MCP_CONNECTION_URL_MAX_BYTES`, `MCP_CONNECTION_TOKEN_MAX_BYTES` with `DEFAULT_*` constants
      (Principle XI).

### VM agent (Go)
- [ ] C12. `internal/acp/gateway.go` — add `Name` to `McpServerEntry`.
- [ ] C13. `internal/persistence/store.go` — add `Name` to `McpServer`, `migrateV12`
      (`ALTER TABLE session_mcp_servers ADD COLUMN name TEXT NOT NULL DEFAULT ''`), update
      INSERT/SELECT column lists.
- [ ] C14. Copy `Name` through all three field-by-field conversions (F6): `normalizeMcpServers`,
      `registerSessionMcpServers`, `agent_ws.go` prefetch.
- [ ] C15. `normalizeMcpServers` — validate name charset/length; keep existing HTTPS/localhost URL
      validation.
- [ ] C16. Consolidate the three naming implementations (F5) into one resolver preferring
      `entry.Name`; use it in `buildAcpMcpServers`, `generateCodexMcpConfig`, `generateVibeConfig`.
- [ ] C17. `codexMcpTokenEnvVar` — derive from the resolved name, sanitized and uniquified, keeping
      the `_TOKEN` suffix so `isSecretEnvVar` still classifies it as secret
      (`internal/acp/process.go:104`).
- [ ] C18. `session_host_startup.go:446-457` — require a bearer token only for the reserved
      `sam-mcp` server, not for user connections (F4).

### Web UI
- [ ] C19. `apps/web/src/lib/api/mcp-connections.ts` + barrel export.
- [ ] C20. `apps/web/src/pages/SettingsMcpServers.tsx` (user scope) + `React.lazy` route in
      `App.tsx` + Settings tab entry. TanStack Query, not hand-rolled loaders (rule 60/48).
- [ ] C21. `apps/web/src/components/project-settings/ProjectMcpServersSection.tsx` (project scope).
- [ ] C22. Shared `McpServersManager` component so user and project scopes are one implementation
      (rule 24/59).

### Tests
- [ ] T1. Unit: CRUD service — create/list/update/delete, name uniqueness per scope, limit guard.
- [ ] T2. Unit: resolution — project overrides user by name; disabled excluded; empty scopes.
- [ ] T3. Unit: url + token are encrypted at rest and never returned by any read path.
- [ ] T4. Unit: row fault isolation — good/bad/good rows resolve to the two good ones; all-bad
      returns empty, never throws. Proven discriminating against the pre-fix mapping (rule 50).
- [ ] T5. Integration (vertical slice): **mock MCP server harness** — an in-process JSON-RPC
      streamable-HTTP MCP server (`initialize`, `tools/list`, `tools/call`). Seed a connection
      pointing at it, drive a real agent-session start through the bootstrap, and assert the exact
      `mcpServers` payload in the outbound vm-agent request body (name, url, token). Assert the
      mock server receives and authorizes a real request with the bearer token.
- [ ] T6. Integration: cross-tenant + trial exclusion — another user's connections are never
      injected; the trial path injects only `sam-mcp`. Proven discriminating.
- [ ] T7. Route tests: authz matrix — non-member 404, viewer read-only, maintainer cannot write
      (no `secret:write`), owner/admin can. Real SQL engine via `createSqliteD1` (rule 28).
- [ ] T8. Go: `Name` survives normalize → register → SQLite → restart-prefetch round trip (F6).
      Must fail if any one conversion drops the field.
- [ ] T9. Go: Codex startup succeeds with a tokenless user connection present, and still fails when
      the reserved `sam-mcp` entry has no token (F4, discriminating control).
- [ ] T10. Go: naming — `entry.Name` wins for ACP, Codex TOML and Vibe TOML; legacy index fallback
      preserved when `Name` is empty.
- [ ] T11. Cross-boundary contract tests updated (`apps/api/tests/unit/vm-agent-cross-boundary-contract.test.ts`,
      `node-agent-contract.test.ts`) and the vm-agent source-contract test
      (`internal/server/agent_sessions_test.go:17`).
- [ ] T12. Playwright visual audit — mobile 375 + desktop 1280, normal/long-text/empty/many/error
      scenarios, overflow assertions via `assertNoOverflow` (rules 17, 56).

### Docs
- [ ] D1. `apps/www/src/content/docs/docs/guides/mcp-servers.md` — what an MCP endpoint is, provider
      recommendations (executor.sh, Zapier MCP, Composio/Rube, Klavis, official service MCPs), the
      "do the OAuth in their dashboard" flow, scope semantics, and the security warning that
      third-party tools are a prompt-injection surface.
- [ ] D2. CLAUDE.md "Recent Changes" entry.

## Acceptance Criteria

1. A user can add, edit, enable/disable and delete an MCP server at **user** scope from
   Settings, and at **project** scope from Project Settings. (T1, T7, T12)
2. Neither the URL nor the token is ever returned by any read endpoint; both are encrypted at
   rest. (T3)
3. An enabled connection is injected into agent sessions on **both** the VM and cf-container
   runtimes, alongside `sam-mcp`, with its user-chosen name. (T5)
4. A project-scoped connection overrides a user-scoped one with the same name; disabled
   connections are never injected. (T2)
5. Another user's connections are never injected, and the anonymous trial path receives only
   `sam-mcp`. (T6)
6. A single malformed/undecryptable connection row does not break agent-session start. (T4)
7. Codex sessions start successfully when a tokenless (no-auth) connection is present, and still
   fail closed when the reserved `sam-mcp` entry lacks its token. (T9)
8. The user-chosen name reaches the agent for Claude Code (ACP), Codex (config.toml), Vibe
   (config.toml) and Amp (mcp-remote), and survives a vm-agent restart. (T8, T10)
9. Staging: CRUD works in the live app, and a real agent session is observed carrying the
   connection (vm-agent logs / agent tool listing) against a reachable mock MCP server.

## References

- Idea `01M0QDASJCK3YWVX1GETZTSFWZ` (provider landscape, LinkedIn/Medium reality checks)
- `.claude/rules/61-guards-must-cover-every-runtime.md` — enumerate every runtime (F2)
- `.claude/rules/54-vm-agent-rollout-compatibility.md` — additive contract, version gate (F10)
- `.claude/rules/50-list-read-row-fault-isolation.md` + `41` — per-row isolation (F9)
- `.claude/rules/24-no-duplicate-ui-controls.md` + `59` — naming collision, one implementation (F3)
- `.claude/rules/28-credential-resolution-fallback-tests.md` — authz tests on a real SQL engine (T7)
- `.claude/rules/31-migration-safety.md` — additive migration only (C2)
- `.claude/rules/42-no-untracked-degrading-placeholders.md` — deferrals tracked in the idea
