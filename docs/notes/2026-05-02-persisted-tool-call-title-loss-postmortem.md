# Persisted Tool Call Title Loss Postmortem

## What Broke

Tool calls displayed useful command details while the project chat was connected to the live ACP WebSocket stream, but the same conversation could collapse to a generic "Tool Call" label after the UI switched to ProjectData Durable Object history.

The visible failure happened during persisted message reconstruction in `apps/web/src/components/project-message-view/types.ts:chatMessagesToConversationItems()`. Live ACP items were not affected because the live view used already-materialized conversation items before the persisted DO handoff in `apps/web/src/components/project-message-view/index.tsx`.

## Root Cause

Commit `512510d87` added the persisted tool-call deduplication path in `apps/web/src/components/project-message-view/types.ts:chatMessagesToConversationItems()`. When a later status-only update row shared the same `toolCallId`, the merge path recomputed a fallback title from missing metadata and overwrote the richer title from the initial tool-call row.

The broken invariant was: a status update may update status, but it must not erase previously persisted display metadata unless it carries an explicit replacement value.

## Timeline

- 2026-04-01: `512510d87` introduced persisted tool-call deduplication by `toolCallId`.
- 2026-05-02: The issue was reported while comparing live ACP WebSocket rendering with Durable Object backed history rendering.
- 2026-05-02: The merge logic was changed so only explicit `toolMetadata.title` values replace an existing tool-call title.

## Why It Wasn't Caught

Existing unit coverage checked that explicit title updates replace old titles, but it did not cover status-only update rows that omit `title` and `kind`.

There was also no screenshot-backed persisted-history audit that mocked the exact DO shape users see after the WebSocket handoff.

## Class Of Bug

Partial-update metadata erasure across a materialization boundary. A later, narrower event was treated as a full replacement, so default/fallback values overwrote richer state from an earlier event.

## Process Fix

`.claude/rules/02-quality-gates.md` now requires regression tests for live-to-persisted display parity when a bug involves streamed UI data later reconstructed from durable storage. The test must include partial/status-only update events and assert that omitted fields do not clear previously visible metadata.

This PR includes:

- A unit regression test in `apps/web/tests/unit/components/chatMessagesToConversationItems.test.ts`.
- A Playwright persisted-chat visual audit in `apps/web/tests/playwright/project-chat-tool-call-audit.spec.ts`.
