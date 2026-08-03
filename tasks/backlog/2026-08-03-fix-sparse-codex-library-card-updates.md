# Fix sparse Codex library-card result updates

## Problem

Codex-originated `display_from_library` calls can still render as generic tool output instead of the rich `DocumentCard`. The concrete production repro used `sam-feedback-loop-map.html` (`01KYVMVKXAV7217F48HMK43MRX`, `text/html; charset=utf-8`), and the card remained absent after full-page refresh.

PR #1721 only added a component fixture that placed `sam-mcp/display_from_library` and a complete result payload on one synthetic item. It did not exercise a real Codex session or the persisted initial-call/result-update pair.

## Research findings

- PR #1520 made tool-name normalization delimiter-agnostic in the VM agent and web, but its real staging Codex call was explicitly waived because the staging OAuth credential was expired.
- PR #1524 preserved bounded card output in compact history only when the individual result row already identifies a document-card tool; its staging run was explicitly skipped.
- The maintained Codex ACP wrapper emits sparse result updates: the initial row can carry the visible slash-form title, while the completed update can carry the JSON result without repeating `title` or `toolName`.
- `apps/web/src/components/project-message-view/types.ts:chatMessagesToConversationItems` correctly merges sparse rows by `toolCallId` and preserves the initial `toolName`, but it tries `legacyDocumentRawOutput()` before that merge using only the current row's `toolName`. A sparse result row therefore cannot recover its JSON using the already-known tool name from the initial row.
- The prior production session's persisted searchable tool output contains the complete HTML document payload, so the result data was stored; typed-card reconstruction is the remaining gap.
- An independent Staging Validator task (`01KZ41AFVYDEPMKFF5GYK6F0S2`) is reproducing the exact flow and will return compact/non-compact message metadata before the implementation is finalized.

## Implementation checklist

- [ ] Capture the exact live Codex staging call/update metadata and retain it as the regression fixture shape.
- [ ] Add a failing persisted-message conversion test where the initial slash-title row identifies `display_from_library` and a later same-`toolCallId` update contains the document JSON without repeating title/tool name.
- [ ] Recover bounded legacy document output during call/update merge using the existing item's preserved tool identity.
- [ ] Prove the merged item selects `DocumentCard` for the reported HTML document and still falls back generically for malformed/unknown sparse updates.
- [ ] Verify Claude-style complete metadata and unrelated generic tools are unchanged.
- [ ] Run focused web tests, lint, typecheck, build, and the mandatory local mobile/desktop Playwright visual audit.
- [ ] Complete task, UI/UX, constitution, and test specialist reviews; address all blocking findings.
- [ ] Deploy the new branch to staging and independently validate a new secondary-user Codex session live and after reload.
- [ ] Open a new PR, make all CI/Sonar checks green, merge, and monitor the matching production deployment to success.

## Acceptance criteria

- A real Codex `display_from_library` call on staging renders a rich HTML `DocumentCard` once its sparse result update arrives.
- The card remains present after a full reload through compact history.
- The persisted sparse update is correlated by `toolCallId`; it does not need to repeat agent-specific title/name metadata.
- Malformed document output and unrelated tools retain the generic card fallback.
- A new PR contains runtime code, discriminating regression coverage based on the live staging shape, complete staging evidence, green CI, and specialist review evidence.

## References

- Parent session `48918966-40d0-41a9-9277-f858734a965f`
- Parent task `01KZ36H3AK5PPZDS47G8YZ445T`
- PRs #1488, #1517, #1520, #1524, #1721
- `apps/web/src/components/project-message-view/types.ts`
- `apps/web/src/components/project-message-view/tool-cards/document-card-data.ts`
- `apps/api/src/durable-objects/project-data/row-schemas/messages.ts`
- `packages/vm-agent/internal/acp/message_extract.go`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/33-staging-feature-validation.md`
