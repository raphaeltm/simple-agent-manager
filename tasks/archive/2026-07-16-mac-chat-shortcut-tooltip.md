# Mac-aware chat send shortcut tooltip

## Problem

The project chat composer currently shows `Press Ctrl+Enter to send, Enter for new line` below the input. On macOS this should say `Cmd+Enter`, while other platforms should keep `Ctrl+Enter`.

The Send button also needs a hover tooltip showing the same keystroke, automatically matching Mac vs non-Mac platforms.

## Research Findings

- `apps/web/src/components/project-chat/ProjectChatComposer.tsx` owns the shared project chat composer UI, including the current shortcut hint and Send button.
- The component already sends on either `event.ctrlKey` or `event.metaKey`, so the behavioral shortcut works cross-platform; this task is about platform-aware copy and tooltip affordance.
- `apps/web/tests/unit/components/project-chat-composer.test.tsx` already covers the composer and can be extended for platform-specific UI copy.
- Existing Playwright project chat audit helpers live under `apps/web/tests/playwright/audit-helpers.ts`, and UI changes require local screenshot-backed validation.

## Implementation Checklist

- [x] Add a small, testable platform helper for choosing `Cmd+Enter` on Mac-like platforms and `Ctrl+Enter` elsewhere.
- [x] Update `ProjectChatComposer` to use the helper for the visible shortcut hint.
- [x] Add a Send button hover tooltip using the same platform-specific shortcut.
- [x] Add accessibility metadata for the keyboard shortcut where appropriate.
- [x] Extend unit tests to cover Mac and non-Mac shortcut hint/tooltip copy.
- [x] Run local validation and Playwright visual audit without staging.

## Acceptance Criteria

- On Mac-like platforms, the composer hint says `Press Cmd+Enter to send, Enter for new line`.
- On non-Mac platforms, the composer hint says `Press Ctrl+Enter to send, Enter for new line`.
- Hovering the Send button exposes a tooltip/title with the platform-specific send shortcut.
- The existing Ctrl/Cmd+Enter send behavior still works.
- Local tests and checks pass.
- Staging deployment is skipped per explicit user instruction.
