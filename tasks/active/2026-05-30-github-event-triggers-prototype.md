# GitHub Event Triggers Prototype (Staging-Only)

## Problem Statement

SAM currently only supports cron-based triggers. Users need the ability to create triggers that respond to GitHub events (issue comments, labels, pushes, PRs) with cheap deterministic filters that prevent unnecessary session creation.

This is a **staging-only prototype** — it must NOT be merged to main or shipped to production. It proves the end-to-end architecture for GitHub event triggers with at least one high-value recipe (issue_comment command mode or issues.labeled).

## Research Findings

### Existing Architecture
- `triggers` table has `source_type` column supporting 'cron', 'webhook', 'github'
- `trigger_executions` table tracks every trigger firing attempt
- `submitTriggeredTask()` bridges from trigger execution to TaskRunner pipeline
- `renderTemplate()` provides Mustache-style template interpolation
- `verifyWebhookSignature()` already validates GitHub webhook HMAC signatures
- The webhook endpoint at `POST /api/github/webhook` handles installation and repository events
- Valibot schema already accepts `sourceType: 'github'` but CRUD rejects it with "Only cron sourceType is supported"

### Key Design Decisions
- Add `github_trigger_configs` table for source-specific config (event type, filters)
- Add `github_webhook_deliveries` table for delivery dedup and audit
- Keep filter engine as pure functions for easy testing
- Extend existing webhook handler after signature verification
- Use `X-GitHub-Delivery` header for dedup, `X-GitHub-Event` for routing
- Feature-flag behind `GITHUB_TRIGGERS_ENABLED` env var

### Files to Modify
- `packages/shared/src/types/trigger.ts` — Add GitHub trigger types
- `apps/api/src/db/schema.ts` — Add new tables
- `apps/api/src/db/migrations/0057_github_trigger_configs.sql` — D1 migration
- `apps/api/src/schemas/triggers.ts` — Extend Valibot schemas
- `apps/api/src/routes/triggers/crud.ts` — Allow GitHub source type
- `apps/api/src/routes/github.ts` — Route webhook events to trigger matching
- `apps/api/src/services/github-trigger-filter.ts` — NEW: Pure filter engine
- `apps/api/src/services/github-trigger-handler.ts` — NEW: Webhook → trigger matching
- `apps/web/src/components/triggers/TriggerForm.tsx` — GitHub trigger UI
- Tests for filter engine and webhook routing

## Implementation Checklist

### Phase 1: Shared Types & DB Schema
- [ ] Add GitHub trigger config types to `packages/shared/src/types/trigger.ts`
- [ ] Add GitHub template context types
- [ ] Create D1 migration `0057_github_trigger_configs.sql`
- [ ] Add Drizzle schema for `github_trigger_configs` and `github_webhook_deliveries`
- [ ] Build shared package

### Phase 2: Filter Engine (Pure Functions)
- [ ] Create `apps/api/src/services/github-trigger-filter.ts`
- [ ] Implement event type + action matching
- [ ] Implement label filter matching
- [ ] Implement actor/bot ignore filter
- [ ] Implement comment command prefix matching
- [ ] Implement title/body contains filter
- [ ] Write comprehensive unit tests for the filter engine

### Phase 3: Webhook Handler & Trigger Matching
- [ ] Create `apps/api/src/services/github-trigger-handler.ts`
- [ ] Implement delivery dedup using `X-GitHub-Delivery`
- [ ] Implement trigger lookup: find active GitHub triggers for the project linked to the webhook's installation
- [ ] Implement filter evaluation against matched triggers
- [ ] Bridge matching triggers to `submitTriggeredTask()` with GitHub context
- [ ] Build GitHub template context from webhook payload
- [ ] Extend webhook endpoint in `github.ts` to route events after signature verification
- [ ] Gate behind `GITHUB_TRIGGERS_ENABLED` env var

### Phase 4: API Routes & Validation
- [ ] Extend `CreateTriggerSchema` and `UpdateTriggerSchema` with GitHub fields
- [ ] Remove "Only cron sourceType is supported" gate in CRUD
- [ ] Add GitHub-specific validation in create/update routes
- [ ] Add test/dry-run support for GitHub triggers

### Phase 5: UI (TriggerForm Extension)
- [ ] Add source type selector (cron vs github) to TriggerForm
- [ ] Show/hide cron vs github config fields based on selection
- [ ] Add GitHub event type dropdown
- [ ] Add filter configuration fields (labels, actor ignore, command prefix)
- [ ] Add GitHub template variables to the variable reference
- [ ] Update prompt template preview for GitHub triggers

### Phase 6: Tests
- [ ] Filter engine unit tests (labels, actions, commands, actor ignores, draft state)
- [ ] Webhook handler integration tests (delivery dedup, trigger matching, non-matching events)
- [ ] API route tests (create/update/list GitHub triggers)

## Acceptance Criteria
- [ ] At least one GitHub recipe works end-to-end (issue_comment command or issues.labeled)
- [ ] Existing cron triggers remain working
- [ ] Existing GitHub installation/repository webhook behavior remains working
- [ ] API rejects invalid signatures and dedupes delivery IDs
- [ ] Unit tests prove non-matching events do not start tasks
- [ ] Unit tests prove matching events reach trigger execution/submission boundary
- [ ] Feature is gated behind `GITHUB_TRIGGERS_ENABLED` env var
- [ ] Draft PR opened — NOT merged

## References
- SAM idea 01KSXH9D3RZ00XY8DAHG0Y5V6W
- `apps/api/src/routes/github.ts` — existing webhook handler
- `apps/api/src/routes/triggers/crud.ts` — existing trigger CRUD
- `apps/api/src/services/trigger-submit.ts` — task submission bridge
- `apps/api/src/services/trigger-template.ts` — template rendering
- `packages/shared/src/types/trigger.ts` — trigger types
