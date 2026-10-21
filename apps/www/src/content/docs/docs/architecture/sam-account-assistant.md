---
title: SAM Account Assistant Decision
description: Private account ownership, canonical history, bounded model context, and project execution boundaries.
---

**Decision date:** 2026-10-20. **Status:** Implemented in the launch change; deployment validation is tracked separately.

## Context

An account assistant needs private conversation history across projects while project work must remain visible and attributable to the project where it runs. Reusing a synthetic project for private account memory would mix ownership boundaries. A second framework-owned conversation store would also create competing histories and complicate recovery.

## Decision

The existing `SamSession` Durable Object is addressed by the authenticated user ID. Its SQLite `conversations` and `messages` tables remain the canonical transcript. Initialization reuses the latest human conversation when available, preserving earlier messages. New durable turns append stable `operator:` user/assistant message IDs to that same transcript.

An account-local `operator_conversation_tasks` row supplies the conversation's backing-task identity. This record belongs to the private user Durable Object; it is not a D1 project task and is not a globally privileged project token. The row supplies identity and parent lineage; it does not implement the ordinary project-task lifecycle. The private fork API creates a new row linked to its parent, copies a bounded recent window of canonical user/assistant history and selects the new conversation. It does not clone project execution receipts or grant access. The launch UI has no fork control.

`operator_turns` and `operator_actions` retain admission keys, state, exact action inputs, dispatch reservations and outcomes. They are execution receipts alongside the canonical transcript, not a replacement transcript. Read-only earlier history remains available through the existing conversation/message API.

Mastra receives a bounded, turn-aware projection of canonical user/assistant messages, plus bounded unresolved-action references and tool evidence. Server-generated message identities link historical turns to their recorded state and action references, including copied private-fork history. Historical assistant claims that fail grounding against their own receipts are excluded from model input; the canonical transcript, UI history and search index remain unchanged. Retained historical assistant prose is escaped data inside a server-generated status record, so it cannot impersonate a separate status record. Historical user constraints are retained within the selected window, and status records identify earlier requests as historical evidence rather than current authorization. No raw action inputs or results are added by these status records.

Each status record carries `recordedAt`, the stored time of the group's first message, and each turn's instructions end with the current UTC time (`currentTimeInstruction` in `operator/agent.ts`). The instructions require operations called in the current turn for current-status questions and treat historical records as past context. On 2026-10-21 an undated, months-old summary in legacy history was answered back as "recent" with no tool call; dated records and a clock let the model see that history is old. The time is constant within a turn and placed last, so the static prefix stays cacheable across the turn's steps.

Old projected turn groups are dropped together according to context/request limits, including their status metadata. The exact current request is always last and is never partially truncated. Retained history can still be searched privately. Mastra does not maintain a second persistent memory database. Tool results and event records are evidence, not human authorization. This projection improves provenance; it does not guarantee a model will select a tool or complete the requested workflow.

## Execution and authorization

Repository inspection, search and changes run through shared platform operations in a visible project task/session. Each operation uses the current user actor and normal project access checks. The account assistant has an explicit operation allowlist; adding a registry operation does not silently expand its authority. Project briefs must carry the requested work and constraints without exporting unrelated private history.

A stable browser request key identifies turn admission. Durable action identities and reserved task/session IDs preserve uncertain outcomes across interruptions. An uncertain effect is not automatically replayed; dispatch reconciliation looks up its existing reservation. Confirmation applies to one recorded action. Generation checks, account status and current project authorization fence subsequent effects after disable or access changes.

Before publishing a model answer, SAM checks platform resource references against typed metadata from completed operations in the current turn. A canonical chat, task or idea link also establishes its exact parent project link, without granting sibling links or added query/fragment data. User-supplied identifiers, previous assistant prose and project-report text do not establish those references. A conservative outcome-claim check also rejects recognized success statements without a matching completed write receipt. A rejected unpublished draft may receive one correction within the same running invocation, only if no tool execution was attempted, no model tool call was observed, and no action receipt exists. The correction uses a fixed instruction, preserves the original request and canonical history, and requires a tool on its first step. Both attempts share the existing step, deadline and usage bounds and fresh authorization checks. Provider errors, blank answers and exhausted budgets do not qualify. A second rejection interrupts without publishing unsupported prose. Usage and operation receipts remain recorded; an interrupted request is never automatically replayed. These checks do not establish universal semantic correctness of arbitrary model prose.

## Live answers

The agent runs Mastra `stream()` and resolves the final output with `getFullOutput()`, keeping the error semantics of `generate()`. Each stream chunk and step boundary feeds `OperatorLive` (`operator/live.ts`), an in-memory view of the one running turn: phase, published answer text, a one-line reasoning preview and tool steps (descriptive inputs and result counts only, never briefs). `GET /api/sam/turns/:id/stream` serves it as server-sent events with a snapshot on connect, throttled updates and heartbeats; the polled history carries the same snapshot on the running turn. Nothing in the live view is persisted, and a reconnect after an object restart receives no live state while the turn's recovery runs as before.

Live text uses the publication guard. Answer and reasoning text is released only in whitespace-bounded prefixes that pass `isGroundedText` against the receipt index (`buildGroundingIndex`), which is rebuilt when a tool result arrives. Every guard check is anchored at an identifier, URL or claim that contains no whitespace and reads the text before it or whole words after it, so a whitespace-bounded prefix of a passing answer also passes. Once a prefix fails, the step publishes nothing more. Pre-tool narration is dropped at the step boundary because the stored answer is the final step's text. After the final guard passes, the live view is set to exactly the stored answer before `done`.

A streamed step without a usage chunk is still charged: missing token counts are estimated from the step's request and output, and the gap is logged as `sam.operator.usage_estimated`. Workers AI requests carry `x-session-affinity` per conversation to raise prefix-cache hits, and cached input tokens are charged at the model's cached-input price when the catalog lists one. Stream flush, heartbeat and reader-cap values are typed admin settings.

## Background work

Dispatches create bounded own-work watches against the canonical project event subscription system. `operator_inbox` records event identity independently of transport acknowledgements, while communicated state is separate. The UI receives fresh authorized work projections and coalesced unread counts. Alarm scans use a persisted round-robin cursor, with at most the configured event page size of active watches per invocation (25 by default) and at most that many events per watch. Each watch needs fresh account/kill-switch checks, project membership, an owned-task lookup, and one event pull; initial subscription creation adds one RPC. Terminal or expired watches stop being polled. Events do not trigger an LLM call or inject a new conversation topic. Marking updates seen records communication only, not an answer to an agent request.

## Consequences and limits

The private assistant can coordinate across authorized projects without inventing a global project or exposing private conversation context to project members. Disabling it preserves transcript and project work while fencing new assistant effects. Project task completion remains separate from assistant turn completion.

The initial interface has one active account conversation, bounded recent history with older-page loading, and a retained earlier-history disclosure. A UI for private forks, broader standing autonomy, and full coverage of settings/compute/deployment operations are outside this launch. Local tests and mocked browser audits demonstrate behavior within their test boundaries; they are not production execution evidence.

Implementation: `apps/api/src/durable-objects/sam-session/operator/{store,controller,agent,model,live,grounding,operations,work}.ts`, `apps/api/src/routes/sam.ts`, `apps/web/src/pages/Sam.tsx`, `apps/web/src/components/sam/useSamLiveTurn.ts` and `LiveProgress.tsx`. See the [user guide](/docs/guides/sam-assistant/) and [API contract](/docs/reference/api/#private-sam-account-assistant).
