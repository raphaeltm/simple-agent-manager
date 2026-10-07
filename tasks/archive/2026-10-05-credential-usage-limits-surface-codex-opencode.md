# Surface credential usage limits; capture Codex and OpenCode Go live limits

**Status:** archived with the PR (implementation complete; staging evidence recorded in the PR body)
**Requested by:** Raphaël, 2026-10-05 (task 01M464DMGWETMRVFA9TW2JVE6M): "I want you to add codex and OpenCode as well as surface the existing data. Get a pr green."
**Research record:** idea `01M1RMTYR8FB95H3V031CRYN68` Parts 1–6 (Part 6 = 2026-10-05 verification of provider endpoints).

## Problem

SAM already records provider quota windows per credential (`credential_limit_windows` in D1, written by
`apps/api/src/services/credential-limit-events/producer.ts`) and emits `credential.limit.*` project events, but:

1. **Nothing reads the data for people or agents.** There is no API route, no web UI and no MCP tool over
   `credential_limit_windows` (grep of `apps/web`, `apps/api/src/routes`, `durable-objects/sam-session`: zero hits).
   A Claude Max user cannot see "5h window 72%, resets 16:40" even though SAM stores it.
2. **Codex (ChatGPT OAuth) sessions record nothing.** codex-acp 2.1.1 receives `account/rateLimits/updated`
   and keeps it in session state, but only renders it in `/status` text; it never forwards it on an ACP update
   (`.tmp/codex-acp/package/dist/index.js:30998`, `36073`). `session_host_usage.go` only reads the Claude meta key.
3. **OpenCode sessions record nothing.** OpenCode Go has an official usage endpoint that SAM never calls.
4. The window allowlist drops Claude's per-model weekly windows (`seven_day_opus`, `seven_day_sonnet`).

## Constraints (from Raphaël / policy)

- Do NOT call the undocumented Anthropic `/api/oauth/usage` or ChatGPT `backend-api/wham/usage` endpoints.
- Do not rebuild the pinned Codex runtime archive (`scripts/diagnostics/build-pinned-codex-review.sh`, sam-c2.2,
  136 MB, cosign-verified) in this PR; a codex-acp patch is a separate release process.
- Direct change request ⇒ merge once every gate is green (policy d60830e2).

## Research findings (verified 2026-10-05 against a3110a0a5 and primary sources)

### Existing pipeline (file:line)

- Writer 1: VM agent `packages/vm-agent/internal/acp/session_host_usage.go:108-150` reads claude-agent-acp
  `usage_update._meta["_claude/rateLimit"]` → `POST /api/projects/:id/acp-sessions/:sid/usage`
  (`apps/api/src/routes/projects/agent-usage-callback.ts`, callback JWT, mounted before `projectsRoutes` — rule 34).
- Handler `apps/api/src/services/acp-usage-callback-handler.ts`: server-verified attribution from
  `agent_sessions.agent_credential_{reference,source,provider,generation}`; `limit.provider` overrides the
  derived provider; `limit.source` overrides the default source.
- Producer `credential-limit-events/producer.ts:40-110`: allowlists from
  `packages/shared/src/constants/credential-limits.ts` (`DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_{PROVIDERS,SOURCES,WINDOW_TYPES}`,
  env-overridable via `config.ts`). Level = `computeLevel(status, utilization)` (`event-builders.ts:39`).
- Table `apps/api/src/db/schema.ts:1754` PK `(project_id, credential_reference, window_type)`; columns include
  `user_id`, `credential_source`, `provider`, `provider_mode`, `agent_type`, `status`, `last_event_level`,
  `utilization_percent`, `limit_amount`, `remaining_amount`, `window_minutes`, `resets_at`, `observed_at`, `updated_at`.
- Writer 2: SAM AI proxy headers (`credential-limit-events/headers.ts`), `sam` provider mode only.
- Credential reference formats: `cc_credentials:<id>` (`routes/credentials.ts:1064`), legacy `credentials:<id>`,
  `platform_credentials:<id>`, `platform_proxy:<provider>` (`routes/workspaces/runtime.ts:291`).
- OpenCode CC credentials resolve `credentialProvider = providerDialect ?? consumer.kind` (`credentials.ts:1084`),
  i.e. often `'agent'`; the VM agent must therefore set `provider` explicitly on each limit payload.

### Codex capture path (chosen)

- Codex CLI 0.160.0 (pinned via the sam-c2.2 archive) persists `EventMsg::TokenCount` to the session rollout
  (`codex-rs/rollout/src/policy.rs:113` at `rust-v0.160.0`). Rollout file:
  `$CODEX_HOME|~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>[_<rollout_id>].jsonl`
  (`rollout_file_name.rs:67-70`). Line: `{"timestamp":"…","type":"event_msg","payload":{"type":"token_count","info":…,"rate_limits":{…}}}`.
