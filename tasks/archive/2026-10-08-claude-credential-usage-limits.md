# Claude credential usage limits are never recorded or shown

**Status:** active
**Requested by:** Raphaël, 2026-10-08 (task 01M4EQEJ9PS6Q4MKBKE6FY2FMB): "Looks like we didn't add the usage UI for Claude? Only codex? I thought we already had that data for Claude, no?"
**Branch:** `sam/looks-didnt-add-usage-fy2fmb`
**Related:** PR #2238 (`tasks/archive/2026-10-05-credential-usage-limits-surface-codex-opencode.md`), idea `01M1RMTYR8FB95H3V031CRYN68`

## Problem

The usage chip (chat header) and Settings → Credentials usage rows shipped in #2238 are generic, and
#2238's first acceptance criterion was a Claude Max chip. In production they only ever show Codex and
OpenCode. Claude never shows.

### Production evidence (2026-10-08, read-only)

- `credential_limit_windows` (sam-prod D1) has 6 rows: `openai` (codex.primary) and `opencode.*`.
  **Zero `anthropic` rows**, ever (30-day retention; table exists since 2026-09-13).
- 245 `claude-code` agent sessions carry server attribution (`agent_credential_reference =
cc_credentials:…`, kind `oauth-token`, i.e. a Claude Max token), so Claude should have produced rows.
- Workers logs (last 24h): every `POST /api/projects/:id/acp-sessions/:sid/usage` from a
  `claude-code` session returned **400** with `durationMs: 0` and no handler log; every one from an
  `openai-codex` session returned **204**.
- The Claude credential reference is **238 characters**; Codex/OpenCode references are 49.

## Root cause

1. **Callback schema rejects the body.** `AcpSessionUsageReportSchema.credentialReference` uses
   `UsageIdentifierSchema` (`maxLength(160)`) in `apps/api/src/schemas/acp-sessions.ts:3,70`. The route
   (`apps/api/src/routes/projects/agent-usage-callback.ts`) answers any schema failure with
   `400 Invalid usage callback request body`. The VM agent echoes the server-issued reference
   (`session_host_usage.go:buildUsageReportRequest`), so every Claude report is rejected.
2. **Why the reference is long.** The 2026-06-14 composable-credentials backfill built ids as
   `cred-{ownerId}-{fingerprint}` with `fingerprint = encryptedToken:iv`
   (`apps/api/src/services/composable-credentials/backfill-service.ts:31,63,126`). Backfilled ids are
   119–223 chars and grow with the stored secret; ids created since are `cc-cred-<ulid>` (34 chars).
   Codex's credential was created after the backfill, Raphaël's Claude one during it.
3. **Latent truncation behind the schema.** Even with the schema fixed, the producer runs every
   identifier through `boundedIdentifier()` (`credential-limit-events/values.ts`), which truncates to
   160 bytes with a `...[truncated]` suffix (`DEFAULT_PROJECT_EVENT_FILTER_MAX_STRING_BYTES`). Readers
   filter by the full session reference (`read.ts:listProjectCredentialLimits`) and Settings matches by
   `credentialIdFromReference()`, so a truncated key is never found. The key cannot simply stay long:
   the ProjectData DO rejects `subject.id` over 160 bytes (`project-events-values.ts:normalizeText`)
   and the outbox contract requires `capture.credentialReference === subject.id`
   (`project-event-source-outbox-contract.ts:234`). The AI-proxy passthrough writer
   (`routes/ai-proxy-passthrough.ts:301`, `cc_credentials:${id}`) has the same latent truncation.
