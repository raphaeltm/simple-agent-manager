# Signed webhooks (Slack + generic HMAC) with durable intake queue

SAM task `01M75T87NC15D23HG4ZT73GZRY`, idea `01M75HV6542HC5D1VNQ4SGT6PE`, coordinator task
`01M75G7GM3F5999DMNV6YKA2TB`, channel `feature.signed-webhooks`.
Branch `sam/implement-ship-reusable-signed-73gzry`.

## Problem

"When another service calls SAM" automations only accept SAM's own bearer token. Providers that
sign their requests (Slack, GitHub repository webhooks) cannot send that token, so agents cannot
react to them. Raphaël approved the lean v1 from the idea **plus a required bounded durable queue**:
a verified event that arrives while the automation is busy must be recorded and wait, not be
acknowledged and dropped. Thread continuity, Stripe/Standard Webhooks, manifests, secret overlap,
extra field mapping and per-automation limits stay out of scope.

## Release constraints (from the brief)

- PR opens as a **draft** and stays one until the coordinator approves the exact full head SHA.
- Shared staging: coordinate a bounded slot, verify UI + REST + MCP, real Slack proof required.
- Production: basic smoke only.

## Research findings

1. Ingest today: `apps/api/src/routes/trigger-webhooks.ts` (`handleWebhookIngress`) resolves the
   automation from the bearer token, reserves a `webhook_deliveries` row keyed by the hashed
   `Idempotency-Key` (`createWebhookDelivery`), evaluates filters, then admits and submits inline
   (`admitAndSubmitTriggerExecution`). Over the run limit it records a skipped execution.
2. Durable queue today: `apps/api/src/services/github-trigger-queue.ts`. A `trigger_executions`
   row in `waiting` with `queue_expires_at` and `rendered_prompt` is promoted FIFO under
   `max_concurrent` by `processGitHubTriggerExecution`, retried by `drainGitHubTriggerQueue` from
   the 5-minute cron (`runGitHubTriggerRecovery`), and dropped as `queue_expired` after its TTL.
   The engine is source-agnostic apart from: `triggeredBy: 'github'`, the GitHub audit sync, and a
   drain that only runs when GitHub triggers are configured.
3. No raw body is stored for webhooks; the rendered prompt in `trigger_executions.rendered_prompt`
   is the only copy of event content, so for a queued event it must be committed before the ack.
4. `webhook_trigger_configs.token_hash` is `NOT NULL UNIQUE`. Signed automations get an unused,
   never-revealed token so the constraint holds without recreating the table; `/ingest` refuses
   signed automations explicitly.
5. Rejections are recorded one row per rate-limit window (`recordWebhookRejectedDelivery`), so a
   flood cannot grow the table. Outcome column has no CHECK (migration 0093).
6. `WEBHOOK_DELIVERY_OUTCOMES` and `WEBHOOK_FILTER_OPERATORS` are shared enums with hand-copied
   lists in `apps/api/src/schemas/triggers.ts`, the MCP `create_trigger` JSON schema, the sam-cli
   OpenAPI and `WebhookTriggerFields.tsx`. UI code branches on `operator === 'exists'` (rule 79).
7. Webhook tunables are env vars (`getWebhookTriggerLimits`). New tunables go in the admin
   settings registry (`admin-setting-definitions.ts`, `integerDefinition`), per policy 9017df94.
8. AES-GCM helper: `services/encryption.ts` (`encrypt`/`decrypt`) with
   `getCredentialEncryptionKey(env)`; example storage in `services/mcp-connections.ts`.
9. MCP: `create_trigger` reuses `CreateTriggerSchema` + `createTrigger()`; there is no
   `get_trigger`. Webhook project events are `webhook.<outcome>`
   (`generic-webhook-project-event-producer.ts`).
10. Slack: signature is `v0=` + hex HMAC-SHA256 of `v0:{X-Slack-Request-Timestamp}:{raw body}`,
    five-minute window (docs.slack.dev/authentication/verifying-requests-from-slack). The docs do
    not state that `url_verification` is signed; that is a staging gate with a real app.
11. No Slack test workspace/app exists in knowledge, managed secrets or Composio. Reported to the
    coordinator on 2026-11-11; Raphaël will create the app and paste the secret in staging.
