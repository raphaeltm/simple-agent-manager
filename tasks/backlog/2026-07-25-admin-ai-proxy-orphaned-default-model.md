# Admin AI Proxy UI: Handle KV Default Model No Longer in Catalog

## Problem

`GET /api/admin/ai-proxy/config` returns `defaultModel` from the KV override
(`platform:ai-proxy:default-model`) verbatim, plus `models[]` built from the current
`PLATFORM_AI_MODELS`. If an admin-selected default is later removed from the catalog
(model retirement — e.g. the `claude-sonnet-4-20250514` pruning on 2026-07-25), the
admin page's select holds a value that matches no option, `hasChanges` stays false so
Save is effectively stuck, and zero-config sessions resolving the KV default via
`resolveModelId` get allowlist rejections with no admin-facing signal.

## Context (where/when discovered)

Found 2026-07-25 during review of the Claude Opus 5 catalog PR
(`tasks/active/2026-07-25-add-claude-opus-5-model-catalog.md`). Verified NOT currently
triggered: production KV default is `@cf/google/gemma-4-26b-a4b-it` (read via CF API,
2026-07-25). This is a robustness gap for future retirements, especially self-host forks.

## Acceptance Criteria

- [ ] Admin AI Proxy page visibly flags a stored default that is no longer in the
      catalog (e.g. "no longer available — pick a replacement") and allows saving a new one
- [ ] `resolveModelId` consumers degrade predictably when the KV default is
      no-longer-registered (documented/decided: fall through to env/constant vs explicit error)
- [ ] Regression test: config GET with a KV default absent from `PLATFORM_AI_MODELS`
      renders the picker in a recoverable state (behavioral, rendered component)
