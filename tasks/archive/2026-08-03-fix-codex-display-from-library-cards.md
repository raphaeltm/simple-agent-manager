# Fix Codex display_from_library rich cards

## Problem

Library/document preview cards from the SAM MCP `display_from_library` tool should render the same rich `DocumentCard` UI across agent adapters. Claude-originated rows use the `mcp__<server>__<tool>` naming convention, while Codex-originated rows can expose the visible tool name as `<server>/<tool>`, for example `sam-mcp/display_from_library`.

The user-visible regression is that a Codex session calling `display_from_library` for `/architecture/sam-feedback-loop-map.html` only showed generic tool output text instead of the rich document preview card.

## Research findings

- Web typed-card registry lives in `apps/web/src/components/project-message-view/tool-cards/registry.ts`.
- Tool normalization lives in `apps/web/src/components/project-message-view/tool-cards/document-card-data.ts`.
- Persisted chat rows are converted in `apps/web/src/components/project-message-view/types.ts`.
- Existing code already uses delimiter-agnostic matching for:
  - `display_from_library`
  - `sam-mcp/display_from_library`
  - `mcp__sam-mcp__display_from_library`
  - dotted/colon equivalents
- Existing tests cover normalization, generic fallback, Codex slash-title persisted rows, and HTML documents on the icon/interactive preview tier.
- The concrete reported HTML fixture should be covered at component/render level so future regressions are obvious.

## Checklist

- [x] Add/confirm focused normalization coverage for Claude and Codex tool-name forms.
- [x] Add component/rendering coverage proving a Codex `sam-mcp/display_from_library` HTML document row renders the rich document card.
- [x] Verify generic/unknown tool calls still fall back to generic rendering.
- [x] Run relevant web unit tests.
- [x] Run relevant typecheck/lint/build checks or document any blocker.
- [x] Run required specialist reviews.

## Acceptance criteria

- Codex-originated `display_from_library` tool calls render the same rich library/document card as Claude-originated calls.
- Matching remains simple and scoped to current visible tool-name forms.
- HTML library documents such as `/architecture/sam-feedback-loop-map.html` surface as preview cards.
- Generic/unknown tool calls are unchanged.
- Changes are covered by focused tests and shipped in one PR.

## Validation evidence

- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/document-card-data.test.ts tests/unit/components/DocumentCard.test.tsx tests/unit/components/chatMessagesToConversationItems.test.ts` — 98 tests passed.
- `pnpm --filter @simple-agent-manager/web lint && pnpm --filter @simple-agent-manager/web typecheck` — passed; lint emitted existing warnings but no errors.
- `pnpm --filter @simple-agent-manager/web build` — passed.

## Specialist review evidence

- task-completion-validator: PASS — checklist, acceptance criteria, and regression tests align with the diff. No UI/backend propagation or multi-resource selection changes.
- ui-ux-specialist: PASS/N/A — no product UI code changed; existing DocumentCard behavior validated through component tests. Screenshot audit not applicable to a test-only change.
- constitution-validator: PASS — no production hardcoded configuration, URL, timeout, limit, or identifier introduced; fixture IDs and metadata are test data.
- test-engineer: PASS — focused jsdom component regression covers the exact Codex slash visible tool name plus HTML document case; existing tests continue to cover normalization, persisted-row conversion, and generic fallback.
