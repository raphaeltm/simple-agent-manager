# Enforce allowedModelTiers at AI Proxy Gate

## Problem

The `allowedModelTiers` field in `AdminAiAllowance` is stored via the admin API (`PUT /admin/ai/allowances/:userId`) but never enforced at inference time in the AI proxy routes (`/ai/v1/chat/completions`, `/ai/v1/messages`, `/ai/v1/responses`).

An admin can set `allowedModelTiers: ["standard"]` for a user, but the user can still use any model tier including expensive frontier models.

## Context

Discovered during security/Cloudflare specialist review of PR #1073. This is a pre-existing gap — the field was added as part of the admin budget controls feature before PR #1073.

## Acceptance Criteria

- [ ] AI proxy request handler checks the requesting user's `allowedModelTiers` against the requested model's tier
- [ ] If the model tier is not in the allowed list, return 403 with a clear error message
- [ ] Model-to-tier mapping is defined (e.g., `claude-opus-4-7` → `frontier`, `claude-haiku-4-5` → `standard`)
- [ ] Admin can set `allowedModelTiers: null` to allow all tiers (default behavior)
- [ ] Tests cover: allowed tier passes, disallowed tier blocked, null allows all
