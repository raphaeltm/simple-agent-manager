# agent-credential-sync payload cap trusts the Content-Length header

## Problem

`POST /api/workspaces/:id/agent-credential-sync` (`apps/api/src/routes/workspaces/agent-credential-sync.ts`)
enforces `MAX_AGENT_CREDENTIAL_SYNC_BYTES` by reading the `content-length` header and treating a
missing header as `0`. A chunked request without that header is read in full by `jsonValidator`.
The route is workspace-callback-JWT authenticated, so this is a resource-use concern, not a
credential-isolation one.

## Context

Found by the adversarial security re-verification for task 01M6WSQF12ENN5G2FFFHXHT59N (Codex
refresh pin fix). Pre-existing: the same check lived in `routes/workspaces/runtime.ts` before the
route was extracted.

## Acceptance Criteria

- [ ] The body is read with a byte limit (as the messages route does with `readRequestBodyWithLimit`)
      before JSON validation, so an absent or false `content-length` cannot bypass the cap
- [ ] A test sends an oversized body without `content-length` and gets 400 (or 413) with nothing written
