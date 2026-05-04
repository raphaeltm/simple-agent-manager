# Hide ACP Config Option Updates From Chat

## Problem

Recent ACP agents send `session/update` notifications with `sessionUpdate: "config_option_update"` and a complete `configOptions` array for session selectors like mode and model. SAM's ACP client does not recognize that update type, so it falls through to the generic raw fallback renderer and displays an orange `Rich rendering unavailable` block at the top of chats.

This is session metadata, not transcript content. Until SAM has a first-class UI for ACP config options, the client should acknowledge the update without adding a visible chat item.

## Research Findings

- `packages/acp-client/src/hooks/useAcpMessages.ts` handles ACP `session/update` notifications and currently renders unknown update types as `raw_fallback`.
- `packages/acp-client/src/components/RawFallbackView.tsx` is the component producing the visible `Rich rendering unavailable` text.
- `packages/acp-client/tests/unit/hooks/useAcpMessages.test.ts` already has focused coverage for recognized and unknown ACP update behavior.
- ACP session config options documentation describes `config_option_update` as a valid agent-originated notification containing complete configuration state for selectors such as mode/model.
- `docs/notes/2026-05-02-persisted-tool-call-title-loss-postmortem.md` is relevant because it covers regressions in live ACP rendering behavior and emphasizes focused regression tests for streamed UI data.

## Implementation Checklist

- [x] Add explicit handling for `config_option_update` in `useAcpMessages()`.
- [x] Keep the update out of `items` so it does not render in chat.
- [x] Add a regression test proving `config_option_update` does not create a `raw_fallback` item.
- [x] Run focused ACP client tests.
- [x] Run applicable type/lint checks for the touched package.

## Acceptance Criteria

- `config_option_update` session notifications no longer produce `Rich rendering unavailable` in chat.
- Unknown session updates still render as `raw_fallback` for debuggability.
- Regression coverage proves the behavior.
