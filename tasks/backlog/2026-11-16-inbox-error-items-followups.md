# Inbox error items: follow-ups from slice E

Found while building inbox slice E (PR #2781, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9).

## Problem

Slice E files `error` inbox items for failed starts, crashes, failed wakes, lossy sleeps, failing
automations and undelivered answers. Three related gaps were left out of its scope:

1. A person's chat message delivered through the durable prompt outbox to an awake chat that ends
   `failed` (`max_attempts_exceeded`, `dead_target`) raises nothing visible. Only TTL expiry to a
   sleeping chat (now a wake-failure item) and InteractionStore / inbox-ask notice give-ups file
   items (`packages/project-data/src/do/prompt-delivery.ts:expireDuePromptDeliveries`,
   `applyPromptDeliveryResult`).
2. Read regressions of moving the wake failure into `asks` (same as questions in slice G): the
   account map (`apps/api/src/routes/account-map.ts`) reads only `session_summaries.attention_json`,
   and the agent-facing `pendingAttention` (`packages/operations/src/attention-core.ts`) lists
   only markers and question asks.
3. A provider-limit block resolves the old `wake_failed` marker by kind
   (`provider-limit-attention.ts`) but leaves a wake-failure ask open until the chat wakes or the
   person writes in it.

## Acceptance Criteria

- [ ] Human prompt deliveries that fail terminally on an awake chat file one `delivery` error item
- [ ] Account map and `pendingAttention` read open wake-failure (and question) asks
- [ ] A provider-limit block supersedes an open wake-failure ask, with a test