12. Related incident lessons applied: rule 34 (public callback routing), rule 47 (queue rows need
    an escape: TTL expiry), rule 51 (server-side identity), rule 62 (tests enter through the real
    route), rule 63/71 (additive columns only), rule 79 (enum widening), rule 81 (bounds).

## Design decisions

- **Route**: `POST /api/webhooks/in/:triggerId` (public). Order: per-IP limit → load automation
  (404 unless a signed scheme) → bounded raw body → 503 `not_configured` when no secret → verify
  over raw bytes (401 `invalid_signature` / `stale_timestamp`) → per-automation rate limit → parse
  JSON → Slack `url_verification` answered 200 with the challenge, nothing else → event ID (202
  `missing_event_id`, no run) → duplicate check → conditions → durable queue accept → 202.
- **Schemes**: `sam_bearer` (unchanged), `slack_v0`, `hmac_sha256_body` (header name only; hex or
  base64, optional `sha256=` prefix). A closed map of tested functions; adding a scheme is one
  function, its tests, one enum value and a docs row.
- **Durable accept** (`acceptWebhookTriggerExecution`): a sequence number is taken first
  (`UPDATE ... RETURNING`, only while the automation is active and its line has room), the prompt
  is rendered with it, then one D1 batch inserts the `waiting` execution with its rendered prompt
  and admission snapshot and marks the delivery `queued` with its execution link (and keeps the
  record until the queue deadline plus retention). The batch repeats the active, room and
  delivery-lease conditions. Ordering contract for overlapping accepts: see the comment in
  `webhook-trigger-queue.ts`. The 202 is sent after that commit; starting the run happens after the response
  and again from the cron drain, so a disconnect or restart cannot lose the event.
- **Backpressure**: `max_concurrent` (or one at a time with skip-if-running) bounds runs; the queue
  holds at most `operations.webhookQueueMaxPending` live events per automation (default 50). A
  full queue answers 429 and does not consume the event ID, so a provider retry can be accepted.
- **Expiry**: `operations.webhookQueueTtlSeconds` (default 86400). Expired events are dropped as
  `queue_expired`, the delivery shows it, and the dropped prompt is cleared.
- **Bearer webhooks keep inline admission** (skip when busy) for response compatibility.
- **Secret**: `PUT /api/projects/:projectId/triggers/:triggerId/webhook/signing-secret`,
  `task:write`, AES-GCM, never returned, refuses Slack tokens and SAM webhook tokens. MCP cannot
  set it.
- **Reads**: `webhookConfig` gains `verification`, `eventId`, `endpointUrl`, `signingSecret`,
  and (single reads) `setup { state, secretEntryUrl, lastRejection }`.

## Implementation checklist

### Shared
- [x] `WEBHOOK_VERIFICATION_SCHEMES`, config input/output types, `notExists` operator, new delivery
      outcomes (`queued`, `challenge`, `rejected`, `queue_full`, `dropped`), setup types, defaults.
- [x] Slack defaults (event-ID path, two conditions, default instructions) next to the scheme list.

### API
- [x] Migration `0235_signed_webhook_triggers.sql` (additive columns) + drizzle schema.
- [x] `services/webhook-signature.ts`: two verifiers, constant-time via `crypto.subtle.verify`.
- [x] Admin settings: queue max pending, queue TTL, signature timestamp tolerance.
- [x] Valibot schema: `verification`, `eventId`, `notExists`; scheme immutable on update.
- [x] `createTrigger`: signed schemes (no token returned, no claim), Slack defaults.
- [x] Signing-secret route + store functions; `/ingest` refuses signed automations.
- [x] Queue engine: neutral names (`processQueuedTriggerExecution`, `drainTriggerQueue`), source
      from the automation, webhook delivery sync, drain independent of GitHub configuration,
      dropped webhook prompts cleared.
- [x] `services/webhook-trigger-queue.ts`: `acceptWebhookTriggerExecution`.
- [x] `routes/trigger-webhooks-signed.ts` + shared HTTP helpers; mount under `/api/webhooks`.
- [x] Rejection/challenge records and `webhook.challenge` / `webhook.rejected` project events
      (one per window).