4. **Claude's per-window numbers are ignored.** A local reproduction with the production adapter
   (claude-agent-acp 0.81.2 + its bundled Claude Code native binary, SDK 0.3.280) against a mock
   Anthropic API (`.tmp/claude-acp/repro`, not committed) shows the normal reading is:
   `usage_update._meta["_claude/rateLimit"] = {status:"allowed", resetsAt:<s>, rateLimitType:"five_hour",
isUsingOverage:false, unifiedWindows:{five_hour:{utilization:0.13,resetsAt:<s>},
seven_day:{utilization:0.31,resetsAt:<s>}}}`. Top-level `utilization` appears only in warning states
   (Claude Code `deriveTrackedLimits`). `usageLimitFromClaudeRateLimit`
   (`packages/vm-agent/internal/acp/session_host_usage.go`) reads only the top level, so after fix 1 the
   chip would show one window with "usage unknown" most of the time and never the weekly window.

## Writers / readers of `credential_limit_windows.credential_reference` (rule 44)

| Path                                                                                                                                                                 | Role                                              | Change                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `services/acp-usage-callback-handler.ts` → `producer.ts`                                                                                                             | writer (VM agent usage callbacks)                 | key via producer                          |
| `services/credential-limit-events/headers.ts` → `producer.ts` (AI proxy: `ai-proxy-passthrough.ts`, `ai-proxy-anthropic-support.ts`, `ai-proxy-platform-billing.ts`) | writer                                            | key via producer                          |
| `services/credential-limit-events/admissions.ts` (load/update/outbox guard/supersede)                                                                                | reader/writer of the producer's sanitized key     | unchanged — receives the key              |
| `services/project-event-source-outbox.ts` (predecessor guard)                                                                                                        | reader of capture key                             | unchanged — receives the key              |
| `services/credential-limit-events/admissions.ts:purgeExpiredCredentialLimitWindows`                                                                                  | deleter by `updated_at`                           | unchanged                                 |
| `services/credential-limit-events/read.ts` (`listProjectCredentialLimits`, `listUserCredentialLimits`)                                                               | readers (project route, MCP tool, Settings route) | key the filter; restore real reference/id |

## Implementation checklist

### API (`apps/api`, `packages/shared`)

- [x] A1 Decided against a new length constant: the echoed reference is server-issued and only
      compared with `agent_sessions.agent_credential_reference`, so any field cap is a proxy that
      recreates this bug when ids grow (rule 74). The configurable callback body cap
      (`CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES`) bounds it.
- [x] A2 `AcpSessionUsageReportSchema.credentialReference` uses `UsageCredentialReferenceSchema`
      (non-empty string) with a comment naming the backfilled-id cause (b5350f863).
- [x] A3 `credentialLimitReferenceKey()` in `credential-limit-events/values.ts`: the trimmed
      reference when it is no longer than a digest key (71 bytes), else `sha256:<hex>` of the
      reference (collision-free; every key fits the window column's 160-char CHECK and any
      `PROJECT_EVENT_FILTER_MAX_STRING_BYTES` ≥ 71). Producer `sanitizeObservation` uses it instead
      of truncating. (First cut used the 160-byte default event budget; changed after the
      constitution review so the key no longer depends on that configurable limit.)
- [x] A4 `read.ts`: `listProjectCredentialLimits` filters by the key and restores the real reference
      and credential id for the requested credential; unfiltered and user-level reads restore keys of
      the caller's own `cc_credentials` (one extra D1 read, only when a hashed key is present).
- [x] A5 Tests: route-level schema test with a backfill-shaped 238-char reference (proved red pre-fix);
      producer test (long reference stored as key, short unchanged, event subject ≤ 160 bytes);
      read-service tests on real SQLite (filter by long ref; user restore; another user's hashed key
      not restored — owner control); workers vertical slice that POSTs the real callback route with a
      real callback JWT and a long reference, then reads the project (agentSessionId) and user routes.

### VM agent (`packages/vm-agent`)

- [x] V0 Split `session_host_usage.go` (676 lines, rule 18): Claude parsing moved unchanged to
      `session_host_usage_claude.go` in its own commit (bfaa31063).
