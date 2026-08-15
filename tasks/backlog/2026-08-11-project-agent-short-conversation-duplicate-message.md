# ProjectAgent loadHistory duplicates the user message in short conversations

## Problem

`apps/api/src/durable-objects/project-agent/index.ts` `loadHistory()` strips the just-persisted user message from history only when the raw fetch exceeded `contextWindow` (`rawRows.length > contextWindow`). For a short conversation (total messages ≤ contextWindow), the just-persisted user message stays in the returned history, and `runAgentLoop` (`sam-session/agent-loop.ts`) separately appends `{ role: 'user', content: userMessage }` — so the model receives the same user message twice on every ProjectAgent chat turn until the conversation outgrows the context window.

## Context

Pre-existing behavior, discovered 2026-08-11 while fixing the related post-validation count regression during the AI-slop debt burn-down (see `tasks/archive/2026-08-10-ai-slop-debt-burndown.md`). The sibling `sam-session/index.ts` `loadHistory` (~line 630) does not have this bug: it unconditionally strips the newest row (`rows.length > 0 ? rows.slice(1) : []`). The burn-down PR deliberately preserved ProjectAgent's threshold semantics to avoid an out-of-scope behavior change; only the malformed-row count regression was fixed there.

Impact: wasted tokens and mildly skewed context on ProjectAgent short conversations; no data loss.

## Acceptance criteria

- [ ] ProjectAgent `loadHistory` never returns the just-persisted user message for the current turn (adopt the sam-session unconditional-strip pattern or equivalent), for both short and long conversations
- [ ] Discriminating regression test: short conversation (< contextWindow messages) chat turn produces exactly one user-message instance in the messages array handed to the agent loop
- [ ] Existing long-conversation and malformed-row tests still pass
