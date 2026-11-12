# Secure agent secret collection (request_secret → encrypted project runtime secret)

Task: SAM `01M77FJPD5YKJ8H279R99P3TDM` (coordinator `01M77EEHZSBVF3X55FRXHHD46W`, channel
`feature.secret-input`). Idea `01M6R870SCQ084VXW8QY3M7B7Q` (option A). Authorized through
production 2026-11-12. PR stays DRAFT until the coordinator approves a named head SHA.

## Problem

An agent that needs a credential today must ask the human to paste it into the chat (the value
enters the model context and the persisted transcript) or into `add_profile_env_var` (plaintext
tool argument). We want: the agent requests a named secret with a reason and optional TTL; a
card in the conversation lets an authorized human type the value, which goes straight to the
API and is stored as an encrypted project runtime secret; the agent is woken with a
metadata-only receipt and uses it immediately through `exec_with_secrets`.

## Research findings

- Storage destination exists: `project_runtime_env_vars` (`db/schema.ts:720`), AES-GCM via
  `services/encryption.ts`; manual upsert inline in `routes/projects/runtime-config.ts`
  (requires `secret:write`, i.e. project owner/admin).
- Secrets are resolved only at exec time: `getSecretExecutionEnv`
  (`services/workspace-runtime-assets.ts`) merges project → profile → skill rows and decrypts
  only selected names. Runtime assets for agent start return placeholders
  (`resolveRuntimeEnvRows`), so a secret added mid-session works on the next exec call.
- No expiry/provenance columns exist on any runtime env table.
- Agent listing: only `list_profile_env_vars` (profile scope). No effective-names read.
- Card precedent: `ops_request_action` → `ApprovalCard` (tool-card registry by tool name, card
  reads server record by id) and decision delivery through durable prompt delivery
  (`services/operations-actions/decision-delivery.ts`, `acceptPromptDelivery` with a
  source-task guard). `request_human_input`/attention markers must NOT be reused: the bell's
  answer controls send free text to the agent (a human could paste the secret there).
- Compact-mode chat history keeps card ids only for known tool names
  (`project-data/row-schemas/messages.ts` APPROVAL_CARD_TOOL/HUMAN_INPUT_CARD_TOOL).
- `PROMPT_DELIVERY_SOURCES` has no CHECK constraint; adding a kind touches shared list,
  `prompt-delivery.ts` expiring-wake IN list and `sourceTaskGuardForClaim`.
- Notification types are a shared const list with web config + settings page.
- Tunables must be admin settings (registry pattern: `connector-read-settings-definition.ts`).
- Cron: 5-minute isolated sweeps in `scheduled/handler.ts`; daily `0 3 * * *` branch for purges.
- Valibot default messages echo values (rule 51) → secret body parse must use custom messages.

## Design

- D1 migration 0235: new table `runtime_secret_requests` (id, project_id FK cascade,
  requesting task/authority task/chat session/agent session/workspace, requester_user_id,
  env_key, reason, ttl_seconds NULL, status pending|fulfilled|declined|expired, expires_at ms,
  resolved_by/at, secret_expires_at ms, replaced_existing, created/updated) + indexes; and
  nullable columns on `project_runtime_env_vars`: `expires_at` (ms) and `secret_request_id`.
- Shared service `services/runtime-secret-requests.ts` (all surfaces call it):
  create (MCP), get (REST), fulfill (REST, CAS pending→fulfilled, encrypt, upsert row with
  provenance+expiry, enqueue metadata-only wake), decline, expire sweep, purge.
- Shared `upsertProjectRuntimeEnvVar` service used by both manual route and fulfillment; manual
  upsert clears provenance/expiry (manual value).
- TTL enforcement: expired rows excluded in `getSecretExecutionEnv` and runtime assets (fail
  closed at read time); daily purge deletes expired material; request rows kept for a bounded
  retention.
- MCP: `request_secret` (ungrouped, card tool) and `list_runtime_env` (+ `workspace_read`
  method `runtime_env`) returning effective names/scope/secret/expiry/provenance — no values.
- Wake: new prompt delivery source `secret_request`, guarded by the requesting task like
  `operations_decision`; content names the request, key, outcome, expiry; never the value.
- Web: `SecretRequestCard` (tool-card registry) with password input, explicit replace
  confirmation, decline, statuses; runtime config section shows "collected" badge,
  provenance and expiry/expired state.
- Notifications: new `secret_request` type to the session owner when requested.

## Implementation checklist

- [x] Migration 0236 (0235 taken by open PR #2664) + drizzle schema
- [x] Shared types (request record, effective runtime env entry, notification type, delivery source)
- [x] Admin settings: request lifetime, max TTL, history retention, pending cap per session
- [x] Shared upsert service; manual route refactor (clears provenance/expiry)
- [x] Secret request service (create/get/fulfill/decline/expire/purge) + wake delivery
- [x] Expiry enforcement in exec env + runtime assets
- [x] MCP `request_secret` + `list_runtime_env` + group method + compact-mode tool name
- [x] REST routes (get/fulfill/decline) with capability + project checks, value-safe parsing
- [x] Cron: 5-min expiry sweep (isolated), daily purge
- [x] Notification type + web config
- [x] Web card + API client + registry; runtime config UI provenance/expiry
- [x] Docs: public docs page/section + MCP tool reference sync
- [x] Tests: service (real SQL), route auth/cross-project, MCP, expiry, no-leak, card, Playwright audit

## Acceptance criteria

- [ ] Agent `request_secret` returns only metadata + card id; request persisted, reload-safe
- [ ] Authorized human submits from the in-chat card; value never in chat/tool results/events/logs
- [ ] Stored encrypted as project runtime secret with provenance; overwrite needs explicit confirm
- [ ] Duplicate submit, decline, request expiry, reconnect behave as defined; unauthorized,
      non-member and cross-project writes rejected
- [ ] Masked listing (UI + `list_runtime_env`) shows collected provenance and expiry
- [ ] TTL: exec allowed before expiry, rejected after (read-time), purged by daily maintenance
- [ ] Requesting agent gets a metadata-only durable wake and can exec immediately
- [ ] Staging: real VM agent requests, human submits via browser, agent exec_with_secrets works;
      Instant compatibility checked; desktop/mobile screenshots posted

## Implementation notes

- Runtimes enumerated (rule 61): VM and Instant both resolve secrets through `handleSecretExec` →
  `getSecretExecutionEnv` and runtime assets through `getWorkspaceRuntimeAssets`; both now filter
  expired project rows. No vm-agent change is needed: the agent receives `managedEnv` per job.
- Readers of `project_runtime_env_vars` enumerated: `workspace-runtime-assets.ts` (filtered),
  `project-runtime-response.ts` (shows expired flag), `runtime-env-listing.ts` (filtered),
  `crud.ts` / `runtime-config.ts` (deletes). Writers: `project-runtime-env.ts` only (manual route +
  fulfilment); a manual write clears `expires_at` and `secret_request_id` (rule 73).
- Discrimination proven: removing the expiry filter in `getSecretExecutionEnv` reddens the TTL test;
  removing the project predicate in `loadRuntimeSecretRequest` reddens the cross-project test; the
  card width assertion fails on the pre-fix build (408px over).
- Attention markers deliberately not reused: the bell's free-text answers would send text to the
  agent, so a human could paste the secret there.
