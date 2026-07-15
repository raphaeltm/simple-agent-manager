---
title: Webhook Triggers
description: Start SAM tasks from any service that can send an authenticated JSON webhook.
---

Generic webhook triggers let external systems submit task context to an agent without a provider-specific integration. Each trigger has its own bearer token, deterministic payload filters, template, agent profile, concurrency policy, and redacted delivery history.

## Create a Trigger

Open a project, select **Triggers**, and create a **Webhook** trigger. Configure:

- An explicit agent profile. Webhook triggers do not fall back to an implicit profile.
- Optionally, a skill to apply as a profile-override layer for triggered runs.
- A prompt template using the webhook context described below.
- Optional `all` or `any` payload filters.
- Optional safe request headers to expose to the prompt.
- The normal trigger concurrency and skip-if-running controls.

SAM shows the raw token only after creation or rotation. Copy it before closing the credential dialog. Later API responses expose only the final four characters.

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

Use **Preview** on the trigger detail page to test a sample payload, header selection, filters, and rendered prompt without starting work. A manual run accepts the same optional sample context but creates a real execution.

## Filters and Headers

Filters use dot-separated object paths and one of three operators:

- `exists` matches when the path is present. It does not take a value.
- `equals` uses strict comparison against a string, number, boolean, or `null`.
- `contains` checks a substring in a string or an exact element in an array.

With `all` mode every filter must match; with `any` mode at least one must match. Filtered deliveries return `202` and remain visible in delivery history, but they do not create executions.

Only explicitly configured headers are copied into template context. SAM rejects credential- and signature-like names such as `Authorization`, `Cookie`, `X-API-Key`, and headers containing `token`. This allowlist is for safe metadata such as an event type or tenant ID, not for authenticating another provider's signature scheme.

## Credential Lifecycle and Audit

Tokens contain 32 random bytes and use the `sam_wh_` prefix. SAM stores a keyed hash, never the raw token. Rotating a credential invalidates the previous token immediately and shows the replacement once.

SAM does not retain raw request bodies, arbitrary request headers, bearer tokens, idempotency keys, or rendered prompts in webhook delivery history. The audit contains outcome, HTTP status, byte count, timestamps, and linked execution/error identifiers. Audit records expire automatically; the default retention is seven days.

Disabling or pausing a trigger prevents new webhook work. Best-effort IP and per-trigger request damping reduces bursts; because Cloudflare KV counters are eventually consistent, it is not a strict distributed quota. The shared trigger admission path enforces skip-if-running, concurrency, durable execution reservation, failure tracking, and task submission for cron, GitHub, webhook, and manual sources.

## Management API

Authenticated project members can use the same management surface as the UI. Project read access permits preview and redacted history; project write access is required to create, update, or rotate credentials:

| Method  | Endpoint                                                          | Purpose                                                            |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST`  | `/api/projects/:projectId/triggers`                               | Create a trigger; webhook creation returns the one-time credential |
| `PATCH` | `/api/projects/:projectId/triggers/:triggerId`                    | Update common settings, filters, and included headers              |
| `POST`  | `/api/projects/:projectId/triggers/:triggerId/webhook/preview`    | Preview filters, context, and rendering                            |
| `POST`  | `/api/projects/:projectId/triggers/:triggerId/webhook/rotate`     | Rotate and return a replacement token once                         |
| `GET`   | `/api/projects/:projectId/triggers/:triggerId/webhook/deliveries` | Read paginated redacted delivery metadata                          |

The MCP `create_trigger` tool remains cron-only. Use the UI or authenticated REST API for webhook creation and credential operations so the one-time token is handled explicitly.

## Runtime Configuration

Self-hosted deployments can tune the ingress body limit, filter limits, rate windows, and audit retention. See the [Configuration Reference](/docs/reference/configuration/#generic-webhook-triggers).