- `RateLimitSnapshot { limit_id?, limit_name?, primary?: RateLimitWindow, secondary?: RateLimitWindow, credits?,
plan_type?, rate_limit_reached_type?, spend_control_reached? }`, `RateLimitWindow { used_percent: f64,
window_minutes: i64|null, resets_at: unix seconds|null }` (`protocol/src/protocol.rs` at `rust-v0.160.0`).
- codex-acp's ACP `sessionId` is the Codex thread id (`dist/index.js:33465 sessionId: response.thread.id`); the VM
  agent holds it lock-free in `h.loadMirroredSessionID()` (`session_host.go:767`).
- Container file access helpers exist: `execInContainer` (`gateway.go:570`), `readOptionalFileFromContainer`
  (`gateway.go:1387`, CODEX_HOME aware), local path resolution `resolveLocalAuthFileTargetPath` (`session_host_startup.go:323`).
  Standalone (cf-container) mode is `h.config.ProcessLauncher != nil` (`session_host.go:642`).
- Trigger point: successful prompt completion in `session_host_prompt.go:594-602` (`finishPromptAttempt`).
- Window labelling must derive from `window_minutes`, never from primary/secondary position: plans order windows
  differently (team: 5h primary + weekly secondary; prolite: weekly primary only) — getpaseo/paseo#4165, RunMaestro/Maestro#1596.

### OpenCode Go

