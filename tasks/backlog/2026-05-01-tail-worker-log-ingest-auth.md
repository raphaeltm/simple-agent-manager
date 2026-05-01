# Tail worker log ingest endpoint requires auth

## Problem

The production tail worker forwards Worker logs to `POST /api/admin/observability/logs/ingest`, but that internal service-binding request is being rejected with `Authentication required`.

This generates thousands of `request_error` entries from `sam-api-prod` and pollutes Cloudflare Workers Observability, making real production errors harder to isolate.

## Context

Discovered while investigating production chat session load failures on 2026-05-01. Cloudflare Workers Observability showed repeated `request_error` events for:

- `POST /api/admin/observability/logs/ingest`
- error: `Authentication required`
- source route: tail worker service binding request from `sam-tail-worker-prod`

The chat UI failure had a separate root cause: oversized ProjectData DO RPC message responses.

## Acceptance Criteria

- [ ] Tail worker log ingestion succeeds without end-user authentication for internal service-binding calls.
- [ ] The ingest route still rejects browser/user-originated unauthenticated requests.
- [ ] A regression test covers the internal ingest path.
- [ ] Production/staging observability no longer shows repeated `Authentication required` errors for `/api/admin/observability/logs/ingest`.
