# Enforce allowedModelTiers at AI Proxy Gate

## Problem

The `allowedModelTiers` field in `AdminAiAllowance` is stored via the admin API (`PUT /admin/ai/allowances/:userId`) but never enforced at inference time in the AI proxy routes (`/ai/v1/chat/completions`, `/ai/v1/messages`, `/ai/v1/responses`).

An admin can set `allowedModelTiers: ["standard"]` for a user, but the user can still use any model tier including expensive frontier models.

## Context

Discovered during security/Cloudflare specialist review of PR #1073. This is a pre-existing gap — the field was added as part of the admin budget controls feature before PR #1073.

## Acceptance Criteria

- [x] AI proxy request handler checks the requesting user's `allowedModelTiers` against the requested model's tier
- [x] If the model tier is not in the allowed list, return 403 with a clear error message
- [x] Model-to-tier mapping is defined (e.g., `claude-opus-4-7` → `frontier`, `claude-haiku-4-5` → `standard`)
- [x] Admin can set `allowedModelTiers: null` to allow all tiers (default behavior)
- [x] Tests cover: allowed tier passes, disallowed tier blocked, null allows all

## Resolution (2026-09-27)

Implemented under `tasks/archive/2026-09-27-close-four-api-security-gaps.md`. The tier map is the
catalog's own `PlatformAIModel.tier` (`low-cost | standard | premium`), read through
`getPlatformAIModelTier`; the spec's `frontier` example does not exist. The native Anthropic path is
`/ai/anthropic/v1/messages` (plus `count_tokens`), not `/ai/v1/messages`.

