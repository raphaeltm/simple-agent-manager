# Agent linked context

## Problem

Agents reading ideas or chats do not receive related work in one bounded, data-framed response.

## Research

`getIdea` in idea-core serves both MCP adapters. `getIdeaContext` and `getSessionContext` in link-core enforce strong-link inheritance and return ranked capped lists. Idea updates live in ProjectData. T7 provides the shared untrusted-text envelope.

## Checklist

- [x] Add bounded agent context projection with typed settings and untrusted envelopes.
- [x] Include related context and latest updates in get_idea.
- [x] Add get_linked_context for idea, session or file, defaulting to current chat.
- [x] Register workspace and connector adapters and tool guidance.
- [x] Remove the unused legacy session–idea methods after the link store became the only live reader and writer; retain the table and migration.
- [x] Test real handlers, connector parity, scoping, output bound and prompt injection framing.
- [ ] Run validation, specialist reviews, staging and PR gates.

## Acceptance

One call returns linked work, ranked/capped with disclosed totals, with project isolation and data framing for every agent audience.