- [x] V1 `usageLimitsFromClaudeRateLimit`: parse `unifiedWindows.five_hour` / `seven_day`
      (fraction → percent, seconds → ms, window minutes from the name); representative window takes
      the top-level status; others are `allowed` while the account is not rejected, else `unknown`;
      a representative window outside `unifiedWindows` (e.g. `seven_day_opus`) is kept as its own
      limit; payloads without `unifiedWindows` behave exactly as before.
- [x] V2 Report all parsed windows in one callback (`buildUsageReportRequest`, ≤ 16 observations).
- [x] V3 Go tests through the real trigger (`sessionHostClient.SessionUpdate` → reporter → httptest
      control plane) with the exact adapter payload captured in the repro; warning, rejected,
      opus-representative and legacy (no `unifiedWindows`) cases; controls proving existing tests stay
      green.

### Docs and records

- [x] D1 `apps/www/src/content/docs/docs/guides/agents.md` "Which credentials report limits": Claude
      reports the five-hour and weekly limits on every reading, plus weekly Opus/Sonnet when one of
      those is the limiting window.
- [x] D2 SAM Idea `01M4EST1XWX60JGC7D59PX2BEG` for the separate hygiene issue: backfilled `cc_credentials` ids embed ciphertext + IV
      (`backfill-service.ts:31`); re-keying is a data migration, out of scope here.
- [x] D1b Same section: Claude Code sends its first reading only after a few model calls, so a chat
      that ends after one short reply may not show a chip yet (found on staging, see below).
- [ ] D3 After merge + deploy: verify a production Claude session produces `anthropic` rows and the chip
      renders; update idea `01M1RMTYR8FB95H3V031CRYN68`. Evidence goes on the PR and the idea, since
      this file is archived before merge.

## Acceptance criteria

1. A Claude usage callback carrying a backfill-shaped (> 160 char) credential reference is accepted
   (204) through the real route and stored (workers vertical slice; route test red pre-fix).
2. The chat-header query (`GET /api/projects/:id/credential-limits?agentSessionId=`) returns that
   credential with its real `credentialReference`/`credentialId` and both `claude.five_hour` and
   `claude.seven_day` windows (vertical slice).
3. Settings (`GET /api/credentials/limits`) returns the real `credentialId` so the card matches
   (vertical slice + read test); another user's hashed key is never restored to their id for the caller.
4. A credential-limit event for a long reference is admitted (subject id ≤ 160 bytes) (producer test).
5. The VM agent turns the adapter's normal reading into `claude.five_hour` 13% and `claude.seven_day`
   31% in one callback, through the real `SessionUpdate` trigger (Go test).
6. Short references (Codex/OpenCode) are stored and read exactly as before (controls).
7. Staging: a real Claude session on a fresh node produces `anthropic` rows in staging D1 and the chip
   renders in the chat header (Playwright screenshot). Production after deploy: same check.
8. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Go tests green; CI green.

## Notes

- Rule 62: the existing callback tests call `handleAcpUsageCallback` directly
  (`acp-usage-callback-auth-real-jwt.test.ts`) or mock it (`routes/agent-usage-callback.test.ts`), so no
  test ever sent a real-length reference through the route schema. New tests enter through the route.
- Rule 74: the 160 bound was a proxy for "this is an identifier"; the condition the producer needs is
  "fits a project-event subject id". Hashing keys on the condition.

## Implementation notes (2026-10-08)

- Claude utilization is a 0..1 fraction everywhere (Claude Code's own status line renders
  `round(x*1000)/10`). The VM agent now converts it strictly as a fraction with the same rounding,
  so an over-limit 1.03 reads 100% (the old `<= 1 → ×100` guess read it as 1%) and float noise
  (0.13×100 = 13.000000000000002) stays out of reports and the reporter's coalesce key.