- Official `GET https://opencode.ai/zen/go/v1/usage`, `Authorization: Bearer <OPENCODE_API_KEY>` →
  `{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"2026-09-13T10:42:47.510Z"},"weekly":{…},"monthly":{…}}}`
  (anomalyco/opencode#44189; opgginc/opencode-bar#154; slkiser/opencode-quota providers.md). Zen credit balance has no
  key-authenticated API (console only; #44189 open).
- Provider choice is agent-settings state: `OpenCodeProvider = 'opencode-zen' | 'opencode-go' | 'custom'`
  (`packages/shared/src/types/agent-settings.ts:32`), surfaced to the VM agent as `agentSettingsPayload.OpencodeProvider`
  (`gateway.go:535`) and selected in `AgentSettingsCard.tsx`. The key is only injected into the agent env today
  (`session_host_startup.go:232-241`); the VM agent does not retain it.
- Only one `GatewayConfig` constructor exists (`server.go:477`), used by both VM and cf-container runtimes (rule 61).

### Web / MCP patterns to reuse

- TanStack `queryOptions` + `useQueryScope()` (`apps/web/src/lib/query-options/projects.ts`,
  `hooks/useQueryScope.ts`); barrel `lib/query-options/index.ts`; API barrel `lib/api/index.ts`.
- Chat header chip row: `components/project-message-view/SessionHeader.tsx:236-320` (after `WorkspaceProfileBadge`);
  `session.agentSessionId` is available on `ChatSessionResponse` (`lib/api/sessions.ts:66`).
- Settings cards: `pages/SettingsCredentials.tsx` `CredentialCard` (ids from `/api/cc/credentials`).
- MCP: defs `routes/mcp/tool-definitions-workspace-tools.ts`, direct-D1 handlers `workspace-tools-direct.ts`,
  dispatch switch `routes/mcp/index.ts:494`, `McpTokenData { projectId, userId, workspaceId, agentSessionId? }`.
- Tests: `apps/api/tests/unit/routes/credential-attribution-health.test.ts` (route harness),
  `tests/unit/credential-limit-events.test.ts`, `tests/helpers/sqlite-d1.ts` (`createSchemaTables` — rule 28 §5 for
  SQL predicates), `packages/vm-agent/internal/acp/session_host_usage_test.go` (22 tests),
  `apps/web/tests/unit/components/session-header.test.tsx`, `apps/web/tests/playwright/ideas-ui-audit.spec.ts`.

### Relevant rules / post-mortems

- Rule 34 (callback routes outside `projectsRoutes`) — read route is browser-auth, so it goes INSIDE `projectsRoutes`.
- Rule 28 §5 + rule 11 (project-scoped reads): scoping predicates tested against real SQLite with an attack fixture
  and an owner control.
- Rule 50 (list reads tolerate a malformed row), rule 60 (I/O budget ≤ 8 for a GET), rule 48 (TanStack Query,
  stale-while-revalidate), rule 17 (Playwright at 375/1280 with stress data, screenshots in PR), rule 71 (probe
  goroutine must not capture a request context), rule 61 (both runtimes), rule 62 (tests enter through the real trigger),
  rule 74 (label by `window_minutes`, not position), rule 42 (no untracked placeholders).

## Implementation checklist

### A. Shared (`packages/shared`)

- [x] A1 Extend `constants/credential-limits.ts`: providers `+opencode`; sources `+vm-agent.codex_rollout`,
      `+vm-agent.opencode_go_usage`; windows `+claude.seven_day_opus`, `+claude.seven_day_sonnet`, `+codex.primary`,
      `+codex.secondary`, `+opencode.rolling`, `+opencode.weekly`, `+opencode.monthly`.
- [x] A2 Add `types/credential-limits.ts` (`CredentialLimitWindowSummary`, `CredentialLimitCredentialSummary`,
      `CredentialLimitsResponse`) and export from `types/index.ts`.
- [x] A3 Add pure helpers (`credential-limits` utils): window label from `(windowType, windowMinutes)`, worst level,
      credential id from reference; unit tests.

### B. API (`apps/api`)

- [x] B1 `services/credential-limit-events/read.ts`: `listProjectCredentialLimits(env, {projectId, userId,
    credentialReference?})` (rows where `project_id = ?` AND (`user_id = ?` OR `credential_source IN
    ('project','platform'))), `listUserCredentialLimits(env, {userId})`(rows`user_id = ?`AND
   `credential_source = 'user'`, collapsed to newest per `(credential_reference, window_type)`across projects),
   `resolveAgentSessionCredentialReference(env, {projectId, agentSessionId})`(agent_sessions ⋈ workspaces,
    project-bound). Row-tolerant mapping (rule 50); bounded by`CREDENTIAL_LIMIT_READ_MAX_ROWS` (default 200).
- [x] B2 Route `GET /api/projects/:id/credential-limits?agentSessionId=` in `routes/projects/credential-limits.ts`
      (`requireProjectCapability(..., 'project:read')`), mounted in `routes/projects/index.ts`. ≤ 3 round trips.
- [x] B3 Route `GET /api/credentials/limits` (user) in `routes/credential-limits.ts`, mounted in `index.ts` before
      `credentialsRoutes` (same as `resolutionStatusRoute`).
- [x] B4 MCP tool `get_credential_limits` (`scope: 'session' | 'project'`, default session): definition in
      `tool-definitions-workspace-tools.ts`, handler in `workspace-tools-direct.ts`, switch case in `routes/mcp/index.ts`,
      tool listed in the onboarding instructions (`onboarding-tools.ts`).
- [x] B5 `env.ts` + `.env.example`: `CREDENTIAL_LIMIT_READ_MAX_ROWS`.
- [x] B6 Tests: read service on real SQLite (foreign user's personal row excluded + owner control; project/platform rows
      visible to a member; cross-project exclusion; user-level newest-wins collapse; malformed row skipped); both route
      tests; MCP handler test; producer tests proving `codex.primary`/`opencode.weekly`/`claude.seven_day_opus` are now
      admitted and an unknown window is still `unsupported`.

### C. VM agent (`packages/vm-agent`)

- [x] C1 Config: `ACPUsageProbeTimeout` (env `ACP_USAGE_PROBE_TIMEOUT`, default 10s) and `OpenCodeGoUsageURL`
      (env `OPENCODE_GO_USAGE_URL`, default `https://opencode.ai/zen/go/v1/usage`) in `config/config.go`,
      `config_load.go`, timeout validation list (`helpers.go`); plumbed via `server.go` into `GatewayConfig`.
- [x] C2 Refactor `prepareUsageReportWithAttribution` into a generic `buildUsageReportRequest(attr, source, limits)`;
      Claude path behaviour unchanged (existing 22 tests stay green).
- [x] C3 Codex rollout reader (`session_host_usage_codex.go`): validate thread id (`^[0-9a-f-]{36}$`), locate
      `rollout-*-<thread>*.jsonl` under `$CODEX_HOME`/`~/.codex/sessions` (container: `execInContainer` with a fixed
      `sh -c` script and the id as `$1`; standalone: `filepath.Glob`), read the last 256 KiB, drop a partial first line,
      take the newest `event_msg`/`token_count` with non-null `rate_limits`, emit `codex.primary`/`codex.secondary`
      (provider `openai`, source `vm-agent.codex_rollout`, `used_percent`, `window_minutes`, `resets_at*1000`,
      status `rejected` when `rate_limit_reached_type`/`spend_control_reached` is set or `used_percent >= 100`,
      else `allowed`). Reader is an injectable function for tests.
- [x] C4 OpenCode Go probe (`session_host_usage_opencode.go`): retain the API key in memory only when
      `agentType == opencode && provider == opencode-go && credentialKind == api-key`; clear it in
      `stopCurrentAgentLocked`; `GET OpenCodeGoUsageURL` with Bearer via `h.config.HTTPClient`; parse
      `usage.{rolling,weekly,monthly}` → `opencode.*` (provider `opencode`, source `vm-agent.opencode_go_usage`,
      `percent`, `resetsAt` ISO→ms, status ok→allowed, warning→allowed_warning, exceeded|limited|blocked→rejected,
      else unknown). Non-200 or unexpected shape → no observation, one debug log.
- [x] C5 Trigger: after a successful prompt completion (`finishPromptAttempt`), `scheduleProviderUsageProbe()` runs a
      single-flight goroutine bound to `h.lifecycleContext()` + `ACPUsageProbeTimeout` and enqueues through the
      existing coalescing usage reporter. No probe for other agent types.
- [x] C6 Tests: rollout parser fixtures (partial first line, missing `rate_limits`, newest wins, bad thread id,
      prolite weekly-only); OpenCode parser + status mapping + non-200; probe-through-real-prompt-completion for codex
      (fake reader) and opencode (httptest usage server) asserting the callback body posted to a fake control plane;
      control: claude-code completion schedules no probe; key cleared after stop.
- [x] C7 Docs: `apps/www/src/content/docs/docs/reference/vm-agent.md` env table (`ACP_USAGE_PROBE_TIMEOUT`,
      `OPENCODE_GO_USAGE_URL`).

### D. Web (`apps/web`)

- [x] D1 `lib/api/credential-limits.ts` (`getProjectCredentialLimits`, `getMyCredentialLimits`) + barrel export.
- [x] D2 `lib/query-options/credential-limits.ts` (identity-scoped keys, `staleTime` 30s, `refetchInterval` 60s,
      no background refetch) + barrel export.
- [x] D3 `components/credential-limits/CredentialLimitChip.tsx` (+ `credential-limit-format.ts`): compact chip showing
      provider + worst window ("Claude · 5h 72% · wk 31%"), level colours (ok/warning/critical/rejected), accessible
      popover listing each window with reset countdown and freshness.
- [x] D4 `SessionHeader.tsx`: render the chip after `WorkspaceProfileBadge` when the project route returns windows for
      `session.agentSessionId`; hidden otherwise (no spinner, rule 48).
- [x] D5 `SettingsCredentials.tsx` `CredentialCard`: usage line from `/api/credentials/limits` matched by
      `cc_credentials:<id>`; `AgentSettingsCard.tsx`: when OpenCode provider is `opencode-zen`, show the one-line note
      "Zen credit balance is only visible in the OpenCode console" with a link.
- [x] D6 Unit tests: format helpers; `SessionHeader` shows/hides the chip from a mocked query; Settings card shows usage.
- [x] D7 Playwright `tests/playwright/credential-limits-audit.spec.ts`: Settings credentials + chat header at 375×667
      and 1280×800 with normal / long names / many windows / empty / error data; overflow assertions; screenshots in
      `.tmp/playwright-screenshots/`; reviewed and posted to the PR.

### E. Docs and records

- [x] E1 Public docs: credential usage limits section (agent credentials guide) + `reference/api.md` entries for the two
      routes and the MCP tool.
- [ ] E2 After merge: update idea `01M1RMTYR8FB95H3V031CRYN68` (Part 6 → shipped PR #, what remains: idle polling
      decision, Zen balance).

## Acceptance criteria

1. A project member sees a usage chip in the chat header for a running Claude Max session's credential, with 5h and
   weekly utilization and reset time, and can open the details popover (unit test + staging Playwright screenshot).
2. Settings → Credentials shows the same windows per personal credential that has observations (unit test + Playwright).
3. A Codex OAuth session produces `codex.primary`/`codex.secondary` rows after a prompt completes (Go test through the
   real completion path; staging: real VM Codex session then D1 `SELECT … FROM credential_limit_windows WHERE provider='openai'`).
4. An OpenCode Go session produces `opencode.rolling|weekly|monthly` rows (Go test with httptest; staging only if a Go
   key exists on staging — otherwise state so in the PR).
5. `get_credential_limits` returns the calling session's credential windows (handler test).
6. Another member's personal credential windows are never returned by the project route (real-SQLite attack test with
   owner control; guard deleted once → attack test red, control green).
7. No code path calls `api.anthropic.com/api/oauth/usage` or `chatgpt.com/backend-api/wham/usage` (grep in review).
8. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green; Go tests green; CI green; staging deploy green with a
   real VM provisioned (vm-agent change ⇒ rule 22 infra gate) and cleaned up.

## Review follow-ups applied (2026-10-05, Phase 5)
- Added migration `0183_credential_limit_windows_user_index.sql` + schema index so the per-user read is index-backed (performance + Cloudflare reviewers).
- `CREDENTIAL_LIMIT_READ_MAX_ROWS` is clamped to a 2000-row ceiling (Cloudflare reviewer); var added to the deploy override list (env reviewer).
- Codex `rate_limit_reached_type` / `spend_control_reached` now mark windows `rejected` below 100% (validator + test reviewer), with tests.
- Local rollout lookup is depth-agnostic like the container script (go reviewer).
- MCP handler moved to `routes/mcp/workspace-tools-credential-limits.ts` (file-size rule 18); shared `formatMsSpan` in `lib/time-utils.ts` replaces the duplicate span formatter (architecture reviewer).
- Tests added: Settings usage rows, SessionHeader chip wiring spy, Zen note, MCP error path, multi-window single callback through the real handler, user cap, local rollout reader, OpenCode non-200 + timeout, rule-71 cancellation + teardown, single-flight, errored prompt; Playwright now also asserts no clipped overflow.
- Docs: `configuration.md` gained the two VM-agent vars, the two `VITE_` vars and the corrected `anthropic,openai,opencode` default.

## Notes / dead ends

- codex-acp ext methods at 2.1.1: `authentication/status`, `authentication/logout`, legacy set-model, steering, async
  task stop, goal control — nothing for rate limits.
- Spawning a second `codex app-server` to call `account/rateLimits/read` was rejected: it would race the shared
  `auth.json` refresh token (the exact race the Codex refresh proxy exists to prevent).

## Staging findings (2026-10-05)

Live verification on staging (`app.sammy.party`, Raphaël's staging account) found two
gaps that the local suite could not see, both fixed in this branch:

- **Chip never appeared on an already-open chat page.** `session.updated` broadcasts
  only carried `topic`/`workspaceId`, so a page opened before the agent session
  existed never learned `session.agentSessionId`; the chip (gated on it) showed only
  after a reload. `ProjectData.createAcpSession` now broadcasts
  `{ sessionId, agentSessionId }` to the chat session's sockets and
  `useChatWebSocket` forwards it (`39241bd7b`). Worker test
  `tests/workers/acp-session-created-broadcast.test.ts` subscribes through the real
  `/ws` path and was proven discriminating by reverting the broadcast.
- **Windows were ordered alphabetically**, so OpenCode read
  `Month 2% · Rolling 0% · Week 0%`. The read model now orders each credential's
  windows by span, shortest first, unknown spans last (`3696a6f97`). The OpenCode Go
  endpoint reports no window length, so fixed-meaning window types also carry a nominal
  span used only for ordering (`credentialLimitWindowSortMinutes`, `dff92898e`).

- **An unexpected limits body crashed the chat page.** CI's session tool-rail Playwright
  audit answers unknown API paths with `{}`; the header chip read
  `data.credentials[0]` and threw, taking the whole message view down
  ("Cannot read properties of undefined (reading '0')"). The web API client now
  normalizes the body at the boundary (`normalizeCredentialLimitsResponse`, rules 50/51)
  and the chip guards its reads. Regression tests: `tests/unit/lib/credential-limits-api.test.ts`
  and `tests/unit/components/session-credential-limit-chip.test.tsx` (the latter reaches the
  chip through the real query and reproduced the exact error with the fix stashed).

- **CodeRabbit (PR #2238) asked for two hardenings on the OpenCode Go probe**, both
  applied: `OPENCODE_GO_USAGE_URL` must be https unless the host is loopback
  (`Config.Validate`), and the probe uses a copy of the host HTTP client with
  redirects disabled so the bearer token can never be replayed to another host.
  The redirect test records any `Authorization` header at the redirect target and
  fails with "the bearer token was forwarded" when the client change is reverted.

Observed provider payloads (for future reference):

- Codex CLI 0.160 rollout on a ChatGPT **Pro** plan reported only
  `primary: { used_percent: 65, window_minutes: 10080 }` with `secondary: null`, plus a
  `credits: { balance }` object SAM does not surface yet (follow-up noted on the idea).
  Labelling by `window_minutes` (not position) therefore showed "Week", as intended.
- OpenCode Go `/zen/go/v1/usage` returned rolling/weekly/monthly with `percent` and
  `resetsAt` (monthly without a reset time).