- [x] Setup read (`services/webhook-trigger-setup.ts`) used by REST and MCP.
- [x] MCP: `get_trigger`; `create_trigger` accepts scheme + event ID, refuses a secret, returns
      address, setup state and secret-entry link.
- [x] OpenAPI (sam-cli) and api-reference skill entries.

### Web
- [x] Editor "who is calling?" step (Slack / signed service / my own script), `notExists`.
- [x] Connect panel for signed automations: address, secret field, Slack steps, status line,
      two plain warnings. Phone-usable.
- [x] Calls received wording for the new outcomes; advanced rows.
- [x] Unit tests + Playwright audit (375px and 1280px) with stress data.

### Docs
- [x] `guides/webhook-triggers.md`: schemes, Slack steps, queue behaviour, what is retained,
      symptom-to-fix table, limits. `guides/triggers.md`, `reference/configuration.md`,
      `guides/admin-settings.md` if it lists settings.

### Tests (API)
- [x] Verifier unit tests incl. GitHub's published vector and Slack's documented example.
- [x] Route vertical slice on real SQLite: challenge starts nothing; forged/stale/missing
      signature; no secret; missing/malformed/oversized event ID; duplicate retry; filtered;
      bot-loop filter; second HMAC sender through the same core; burst waits then drains via the
      real drain; queue full 429 then accepted on retry; expiry drop clears prompt; committed
      event survives a response that never ran post-commit work; bearer `/ingest` refuses a
      signed automation; bearer path unchanged.
- [x] Secret route: viewer refused, cross-project refused, value never returned, bad values refused.
- [x] MCP `get_trigger` / `create_trigger` through the real tool handler.
- [x] GitHub queue regression tests still pass after the rename.

### Coordinator and specialist review fixes (continuation task 01M76DBQQBTN6C521N9B0MHT17)
- [x] Expiry + GitHub audit in one batch, bounded through idx_trigger_queue_expiry (no scan of
      dropped rows); webhook repair isolated in its own batch so it cannot stop expiry.
- [x] Post-start bookkeeping in one batch (`settleWebhookQueueRecord`); cron repair
      (`repairWebhookQueueRecords`) relinks a lost task boundary and restores
      trigger_count/last_triggered_at exactly once, settles `queued` records, clears prompts.
- [x] Webhook queue discriminator requires `queue_expires_at IS NOT NULL`: token webhook runs keep
      their prompt history (Cloudflare HIGH).
- [x] Waiting event's call record (its duplicate check) kept until its queue deadline + retention.
- [x] Ordering contract documented and proven with a concurrent-accept test.
- [x] Agent sign-in sessions cannot set a signing secret; OpenAPI lists `setup`.
- [x] Rejection project events only for refusals of signed calls; IPv6 rate limited per /64;
      KV limiters (per-caller, per-automation, unknown-address preflight) fail open on KV errors.
- [x] UI: viewer status line, Slack link (own line, new-tab cue), outcome wording/icons.

### Staging verification (shared staging, coordinated slot)
- [ ] Deploy branch head; migration 0235 applied
- [ ] UI: create Slack and HMAC automations, save secret, phone and desktop
- [ ] REST and MCP: create, get_trigger setup state, secret link, no secret in responses
- [ ] Signed fixtures: challenge creates no task, forged/stale refused, duplicate retry ignored,
      second HMAC sender, burst waits then drains, committed event survives a skipped kick
- [ ] Real Slack app: Request URL check, mention starts one run, retry starts none
      (blocked until Raphaël creates the app)
- [ ] Isolation: viewer and other project refused; bearer webhooks and GitHub triggers unchanged
- [ ] Cleanup of test automations, tasks and workspaces

## Throughput at the outer limit (rule 81)

- One run at a time (default), 50 waiting (default max), 24 h TTL (default; settable to 30 days).
  The next event is promoted by the next accepted event's kick or by the 5-minute cron, so each
  event waits at most its predecessor's run time plus 5 minutes. With 20-minute runs a full line
  of 50 drains in about 50 x 25 min = 21 h, inside the default TTL; with runs over ~24 min the tail
  of a full line expires and is shown as dropped. Raising "most runs at once" divides this.
  Promoting on run completion would remove the 5-minute gap; not in scope (follow-up idea).
