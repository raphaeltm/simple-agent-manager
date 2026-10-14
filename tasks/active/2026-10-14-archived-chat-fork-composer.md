# Archived chat Fork composer

## Scope and constraints
Implement on assigned SAM branch. Draft PR only; do not merge or deploy. Archived source history/status/runtime remain unchanged. No same-chat lifecycle recovery or workspace restoration.

## Research
Existing Fork only fills IDs in new-chat screen. SessionFooter hides archived input. submitTask contextSummary is chat-only and VM runner receives clean message, so context must reach actual VM/Instant prompt. Existing cli_operation_receipts provide keyed replay; pending uncertain outcomes must never create duplicates. Archive may remove recovery artifacts: prior commit is evidence, never proof of restored files.

## Checklist / acceptance
- [x] Archived owner composer retains input and Fork submit, loading/error/retry and fresh-chat navigation.
- [x] Owned archived source required; other owners/project rejected before transcript access.
- [x] Fresh linked chat gets retained redacted bounded user/assistant context plus new prompt exactly once in actual runner prompt and display.
- [x] Source history/status/runtime unchanged; unavailable workspace/branch/SHA disclosed honestly.
- [x] Duplicate/concurrent and lost-response/reload retries retain keyed intent and do not spawn duplicates.
- [x] Transcript/tool/approval replay prohibited; metadata and text redacted before truncation with explicit disclosure.
- [ ] Tests, desktop/mobile visual review, local quality checks, independent reviews and terminal aggregate CI results recorded.

## UI choice
Considered inline composer, modal, separate new-chat screen. Inline selected because it matches the requested archived input and minimizes navigation/context loss. Shared ProjectChatComposer retains styling/accessibility.

## Validation / reviews
Independent Sol security/Cloudflare/constitution review PASS; UI review PASS with screenshot rubric 4/4/4/4/5; completion A-F PASS for implementation/docs. Focused API/receipt/CORS: 86 passed, 1 existing skip. Full Fork/Retry Playwright: 20 passed mobile/desktop. Navigation/resume regression: 29 passed after disabling archived autofocus and changing expected archive behavior. Initial aggregate tests caught these issues. Final focused frontend coverage: 37 passed; archived browser rerun: 8 passed; crowded-history mobile/desktop case: 2 passed with 32 chats/messages, screenshots inspected. Aggregate lint13/13 and typecheck19/19 passed at a072554327a8dde61c2fbf875edaf5095feba629; final aggregate test/build and GitHub CI pending. Independent recovered Sol final review PASS for canonical retry serialization, navigation/logout guards and 56px CTA. Instruction-context budget and targeted browser ESLint passed. No deploy, per explicit user constraint.

Known limitations: pattern-based redaction; newest bounded history (including omission of an incomplete oldest assistant token group); no prior file restoration; uncertain pending receipts require reconciliation rather than risky resubmission.

Final CI browser finding: preserved the existing saved-workspace-expired notice inside the archived composer. Updated the expiry browser case to verify composer/empty-submit protection and retained toolbar Fork. Mobile/desktop expiry browser2passed35.4s; targeted ESLint and independent adjacent reviewPASS. CodeRabbit approved de1ad3487; cosmetic safe-boundary nit resolved with independent reasoned review (redaction before slice, JSON escaping, disclosed truncation). PR2337 remains draft/no deploy. Final CI rerun will cover this adjacent fix.