- Discrimination evidence (each revert surgical, then restored):
  - VM agent: returning only the top-level window → `TestClaudeAdapterUsageUpdateReportsFiveHourAndWeeklyWindows`
    red ("windows = [claude.five_hour], want 2 windows") plus 6 table cases; the legacy-payload case stays green.
    Old `<= 1` heuristic → only the over-limit table case red.
  - API route: old 160-char schema → `accepts the long credential reference…` red (400); window-type bound control green.
  - Producer: truncation (`boundedIdentifier`) → both new producer tests red; 20 existing green.
  - Reader: raw-reference filter → session-filter test red; owner filter removed → member-attack test red;
    Settings restore removed → Settings test red.
  - Workers vertical slice: old schema → `{"error":"BAD_REQUEST","message":"Invalid usage callback request body"}: expected 400 to be 204`.
- I/O: the user and unfiltered project reads add one D1 read (`cc_credentials` ids by owner) only
  when a digest-keyed summary is present; the session-filtered chip read adds none. GET budgets stay
  well under 8 (rule 60).
- Turbo 2.11.7 writes an agent-guidance block into `AGENTS.md` on every agent-run turbo command; it
  is reverted before each commit (unrelated to this task).

## Staging verification (2026-10-08/09)

Deploy `37860636181` (8894f29a3, main 2bbe9336f merged) succeeded at 23:54Z. VM agent release
`350d71732` was uploaded to R2 at 23:45:40Z; both test nodes were provisioned after that from an
empty node list (rule 27). Throwaway Artifacts project `01M4EY6CCH30PD0BKKWK8A4CKA` with a
`claude-code` VM profile.

- **Long backfilled reference (the production failure).** The smoke user's migrated config
  `cfg-01KJPYVEXT39RHF2PXMV4Q23B4` (credential id 223 chars, reference 238 chars) was attached at
  project scope. Agent session `01M4F1S03QGZF41ZE3DDMW76N6` was attributed `project` / 238 chars.
  `POST …/acp-sessions/01M4F1S03QGZF41ZE3DDMW76N6/usage` returned **204** at 00:43:20Z (production
  returns 400 for this shape). D1 stored `claude.five_hour` 38% (allowed, 300 min) and
  `claude.seven_day` 91% (allowed_warning, 10080 min) under `sha256:a310660…` (71 bytes).
- **Chat chip, long reference.** It reads "Claude · 5h 38% · Week 91%". The details read "Project
  credential · claude-code", with 5h resetting in 2h 15m and Week in 1d 5h. Mobile (375px) chip and
  details render with 0 px horizontal overflow and no console errors. Screenshots are in
  `.codex/tmp/playwright-screenshots/usage-limits/longref-*`.
- **Restore.** The unfiltered `GET /api/projects/:id/credential-limits` returned the long credential
  with its real 238-char reference and 223-char `credentialId`.
- **Default (short) credential, Settings.** Session `01M4F1AAC04WQ6P71AC43G18AY` (user scope, 49
  chars) reported both windows (204 at 00:40:19Z). Settings → Advanced shows
  "Claude · 5h 38% · Week 91%, sampled 4m ago" on the Claude Code credential.
- **Before this change.** Staging's newest Claude rows (old VM agent) carried `claude.five_hour`
  with no utilization, or only the weekly window when it was in a warning state.
- **Emission timing found on staging.** Each chat's first one-reply session produced no usage
  callback at all. The same account produced readings as soon as a prompt made several model
  calls. In Claude Code 2.1.281, `extractQuotaStatusFromHeaders` ignores rate-limit headers until the
  subscription type is known, and the event is emitted from the `statusChanged` listener. The
  agents guide now says so; nothing in SAM can change it.
- **Cleanup.** Both chats stopped (`workspaceDeleted: true`). Nodes `01M4EZ7GZHJ8F1SFWF74QYDZPT` and
  `01M4F0YZN9T8V5065Z4WEA33JW` were deleted (`GET /api/nodes` = []), then the project and both
  project attachments. The user-level Claude attachment was never changed.
- **Found while testing.** Credential attachment create/delete takes 41–48 s on staging. Filed as
  `tasks/backlog/2026-10-09-cc-attachment-mutations-take-45-seconds.md`.
