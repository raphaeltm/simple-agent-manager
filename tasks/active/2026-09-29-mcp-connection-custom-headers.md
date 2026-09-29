# Custom HTTP Headers for Bring-Your-Own MCP Servers

## Problem

Bring-your-own MCP servers (`mcp_connections`, PR #1892) support only two auth shapes:
a bearer token (`Authorization: Bearer <token>`) or no auth, where the credential is
embedded in the URL. Composio's MCP endpoints now require a custom API-key header:
`x-api-key` for single-toolkit MCP, and `x-consumer-api-key` for Composio Connect. SAM
cannot express that today, and the public guide says so under Limitations: "Custom auth
headers (for example `X-API-Key`) are not yet supported."

Raphaël (2026-09-29): "I need to be able to add headers to MCP servers in SAM... Let's add
the ability to manage headers as well (composio requires this)."

SAM task: `01M3NTSE4PAGHVDJPKKZ0AZ2DH`. Idea: `01M0QDASJCK3YWVX1GETZTSFWZ` (BYO MCP; custom
headers were deferred there).

## Research Findings

### Current data path (verified)

- Shared types: `packages/shared/src/types/mcp-connection.ts`. Auth types are `['none','bearer']`.
  The API response omits url/token, returns `urlHost` + `hasToken`.
- D1: `mcp_connections` (`apps/api/src/db/schema.ts:2072`, migration `0120_mcp_connections.sql`).
  URL and token are AES-256-GCM encrypted.
- CRUD + validation: `apps/api/src/services/mcp-connections.ts` (367 lines).
  Valibot structural schemas: `apps/api/src/schemas/mcp-connections.ts`.
  Routes: `apps/api/src/routes/mcp-connections.ts` (personal + project scope, `secret:write`).
- Resolution at session start: `apps/api/src/services/mcp-connection-resolution.ts`.
  `toEntry` decrypts per row and skips + warns on failure (rules 41/50).
  `buildSessionMcpServers` is the single composition point. It is called from
  `agent-session-bootstrap.ts` (VM + cf-container) and `routes/workspaces/agent-sessions.ts`.
- Control plane → vm-agent: `apps/api/src/services/node-agent.ts` `McpServerConfig` +
  `serializeMcpServers` (single choke point), shared contract `McpServerEntrySchema` in
  `packages/shared/src/vm-agent-contract.ts`.
- vm-agent entry: `acp.McpServerEntry{URL,Token,Name}` (`internal/acp/gateway.go:297`). Three
  field-by-field copies:
  - `normalizeMcpServers` (`internal/server/workspaces.go:1219`), which rejects the WHOLE request
    on an invalid entry.
  - `registerSessionMcpServers` (acp → persistence).
  - agent_ws prefetch (persistence → acp, `internal/server/agent_ws.go:248`).
- Persistence: `session_mcp_servers` SQLite table (`internal/persistence/store.go`, migrateV5/V12),
  token stored in plaintext on the VM (existing behaviour).
- Per-harness injection:
  - ACP HTTP inline servers (Claude Code, Gemini, OpenCode…): `buildAcpMcpServers`
    (`internal/acp/session_host.go:76`). It already emits `[]acpsdk.HttpHeader`, but only
    `Authorization`.
  - Amp: `buildAmpMcpServer` bridges through `npx mcp-remote@0.1.38 <url> --header
Authorization:Bearer ${SAM_MCP_TOKEN}`, with the token in the stdio server env rather than argv.
  - Codex: `generateCodexMcpConfig` (`gateway.go:1393`) writes `[mcp_servers.<name>] url` +
    `bearer_token_env_var`, and exports env vars for docker exec.
  - Vibe: `generateVibeConfig` (`gateway.go:1481`) writes `headers = { Authorization = "Bearer …" }`.

### External constraints (verified 2026-09-29)

- **mcp-remote 0.1.38** (Amp bridge) parses `--header` with `/^([A-Za-z0-9_-]+):\s*(.*)$/`
  (`dist/chunk-65X3S4HB.js:20713`). Names outside that charset are silently ignored, and
  `${ENV}` is expanded in values (`:20851`). **So SAM header names must be `[A-Za-z0-9_-]`.**
  That charset is also exactly the TOML bare-key charset.
- **Codex config** (learn.chatgpt.com/docs/config-file/config-reference):
  `mcp_servers.<id>.env_http_headers` is a `map<string,string>` of header name to env var name.
  That keeps secret header values out of `~/.codex/config.toml`, as `bearer_token_env_var` does today.
- **Codex env var naming**: `isSecretEnvVar` (`internal/acp/process.go:109`) keeps only
  `_KEY`/`_TOKEN`/`_SECRET` names out of docker exec argv. The bearer var is
  `SAM_MCP_<NAME>_TOKEN`. A header var must use a DIFFERENT suffix: server `x`'s header var
  `SAM_MCP_X_HEADER_0_TOKEN` would collide with the bearer var of a server named `x-header-0`.
  Use `SAM_MCP_<NAME>_HEADER_<i>_SECRET`.
- **Composio**: `x-api-key` (single-toolkit MCP; required by default for new orgs) and
  `x-consumer-api-key` (Composio Connect).
  Sources: docs.composio.dev/docs/single-toolkit-mcp, composio.dev/toolkits/composio/framework/codex.

### Design decisions

- **Headers are orthogonal to `authType`**: `none|bearer` stays, and any connection may add
  custom headers. Composio is `none` + `x-api-key`. A custom `Authorization` header is allowed
  only when `authType` is `none` (for non-Bearer schemes); with `bearer` it conflicts and is
  rejected.
- **Header names**: `^[A-Za-z0-9_-]{1,64}$` (mcp-remote + TOML bare-key safe), unique
  case-insensitively. Transport-managed names are reserved: host, content-length,
  content-type, transfer-encoding, connection, accept, mcp-session-id,
  mcp-protocol-version, last-event-id.
- **Header values are secrets**: trimmed, non-empty, no control characters, byte-capped. They
  are never returned by any read path; the API returns `headerNames` only.
- **Storage**: the full `[{name,value}]` list is AES-GCM encrypted in `encrypted_headers` +
  `headers_iv`, and is the only thing injection reads. `header_names` (plaintext JSON) is the
  display projection, written by the same helper.
- **PATCH semantics**: `headers` omitted = unchanged. Present = the full desired set. An entry
  without `value` keeps the stored value for that (case-insensitive) name, so the UI can
  remove/add/rotate one header without re-entering the others. A value-less entry for an
  unknown name is a 400.
- **Limits** (configurable, Principle XI): `MAX_MCP_CONNECTION_HEADERS` (default 10),
  `MCP_CONNECTION_HEADER_VALUE_MAX_BYTES` (default 8192). Name length 64 is a
  non-configurable safety ceiling, like the server-name length.
- **vm-agent validation**: `normalizeMcpServers` re-validates the header name charset and
  value control characters, with an index-only error (never the value), because this is where
  values reach TOML/argv. Resolution also validates each decrypted row and skips + warns, so
  one bad row cannot fail session start.
- **Rollout (rule 54)**: `headers` is additive. The control plane sends it only when non-empty,
  and old agents ignore unknown JSON keys. New sessions only land on nodes running the
  current VM-agent release.
- **UI**: the MCP server form gains a Headers editor (name + masked value rows), and each row
  gets an **Edit** action. Edit mode keeps the URL, token and header values unless new ones
  are typed. The row shows header names.
- **File size (rule 18)**: extract the touched code instead of growing large files:
  - `acp/mcp_servers.go`: entry type + ACP/Amp builders
  - `acp/codex_config.go`, `acp/vibe_config.go`: config generators out of `gateway.go`
  - `server/mcp_servers.go`: normalize/register/convert out of `workspaces.go`
  - `persistence/session_mcp_servers.go`: out of `store.go`
  - `services/mcp-connection-headers.ts`
  - Web form/headers components out of `McpServersManager.tsx`

## Implementation Checklist

### Shared

- [x] `mcp-connection.ts`: `McpConnectionHeader`, `McpConnectionHeaderUpdate`, `headerNames` on
      `McpConnection`, `headers` on create/update requests, header name pattern/rule/max
      length, reserved header names
- [x] `defaults.ts`: `DEFAULT_MAX_MCP_CONNECTION_HEADERS`, `DEFAULT_MCP_CONNECTION_HEADER_VALUE_MAX_BYTES`
- [x] `vm-agent-contract.ts`: optional `headers` on `McpServerEntrySchema`
- [x] Contract fixture `mcp-server-name-contract.json`: `headerNames` valid/invalid block,
      consumed by the TS test and the Go test

### API

- [x] Migration `0175_mcp_connection_headers.sql` (ADD COLUMN ×3, additive) + `schema.ts` columns
- [x] `services/mcp-connection-headers.ts`: validate, merge-for-update, seal/open, display names
- [x] `services/mcp-connections.ts`: create/update/response use the header module
- [x] `schemas/mcp-connections.ts`: structural `headers` for create/update
- [x] `routes/mcp-connections.ts`: pass headers + new limits
- [x] `services/limits.ts` + `env.ts`: two new limits
- [x] `services/mcp-connection-resolution.ts`: decrypt + validate headers per row (skip on failure)
- [x] `services/node-agent.ts`: `McpServerConfig.headers`, `serializeMcpServers` sends only when non-empty

### vm-agent

- [x] Refactor commit: extract `acp/mcp_servers.go`, `acp/codex_config.go`, `acp/vibe_config.go`,
      `server/mcp_servers.go`, `persistence/session_mcp_servers.go` (pure moves)
- [x] `McpHeader` + `McpServerEntry.Headers`; header name/value validators in acp
- [x] `normalizeMcpServers` validates + copies headers; persistence conversion helpers used by
      register + agent_ws prefetch
- [x] Persistence `migrateV18` (`headers` JSON column) + upsert/get
- [x] ACP: custom headers after Authorization
- [x] Amp: `--header name:${SAM_MCP_HEADER_<i>}` with values in the server env, not argv
- [x] Codex: `env_http_headers` + `SAM_MCP_<NAME>_HEADER_<i>_SECRET` env vars
- [x] Vibe: custom headers in the `headers` inline table

### Web

- [x] Split `McpServersManager.tsx` into list + `McpServerForm` + `McpServerHeadersField`
- [x] Headers editor in the create form; Edit action with keep-semantics payload; header names in the row
- [x] Unit tests (create payload, edit payload keep/replace/remove, rendering)
- [x] Playwright audit: headers form + edit form + rows with many/long headers, 375 and 1280 (20 scenarios incl. Project Settings → Runtime; screenshots reviewed)

### Tests

- [x] API: header validation, encryption at rest, never-returned values, PATCH keep/replace/remove,
      authType/Authorization conflict, malformed `header_names` tolerated on list
- [x] API vertical slice: mock MCP server requiring `x-api-key` authorizes the resolved entry,
      and rejects without it
- [x] API: resolution skips a row with undecryptable headers, others still resolve
- [x] API: node-agent contract serializes headers only when present
- [x] Go: ACP/Amp/Codex/Vibe header output; normalize rejects bad header without leaking the value;
      full round trip incl. restart backfill; migrateV18 upgrade of existing rows
- [x] Contract fixture consumed on both sides

### Docs

- [x] `apps/www/.../guides/mcp-servers.md`: headers field, Composio row, editing, remove limitation, Amp note
- [x] `apps/www/.../reference/configuration.md` + `apps/api/.env.example`: new limits
- [x] `.claude/skills/changelog/SKILL.md` entry (env-reference skill never listed MCP limits; the public configuration reference is canonical)

## Acceptance Criteria

- [x] A user can add an MCP server with one or more custom headers (e.g. `x-api-key`) in
      Settings → MCP Servers and in Project Settings → Runtime
      (McpServersManager.test.tsx "adds a server authenticated only by a custom header"; Playwright add-form-headers + project-runtime)
- [x] A user can edit an existing server to add, rotate, or remove headers without re-entering
      the URL, the token, or other header values
      (McpServersManager.test.tsx editing suite; mcp-connection-headers.test.ts "updating headers")
- [x] Header values are encrypted at rest and never returned by any API response; names are shown
      (mcp-connection-headers.test.ts "returns header names but never values...")
- [x] Every harness receives the headers: ACP HTTP (Claude Code etc.), Codex
      (`env_http_headers`), Vibe, and Amp (mcp-remote)
      (mcp_headers_test.go, one test per harness; wire fixture through the real Go handler)
- [x] Invalid header names/values are rejected at write time with a clear message; a bad stored
      row cannot break session start for the scope
      (mcp-connection-headers.test.ts rejection table; mcp-connection-headers-injection.test.ts fault isolation)
- [x] Existing connections without headers behave exactly as before
      (no-header resolution test; node-agent wire fixture; TestMigrationV18KeepsExistingMcpServerRows)
- [ ] Staging: an agent session reaches a real MCP server that requires a custom header, and
      successfully calls a tool

## References

- `.claude/rules/54` (vm-agent rollout), `41`/`50` (per-row isolation), `28` (real SQL for
  scoping), `62`/`73` (field copies must not drop), `18` (file size), `23` (cross-boundary contract)
- `tasks/archive/2026-08-23-byo-mcp-servers.md`

## Implementation Notes

- Main is protected ("push declined due to repository rule violations"), so this task file
  ships in the PR instead of being committed to main first.
- Commits: `03c2ce2bb` pure-move refactor; `3417926b1` shared/API/vm-agent feature;
  `582936857` tests; `3234c96a7` web UI + docs.
- Discrimination: 8 Go mutations + 7 API mutations + 1 wire-tag mutation each turned the
  intended tests red (see PR body).
- Codex `env_http_headers` was verified against the published Codex config reference, and
  mcp-remote's header parser against the `mcp-remote@0.1.38` tarball source.