- Cron cost per tick: expiry and its GitHub audit, `batchSize` (25) rows each through
  idx_trigger_queue_expiry; repair, 4 statements of at most 25 rows through two partial indexes
  that hold only live queue rows; promotion, at most 25 head-of-line candidates within the
  existing wall-time budget. Expiry clears 25 per tick (7,200/day): about 145 automations with
  full lines expiring at once would outrun it, which only delays their drop, not intake.

## Acceptance criteria

1. A real Slack mention on staging starts exactly one chat; Slack's retry starts none.
2. Slack's Request URL check succeeds with a saved secret, fails without, and never starts a run.
3. Missing, wrong or stale signatures are refused, start nothing and are visible with a reason.
4. An event without a readable ID starts nothing and is visible.
5. Events arriving while the automation is busy wait and start in order when a slot frees; a full
   queue is refused with 429; expired events are dropped visibly; nothing disappears silently.
6. A GitHub-style HMAC sender uses the same address form, secret field, event-ID rule and log.
7. Phone-usable setup; the secret is never shown after saving.
8. An agent can create the automation, hand over the secret link and read setup state and
   refusals through MCP with no secret in the transcript.
9. Viewer can read but not change; another project cannot reach the automation, its secret route
   or its calls; bearer webhooks and GitHub triggers behave as before.
10. A committed queued event is started by the cron drain even when nothing ran after the commit.

## Implementation notes

- The queue engine kept its file (`github-trigger-queue.ts`) with neutral function names
  (`processQueuedTriggerExecution`); draining moved to `trigger-queue-drain.ts`
  (`drainTriggerQueue`, `drainTriggerQueueForTrigger`). Callers: `runGitHubTriggerRecovery`
  (cron), the signed route (after a commit), `acceptGitHubTriggerExecution`. GitHub rows behave
  as before; webhook queue rows are told apart by `WEBHOOK_QUEUE_ROW_SQL`
  (`event_type = 'webhook' AND queue_expires_at IS NOT NULL`; token webhook runs share the event
  type but have no queue deadline).
- Coordinator review at df23f942b raised two findings, both fixed: the queue's copy of a webhook
  prompt is cleared once the run's task boundary is recorded (now `settleWebhookQueueRecord`, with `repairWebhookQueueRecords` from the cron),
  and a repeated refusal in one window refreshes the row's time so the setup status reads
  `rejecting` (`recordWebhookSignedNotice`).
- Token (`sam_bearer`) webhooks keep inline admission and their response shapes; only signed
  automations queue. Confirmed with the coordinator.
- Defaults stay one run at a time; later events wait. Confirmed with the coordinator.
- A full queue answers 429 and leaves the event ID unconsumed (`queue_full` is retryable in
  `createWebhookDelivery`), so a provider retry is accepted once there is room.
- `webhook.accepted` is emitted when the event is committed, which can be before its run starts.
- Enum widenings audited (rule 79): `WEBHOOK_FILTER_OPERATORS` consumers that branched on
  `=== 'exists'` now use `isWebhookFilterPresenceOperator` (payload evaluation handles
  `notExists` explicitly; `WebhookTriggerFields.tsx`, `advanced-rows.tsx`, the Valibot schema).
  `WEBHOOK_DELIVERY_OUTCOMES` consumers: `DELIVERY_TEXT` is an exhaustive record; the
  "in progress" label is an allowlist; `readWebhookSetupStatus` keys on `rejected` only.
- Request I/O for a signed event (rule 60): KV rate-limit reads/writes, then D1: one automation
  lookup, one delivery insert, one accept batch; admin settings come from the per-isolate cache.
  Project events and starting the run happen after the response.
- The workspace was restored once without gitignored files (a provider-limit pause); nothing
  committed or in the working tree was lost.
- Playwright in this workspace runs without sudo using libraries unpacked into a user directory.

## References

- Idea `01M75HV6542HC5D1VNQ4SGT6PE`; Library `/engineering/research/inbound-webhooks-signed-providers-design.md`
- `.claude/rules/13-staging-verification.md`, `apps/api/.claude/rules/47-control-loop-io-budget.md`,
  `packages/shared/.claude/rules/79-new-enum-values-audit-every-denylist.md`
