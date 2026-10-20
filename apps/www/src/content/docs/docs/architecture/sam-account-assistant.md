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

Mastra receives a bounded projection of canonical user/assistant messages, plus bounded unresolved-action references and tool evidence. Old projected messages are dropped according to context/request limits; retained history can be searched privately. Mastra does not maintain a second persistent memory database. Tool results and event records are evidence, not human authorization.

## Execution and authorization

Repository inspection, search and changes run through shared platform operations in a visible project task/session. Each operation uses the current user actor and normal project access checks. The account assistant has an explicit operation allowlist; adding a registry operation does not silently expand its authority. Project briefs must carry the requested work and constraints without exporting unrelated private history.

A stable browser request key identifies turn admission. Durable action identities and reserved task/session IDs preserve uncertain outcomes across interruptions. An uncertain effect is not automatically replayed; dispatch reconciliation looks up its existing reservation. Confirmation applies to one recorded action. Generation checks, account status and current project authorization fence subsequent effects after disable or access changes.

Before publishing a model answer, SAM checks platform resource references against typed metadata from completed operations in the current turn. A canonical chat, task or idea link also establishes its exact parent project link, without granting sibling links or added query/fragment data. User-supplied identifiers, previous assistant prose and project-report text do not establish those references. A conservative outcome-claim check also rejects recognized success statements without a matching completed write receipt. A rejected unpublished draft may receive one correction within the same running invocation, only if no tool execution was attempted, no model tool call was observed, and no action receipt exists. The correction uses a fixed instruction, preserves the original request and canonical history, and requires a tool on its first step. Both attempts share the existing step, deadline and usage bounds and fresh authorization checks. Provider errors, blank answers and exhausted budgets do not qualify. A second rejection interrupts without publishing unsupported prose. Usage and operation receipts remain recorded; an interrupted request is never automatically replayed. These checks do not establish universal semantic correctness of arbitrary model prose.

## Background work

Dispatches create bounded own-work watches against the canonical project event subscription system. `operator_inbox` records event identity independently of transport acknowledgements, while communicated state is separate. The UI receives fresh authorized work projections and coalesced unread counts. Alarm scans use a persisted round-robin cursor, with at most the configured event page size of active watches per invocation (25 by default) and at most that many events per watch. Each watch needs fresh account/kill-switch checks, project membership, an owned-task lookup, and one event pull; initial subscription creation adds one RPC. Terminal or expired watches stop being polled. Events do not trigger an LLM call or inject a new conversation topic. Marking updates seen records communication only, not an answer to an agent request.

## Consequences and limits

The private assistant can coordinate across authorized projects without inventing a global project or exposing private conversation context to project members. Disabling it preserves transcript and project work while fencing new assistant effects. Project task completion remains separate from assistant turn completion.

The initial interface has one active account conversation, bounded recent history with older-page loading, and a retained earlier-history disclosure. A UI for private forks, broader standing autonomy, and full coverage of settings/compute/deployment operations are outside this launch. Local tests and mocked browser audits demonstrate behavior within their test boundaries; they are not production execution evidence.

Implementation: `apps/api/src/durable-objects/sam-session/operator/{store,controller,agent,operations,work}.ts`, `apps/api/src/routes/sam.ts`, and `apps/web/src/pages/Sam.tsx`. See the [user guide](/docs/guides/sam-assistant/) and [API contract](/docs/reference/api/#private-sam-account-assistant).
