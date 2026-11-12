---
title: Webhook Triggers
description: Start SAM tasks from any service that can send a JSON webhook, including Slack and services that sign their requests.
---

Generic webhook triggers let external systems submit task context to an agent without a provider-specific integration. Each trigger has deterministic payload filters, a template, an agent profile, a concurrency policy, and a redacted delivery history. For schedule and GitHub triggers, and for asking an agent to set a trigger up, see [Triggers](/docs/guides/triggers/).

There are two ways a caller proves itself, chosen when the trigger is created and fixed afterwards:

| Who is calling                              | How SAM verifies it                                    | Address                                          | When the trigger is busy                      |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------- |
| Your own script or service                  | A secret token SAM gives you, sent as a bearer token   | One shared address, `/api/webhooks/ingest`       | The call is recorded as skipped               |
| Slack, or a service that signs its requests | The sender's own signing secret, which you save in SAM | Its own address, `/api/webhooks/in/<trigger id>` | The event waits and starts when a run is free |

The first is described under [Create a Trigger](#create-a-trigger) and [Send a Delivery](#send-a-delivery). The second is described under [Signed webhooks](#signed-webhooks-slack-and-hmac).

## Create a Trigger

Open a project, select **Automation**, then **New automation**, and choose **When another service
calls SAM**. Configure:

- **Who is calling?** Pick **My own script or service** for a token webhook. The other two choices
  are [signed webhooks](#signed-webhooks-slack-and-hmac).
- Optionally, a **Source label**, safe **Included headers** to expose to the prompt, and **Payload
  filters** that must all (**Match all**) or any (**Match any**) match.
- An explicit agent profile (**Agent**). Webhook triggers do not fall back to an implicit profile.
- Optionally, a **Skill** to apply as a profile-override layer for triggered runs.
- **What should it do?**: the prompt template, using the webhook context described below.
- Under **Advanced options**, the normal skip-if-running and concurrency controls.

SAM shows the raw token only after creation or rotation. Copy it before closing the credential dialog. Later API responses expose only the final four characters. A trigger an agent created never shows its token in the UI: the agent receives a one-time link instead (see [Creating Webhooks through MCP](#creating-webhooks-through-mcp)), and you can always get a new token with **Get a new token** on the trigger's page.

## Send a Delivery

Send a JSON object to the shared ingress endpoint shown with the credential:

The ingress endpoint is `https://api.<your-domain>/api/webhooks/ingest` — the credential dialog shows the exact URL for your deployment.

```bash
curl --request POST 'https://api.your-domain.com/api/webhooks/ingest' \
  --header "Authorization: Bearer $SAM_WEBHOOK_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: deployment-1234' \
  --data '{"deployment":{"status":"failed","id":"1234"}}'
```

The request must use `Content-Type: application/json`, and the top-level value must be an object. Put the token in the `Authorization` header—not the URL or query string. `Idempotency-Key` is optional; when supplied, it permanently identifies one submission attempt. An identical delivery that received a transient `503` before an execution was linked may retry with the same key. Once linked, SAM never resubmits that key: a durable TaskRunner start is repaired and returned as the linked execution, while a definitively failed attempt keeps returning `503`. Use a new key only when you intentionally want a new attempt. Rate-limit and configuration rejections happen before an idempotency reservation, so the same key can be retried after the condition clears. Reusing a key for a different payload is treated as a duplicate.

Successful admission returns HTTP `202`. The response indicates whether the delivery created an execution, was filtered, was a duplicate, or was skipped by trigger policy. Invalid credentials return a uniform `404`; overload protection can return `429`, and a durable submission failure returns `503`.

A call that reaches the automation is also recorded as a project event (source `webhook`, with the trigger ID as its subject), so agents can wait for it the same way they wait for GitHub events. Types include `webhook.accepted`, `webhook.filtered`, `webhook.still_running`, `webhook.inactive` for a paused automation, and `webhook.internal_error` when the run couldn't be submitted. Signed triggers also record `webhook.challenge` when the provider checks the address and `webhook.rejected` when a current, correctly signed call is refused (a body that is not a JSON object, or a missing event ID; at most one of each per minute, with the reason and no request content). Refusals anyone can cause without the secret appear in the call log and the setup status but are not project events, so they cannot wake agents: a wrong signature, no saved secret, a stale timestamp (a captured request keeps its valid signature after it ages out), and a signed body repeated under a new header ID; for them `webhook.accepted` means the event was verified and recorded, which can be before its run starts. Calls SAM refuses before that aren't recorded: an invalid token, a malformed or oversized body, a missing agent profile, or the rate limit. Duplicates aren't recorded either, so check the HTTP response rather than count on an event for every call. The event carries the delivery ID, the outcome, the trigger's name and source label, and the run it started, plus a summary of the request's shape: how many headers SAM kept, and how many keys and values the JSON body has. It doesn't include the body or header values; those reach the run's instructions through the [template context](#template-context).

## Signed webhooks (Slack and HMAC)

Slack and many other services cannot send SAM's token. They sign each request with a secret you
already share with them, so SAM verifies that signature instead. A signed trigger has its own
address, which names the trigger and is not a credential, and a signing secret that a person saves
on the trigger's page.

Two schemes ship today:

| Scheme             | For                                                                   | What SAM checks                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack_v0`         | Slack Events API                                                      | `X-Slack-Signature` (`v0=` and a hex HMAC-SHA256) over `v0:<X-Slack-Request-Timestamp>:<raw body>`, and that the timestamp is within five minutes |
| `hmac_sha256_body` | Services that sign the raw body the way GitHub repository webhooks do | An HMAC-SHA256 of the raw body in a header you name, as hex or base64, with or without a `sha256=` prefix                                         |

Other senders that use the second layout should work, but check the sender's own documentation
first: the header name, and whether it signs exactly the raw body. Schemes that sign a timestamp
together with the body in another format (Stripe, Standard Webhooks) and providers with their own
handshake are not supported yet.

### Set up Slack

In **New automation**, choose **When another service calls SAM**, then **Slack**. SAM fills in
conditions that start a run only for a mention that did not come from a bot, and starting
instructions you can edit. After you create it, the trigger's page shows a **Connect Slack** panel:

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Copy its **Signing Secret** (Basic Information, App Credentials) and save it in the panel.
3. In **Event Subscriptions**, paste the panel's address as the **Request URL** and subscribe to the
   bot event `app_mention`. Slack checks the address straight away; SAM answers that check only
   when its signature is valid, and it starts nothing.
4. Install the app, invite it to a channel and mention it.

The panel's status line tells you where things stand: **Paste the signing secret to continue**,
**Waiting for the first request**, **Receiving · last event 2 min ago**, or **Requests are being
refused** with the reason.

Two things to know before you invite the app anywhere:

- Anyone who can mention the app can start a run that uses the trigger's agent profile and the
  trigger owner's access. The message reaches the agent as untrusted input; write the instructions
  accordingly. The default conditions limit runs to mentions.
- A Slack signing secret belongs to the app, not to one workspace. If the app is installed in more
  than one workspace, add a condition `team_id` **equals** your workspace's ID (it is in every event
  Slack sends) so only that workspace can start runs.
- To reply in Slack, the agent needs its own Slack connection or bot token. The signing secret only
  lets SAM receive events.

A run starts on a virtual machine, so the first response to a mention takes minutes, not seconds.
Each mention starts its own chat; a follow-up in the same Slack thread starts a new one.

### Set up another signed service

Choose **Another service that signs its requests** and give:

- **Signature header**: where the service puts the HMAC. GitHub uses `x-hub-signature-256`.
- **Where is the event ID?**: a header or a path in the JSON body. GitHub sends it in the
  `x-github-delivery` header.

Then save the service's secret on the trigger's page and give the service the trigger's address.

This scheme signs the body only, with no timestamp. SAM refuses a replayed request by its event ID
for as long as it keeps the call log (seven days by default, and at least as long as an event can
wait); after that, a captured request replayed byte for byte would be taken as new. When the event
ID comes from a header, which the signature does not cover, SAM cannot tell a replay of a captured
request under a fresh ID from a new event with the same body. So a signed body it has already taken
under another ID starts nothing: SAM answers `202` with `ignored: "repeated_body"` and records
**Refused: same body as an earlier event, under a new ID**. Identical bodies for different events
are not supported with a header ID; read the ID from the body when the service puts one there.

SAM uses the secret exactly as saved, except that leading and trailing spaces and line breaks are
removed, because pasting often adds them. A sender whose secret really starts or ends with a space
cannot be verified.

### The event ID

Every signed trigger says where the sender's own event ID is, because providers retry. A retry
with the same ID starts nothing and is recorded as **Ignored: already received**. An event without
a readable ID (missing, empty, an object or array, a number that is not an exact integer below
2^53, or longer than 200 bytes) starts nothing
either: SAM answers `202` so the provider does not switch the subscription off, records
**Refused: the event had no ID**, and the status line says so. SAM never falls back to skipping the
duplicate check.

### Waiting while the trigger is busy

A verified event that matches the conditions is recorded before SAM answers, then waits for a free
run:

- By default a signed trigger runs one event at a time and the rest wait their turn. Events that
  arrive one after another start in arrival order. Calls that overlap (a second arrives before
  SAM has answered the first) have no order between them: either may start first. Turn off
  **One run at a time** and raise **Most runs at once** under **Advanced options** to run several.
- A waiting event starts when a run slot frees. SAM checks right after each new event and every
  five minutes, so a waiting event can take up to five minutes to start after a slot frees.
- Up to 50 events can wait per trigger. When the line is full SAM answers `429` with `Retry-After`
  and does not use up the event ID, so the provider's retry is accepted once there is room.
- An event that waits longer than 24 hours is dropped and shown as **Dropped: waited too long for a
  free run**.
- If starting a run fails, SAM retries it on the same five-minute cadence until it starts or
  expires. Repeated failures pause the trigger, as for other triggers.
- While a trigger is paused, new events are recorded as ignored and are not queued. Events already
  waiting stay in line until they expire.

Both limits are installation settings; see [Runtime Configuration](#runtime-configuration).

### What a signed sender sees

| Response                      | Meaning                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `202`                         | Answered, not necessarily queued: only `queued: true` means the event was recorded for a run. Otherwise the body says why (`duplicate`, `filtered`, `inactive`, or `ignored` with `missing_event_id` / `repeated_body`). |
| `200` with the challenge text | Slack's address check (`url_verification`)                                                                                                                                                                               |
| `401`                         | The signature is missing or wrong, or Slack's timestamp is outside the window                                                                                                                                            |
| `503`                         | No signing secret is saved yet, the saved conditions cannot be read, or SAM could not record the event; retry                                                                                                            |
| `429`                         | Too many calls, or too many events already waiting                                                                                                                                                                       |
| `413`, `400`                  | The body is larger than 64 KiB, or is not a JSON object                                                                                                                                                                  |
| `404`                         | No signed trigger has this address                                                                                                                                                                                       |

Error responses have the body `{ "accepted": false, "error": "<CODE>", "message": "…" }`, with
codes such as `UNAUTHORIZED`, `TOO_MANY_REQUESTS` and `SERVICE_UNAVAILABLE`.

Refused calls appear under **Calls received** with the reason. Repeated refusals for the same
reason within a minute share one row, so a flood of forged calls cannot fill the log.

### When nothing happens

| What you see                                                          | Likely cause                                                                  | What to do                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Slack says the Request URL could not be verified                      | No signing secret saved, or the wrong one                                     | Save the app's Signing Secret (not a bot token), then use Slack's **Retry** |
| **Requests are being refused: the signature doesn’t match**           | The saved secret is not the sender's current one, or a proxy changes the body | Select **Replace secret** and paste the current one                         |
| **Requests are being refused: the requests are too old**              | The sender is replaying old requests or its clock is wrong                    | Check the sender; the window is five minutes                                |
| Calls show **Ignored: did not match the filters**                     | The event is not a mention, or it came from a bot                             | Edit the conditions on the trigger                                          |
| Calls show **Refused: the event had no ID**                           | The event ID location is wrong for this sender                                | Edit the trigger and correct it                                             |
| Calls show **Refused: same body as an earlier event, under a new ID** | A replayed request, or a sender that reuses bodies with a header ID           | Read the event ID from the body if the sender puts one there                |
| Calls show **Failed: the saved conditions could not be read**         | The stored conditions are damaged                                             | Open **Edit**, set the conditions and save                                  |
| Calls show **Waiting for a free run** for a long time                 | Earlier runs are still going                                                  | Raise **Most runs at once**, or stop a run that is stuck                    |
| Nothing under **Calls received**                                      | The sender is not calling this address                                        | Check the URL in the sender's settings, and that the app is in the channel  |

## Template Context

Webhook templates can interpolate:

| Variable                                           | Meaning                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `{{webhook.payload}}`                              | Canonical compact JSON for the complete object |
| `{{webhook.body.path.to.value}}`                   | A field from the JSON body                     |
| `{{webhook.headers.x-event-type}}`                 | A configured safe request header               |
| `{{webhook.receivedAt}}`                           | ISO 8601 receipt time                          |
| `{{webhook.deliveryId}}`                           | Delivery audit identifier                      |
| `{{webhook.sourceLabel}}`                          | Optional label configured on the trigger       |
| `{{trigger.id}}`, `{{trigger.name}}`               | Trigger identity                               |
| `{{project.id}}`, `{{project.name}}`               | Project identity                               |
| `{{execution.id}}`, `{{execution.sequenceNumber}}` | Reserved execution identity                    |

Templates are rendered as plain text. Strings keep their original quotes, ampersands, Markdown, and HTML-like characters; SAM does not HTML-entity encode agent prompts. Interpolating a complete object or array, such as `{{webhook.body}}` or `{{webhook.headers}}`, produces canonical compact JSON with deterministic object-key ordering. `null` renders as `null`, while a missing path renders blank. An optional source label that has not been configured therefore renders blank. If an interpolated value or the complete prompt exceeds its configured bound, the rendered text includes `[truncated by SAM]` at the truncation point.

Use **Try it with a sample** on the trigger's page to test a sample payload, filters, and rendered prompt without starting work. A manual run through the API accepts the same optional sample context but creates a real execution.

## Filters and Headers

Filters use dot-separated object paths and one of four operators:

- `exists` matches when the path is present. It does not take a value.
- `notExists` matches when the path is absent. It does not take a value. Slack triggers use it on
  `event.bot_id` so the app's own messages do not start runs.
- `equals` uses strict comparison against a string, number, boolean, or `null`.
- `contains` checks a substring in a string or an exact element in an array.

With `all` mode every filter must match; with `any` mode at least one must match. Filtered deliveries return `202` and remain visible under **Calls received** on the trigger's page, but they do not create executions.

Only explicitly configured headers are copied into template context. SAM rejects credential- and signature-like names such as `Authorization`, `Cookie`, `X-API-Key`, and headers containing `token`. This allowlist is for safe metadata such as an event type or tenant ID. A provider's signature is checked by a [signed webhook](#signed-webhooks-slack-and-hmac), which reads the signature header itself and never passes it to the prompt.

## Credential Lifecycle and Audit

Tokens contain 32 random bytes and use the `sam_wh_` prefix. SAM stores a keyed hash, never the raw token. Rotating a credential invalidates the previous token immediately and shows the replacement once.

A signing secret is stored encrypted. No API returns it, it never appears in a log, and an agent cannot set or read it; replacing it takes effect at once, so calls signed with the old secret are refused until the sender uses the new one.

SAM does not retain raw request bodies, arbitrary request headers, signatures, bearer tokens, idempotency keys, event IDs, or rendered prompts in webhook delivery history. That is not the same as never keeping what a webhook sent: whatever the instructions copy from the event becomes the run's task description and first chat message, and is kept like any other chat. While a signed event waits for a free run, its rendered instructions are also held with the waiting run, because that is the only copy of the event; SAM removes that copy when the run starts or when the event is dropped. The audit contains outcome, HTTP status, byte count, timestamps, and linked execution/error identifiers. Canonical ProjectData webhook events retain only bounded, redacted facts for subscription matching and delivery. Audit records expire automatically; the default retention is seven days.

Disabling or pausing a trigger prevents new webhook work. Best-effort IP and per-trigger request damping reduces bursts; because Cloudflare KV counters are eventually consistent, it is not a strict distributed quota. The shared trigger admission path enforces skip-if-running, concurrency, durable execution reservation, failure tracking, and task submission for cron, GitHub, webhook, and manual sources. A previous run whose task has gone to sleep is not running, so it no longer holds a skip-if-running or concurrency slot; its conversation stays available and a message can still wake it.

## Management API

Authenticated project members can use the same management surface as the UI. Project read access permits preview and redacted history; project write access is required to create, update, or rotate credentials:

| Method  | Endpoint                                                              | Purpose                                                                           |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST`  | `/api/projects/:projectId/triggers`                                   | Create a trigger; webhook creation returns the one-time credential                |
| `PATCH` | `/api/projects/:projectId/triggers/:triggerId`                        | Update common settings, filters, and included headers                             |
| `POST`  | `/api/projects/:projectId/triggers/:triggerId/webhook/preview`        | Preview filters, context, and rendering                                           |
| `POST`  | `/api/projects/:projectId/triggers/:triggerId/webhook/rotate`         | Rotate and return a replacement token once                                        |
| `PUT`   | `/api/projects/:projectId/triggers/:triggerId/webhook/signing-secret` | Save or replace a signed trigger's secret (`{ "secret": "..." }`); never returned |
| `GET`   | `/api/projects/:projectId/triggers/:triggerId/webhook/deliveries`     | Read paginated redacted delivery metadata                                         |

A webhook trigger's `webhookConfig` reports `verification` (the scheme), `eventId`, `endpointUrl`, and for a signed trigger `signingSecret` (`set`, `setAt`, `setBy`, never the value). Reading one signed trigger also returns `setup`: its state (`needs_secret`, `waiting_for_first_request`, `receiving` or `rejecting`), how many events are waiting, and the last refusal with a hint. To create a signed trigger over REST, send `webhookConfig.verification` (`{ "scheme": "slack_v0" }`, or `{ "scheme": "hmac_sha256_body", "header": "x-hub-signature-256" }`) and, for the second, `webhookConfig.eventId` (`{ "header": "x-github-delivery" }` or `{ "path": "id" }`).

## Creating Webhooks through MCP

An agent can set up either kind. For a signed webhook, call `create_trigger` with `sourceType: "webhook"`, an `agentProfileId`, and `webhookConfig: { "verification": { "scheme": "slack_v0" } }` (or the `hmac_sha256_body` form above). The result has no credential and no claim. It carries `webhookConfig.endpointUrl`, the address to give the sender, and `webhookConfig.setup.secretEntryUrl`, a link to the trigger's page. The agent gives you that link and you save the signing secret there, on the trigger's page. Never paste a signing secret into a chat or into tool arguments: once it is there it is in the transcript, and `create_trigger` refusing a secret argument does not remove it. The agent then calls `get_trigger`, or waits on the trigger's `webhook.challenge`, `webhook.accepted` and `webhook.rejected` project events, to see that the address was confirmed, that the first event arrived, or why calls are refused. `get_trigger` returns the configuration, the setup state and recent calls without bodies, so a different agent can pick up an interrupted setup.

The rest of this section is about token webhooks.

Use `create_trigger` with `sourceType: "webhook"`, an explicit project-local `agentProfileId`, and `webhookConfig` (for example `{ "sourceLabel": "build", "filters": [] }`). The result includes the trigger ID and `webhookClaim` containing `claimUrl`, `expiresAt`, and the ingress endpoint. The credential never appears in the MCP response.

Redeem from the originating workspace/session with its existing `SAM_MCP_TOKEN`. No SAM CLI installation is needed. The URL alone grants no access. An authenticated POST succeeds once; GET, HEAD, expired claims, and replays cannot retrieve the token. The default lifetime is ten minutes. Current project write membership is checked again at redemption.

:::caution[Only Codex sessions can redeem]
SAM sets `SAM_MCP_TOKEN` only for **Codex** sessions. **Claude Code**, **OpenCode**, **Gemini CLI**,
**Mistral Vibe**, and **Amp** receive their SAM credential another way, so the variable is empty in
their shell and redemption fails with an authentication error. In that case, open the trigger's page
in SAM, select **Get a new token** and confirm, and copy the endpoint and token from the **Save your
webhook credential** dialog into the sending service yourself. Replacing the token cancels the
pending claim.
:::

Pipe the response into a secret command accepting stdin. This Bash example keeps authentication out of curl's process arguments and rejects empty input before updating a Cloudflare Worker secret:

```bash
set +x
set -o pipefail
CLAIM_URL='<webhookClaim.claimUrl>'
curl --fail --silent --show-error --request POST \
  --config <(printf 'header = "Authorization: Bearer %s"\n' "$SAM_MCP_TOKEN") \
  "$CLAIM_URL" | (
    IFS= read -r secret || test -n "$secret"
    [[ "$secret" =~ ^sam_wh_[A-Za-z0-9_-]{43}$ ]] || exit 1
    printf '%s' "$secret" | wrangler secret put SAM_WEBHOOK_TOKEN --name my-worker
  )
```

`wrangler` needs Cloudflare credentials in the same shell. In a fresh workspace, a variable marked
**Secret** is only a placeholder there (see [Run commands with secrets](/docs/guides/secret-execution/)),
so if that's how the credential is stored, rotate the token in SAM and set it in the sending service
yourself.

Check that the pipeline succeeded. Do not print the response, use a model-visible fetch tool, enable tracing or HTTP verbosity, or automatically retry redemption. A lost response cannot be recovered: rotate through the UI/REST API, or delete the unused trigger and create a replacement. Rotation invalidates pending claims immediately. The recipient sends `Authorization: Bearer <stored token>` to the returned ingress endpoint.

This implements webhook delivery; a general sensitive-input or ACP framework remains future work.

## Runtime Configuration

Self-hosted deployments can tune the ingress body limit, filter limits, rate windows, and audit retention. See the [Configuration Reference](/docs/reference/configuration/#generic-webhook-triggers).

Three limits for signed webhooks are admin settings, under **Admin**, **Settings**, **Operations**:

| Setting                                       | Default | Meaning                                                     |
| --------------------------------------------- | ------- | ----------------------------------------------------------- |
| `operations.webhookQueueMaxPending`           | 50      | Events one signed trigger can hold while its runs are busy  |
| `operations.webhookQueueTtlSeconds`           | 86400   | How long an event waits for a free run before it is dropped |
| `operations.webhookSignatureToleranceSeconds` | 300     | How far a signed timestamp may differ from SAM's clock      |

## GitHub event triggers

GitHub events are set up from **When something happens on GitHub** in the same **New automation**
flow. Their filters, what happens when a GitHub trigger is busy, and how follow-up comments reach the
chat that's already working are covered in [Triggers](/docs/guides/triggers/).
