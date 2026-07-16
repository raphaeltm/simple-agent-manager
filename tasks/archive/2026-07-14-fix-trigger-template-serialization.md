# Fix Trigger Template Serialization

## Problem

Webhook prompt interpolation corrupts structured context. A real staging delivery rendered canonical JSON quotes as HTML entities, rendered `webhook.body` and `webhook.headers` as `[object Object]`, and passed that corrupted prompt into the trigger execution. Trigger prompts are plain text sent to an agent, not HTML, so HTML entity encoding is the wrong output boundary. Generic `String(value)` coercion also has no useful semantics for JSON objects or arrays.

The user explicitly decided that an unset `webhook.sourceLabel` must remain blank. Do not invent a fallback label.

## Evidence and Research

- Staging D1 delivery at `2026-07-14T14:37:45.437Z` exactly reproduced the reported output: `webhook.payload` contained `&quot;`, `webhook.body` and `webhook.headers` became `[object Object]`, and `source_label` was null.
- `apps/api/src/services/trigger-template.ts` resolves a value, calls `String(value)`, then HTML-entity encodes it. This is the exact failure point.
- `apps/api/src/services/webhook-trigger-payload.ts` already builds `webhook.payload` as canonical compact JSON while retaining `webhook.body` and selected `webhook.headers` as structured objects for dot-path access.
- Trigger prompts flow into task/session submission as plain text. Web previews render as React text, and chat Markdown uses `react-markdown` without a raw-HTML plugin. HTML safety belongs at those presentation sinks; entity encoding inside the persisted agent prompt is neither required for XSS safety nor useful against prompt injection.
- The shared renderer serves cron, GitHub, webhook, preview, and manual execution. Fixing it centrally keeps preview/live behavior aligned and prevents equivalent quote/ampersand corruption in other trigger sources.
- Per-field output defaults to 2,000 characters and total output to 8,000. Current truncation silently slices values; live webhook admission discards renderer warnings. A visible bounded truncation marker is required so agents are not handed silently incomplete context.
- Public webhook documentation promises canonical compact JSON for `webhook.payload` and dot-path access through `webhook.body`. Whole-object interpolation should use the same deterministic JSON representation without breaking nested scalar access.
- Retained incident lessons require preserving the exact symptom, tracing the current path, fixing the existing architecture first, and proving boundary behavior with realistic vertical-slice state.

## Implementation Checklist

- [x] Add one reusable deterministic JSON serialization utility for nested records and arrays.
- [x] Make trigger interpolation type-aware: strings unchanged, numbers/booleans/bigints stringified, objects/arrays canonical JSON, `null` rendered as `null`, and only `undefined` treated as missing.
- [x] Remove HTML entity encoding from the plain-text prompt renderer.
- [x] Keep an unset webhook source label as the existing empty string.
- [x] Preserve per-field and total output bounds while adding an in-band `[truncated by SAM]` marker that fits within each configured limit.
- [x] Add unit coverage for deterministic objects/arrays, null, primitives, raw HTML-like/special characters, missing values, and both truncation paths.
- [x] Add the exact reported webhook template/payload as a realistic ingress-to-submission regression test, including `{}` headers and blank source label.
- [x] Verify existing nested webhook body/header paths and cron/GitHub rendering remain correct.
- [x] Update public webhook template documentation and internal renderer comments to describe plain-text, structured-value, blank-label, and truncation semantics.
- [x] Run focused tests, lint, typecheck, full tests, build, diff checks, and mandatory specialist reviews.
- [x] Deploy to staging and verify the exact template through authenticated preview plus real webhook ingestion/task prompt persistence.
- [ ] Open a new PR, wait for every check to pass, squash-merge, and monitor the production deployment and live health.

## Acceptance Criteria

- The reported payload renders with literal JSON quotes, never HTML entities.
- `{{webhook.body}}` and `{{webhook.headers}}` render deterministic compact JSON instead of `[object Object]`.
- Nested paths such as `{{webhook.body.event.action}}` still render their scalar value.
- An unset `{{webhook.sourceLabel}}` renders blank.
- HTML-like and Markdown-like payload text is preserved in the agent prompt without becoming executable raw HTML in SAM UI sinks.
- Oversized interpolated values and total prompts contain an explicit bounded truncation marker and corresponding warning.
- Preview and live webhook execution produce the same serialization semantics.
- Cron and GitHub trigger rendering regressions remain green.
- Staging proves the exact reported template reaches the persisted task/session prompt correctly.
- CI and all required specialist reviews pass; the PR is merged and production deploy succeeds.

## Specialist Review Evidence

- Fresh task-completion-validator review: PASS with no implementation gaps.
- Fresh cloudflare-specialist review: PASS for Worker compatibility, deterministic bounded serialization, and runtime risk.
- Fresh test-engineer review: found one LOW gap because the GitHub handler suite did not reach successful rendering. Commit `98387f48b` adds a matching-event path that invokes the production `renderPrompt` callback and asserts quotes, ampersands, Markdown, and HTML-like text remain literal.
- Post-fix validation: 67 focused renderer/ingress tests, API typecheck, formatting, and ESLint pass.
- The original interrupted reviewer attempts were superseded by the completed fresh reviews above; their history remains recorded in PR #1585.

## References

- `tasks/archive/2026-07-13-generic-webhook-triggers.md`
- `.claude/rules/29-local-first-debugging.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/39-debug-before-redesign.md`
- `apps/www/src/content/docs/docs/guides/webhook-triggers.md`
