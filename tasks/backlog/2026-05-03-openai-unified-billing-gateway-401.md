# OpenAI Unified Billing Returns 401 Through SAM AI Gateway

## Status: RESOLVED

Fixed by changing `configure-ai-gateway.sh` from PATCH to PUT (the CF AI
Gateway API doesn't support PATCH — it returned 404 "Route not found"). The
deploy script now correctly sets `authentication: true` on the `sam` gateway.

## Root Cause

Two bugs combined:

1. The `sam` gateway had `authentication: false`, so unified billing credentials
   weren't injected for external providers (OpenAI saw no API key → 401).
2. The `configure-ai-gateway.sh` deploy script used HTTP PATCH to update the
   gateway, but the Cloudflare AI Gateway API only supports PUT for updates.
   PATCH returned 404 on every deploy, silently failing to set authentication.

The deploy token always had the correct permissions (AI Gateway Write). The
HTTP method was wrong.

## Fix

Changed `configure-ai-gateway.sh` from `-X PATCH` to `-X PUT` with all
required fields per the CF API docs. Deployed to staging — the `sam` gateway
now has `authentication: true` and OpenAI gpt-4.1-mini works through it
via unified billing (zero API keys).

Ref: https://developers.cloudflare.com/api/resources/ai_gateway/methods/update/

## Acceptance Criteria

- [x] Confirm the Cloudflare account has AI Gateway unified-billing credits.
      **CONFIRMED: $10 credit added to account.**
- [x] Enable `authentication: true` on the `sam` AI Gateway.
      **FIXED: Deploy script changed from PATCH to PUT. Deployed and verified.**
- [x] Verify `gpt-4.1-mini` completes through SAM `/ai/v1`, the SAM AI Gateway
      (with authentication enabled), and the harness tool loop.
      **VERIFIED: 2 turns, 6.4s, read_file tool call, zero API keys.**
- [x] Fix deploy token permissions so `configure-ai-gateway.sh` can update the
      gateway during deploys.
      **N/A: Token already had permissions. The bug was PATCH vs PUT.**
- [x] Update `experiments/harness-sam-proxy/README.md` with findings.
