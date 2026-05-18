# Share Project Chat Composer

## Problem

The project chat has two prompt surfaces that should feel and behave like the same composer: the new-chat initial task prompt and the active-session follow-up prompt. Today only the initial prompt has the richer behavior: auto-growing textarea, slash-command autocomplete, agent-profile `@mention` autocomplete, voice transcription append, and new-task attachments. Active-session follow-ups use a separate `FollowUpInput` with upload and voice support but no auto-grow parity or autocomplete.

Backend mention enrichment already applies to both paths, so this task is frontend composition/refactor work. The goal is to extract shared composer behavior while keeping new-task-only controls out of follow-ups.

## Research Findings

- `apps/web/src/pages/project-chat/ChatInput.tsx` contains both shared composer behavior and new-task-only controls. Shared behavior includes `SlashCommandPalette`, `MentionPalette`, Ctrl/Cmd+Enter send, textarea auto-grow capped at 120px, `VoiceButton` transcription append, optional attachment button/chips, and send-button styling.
- `apps/web/src/components/project-message-view/FollowUpInput.tsx` duplicates a simpler textarea/voice/send/upload composer. It lacks textarea auto-grow, slash-command autocomplete, and `@profile` autocomplete.
- `apps/web/src/components/project-message-view/index.tsx` renders `FollowUpInput` for active and idle sessions and passes follow-up state from `useSessionLifecycle`.
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` owns follow-up value, send, upload, idle resume, optimistic user messages, and file upload behavior. These data-flow semantics should remain unchanged.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` already loads `agentProfiles` and `slashCommands` for the project chat page. `slashCommands` comes from `useAvailableCommands(projectId, undefined, sessionId)`, which merges client, static, cached, and live commands with cached refresh on session switch.
- `packages/acp-client/src/components/MentionPalette.tsx` and `SlashCommandPalette.tsx` expose ref-based keyboard handlers and ARIA active descendant IDs suitable for a shared textarea wrapper.
- `apps/web/src/pages/project-chat/index.tsx` owns the boundary between the new-chat input and active `ProjectMessageView`, so it is the clean place to pass already-loaded `agentProfiles` and `slashCommands` into follow-up composition and avoid duplicate fetches.
- Relevant postmortems:
  - `docs/notes/2026-03-01-new-chat-button-postmortem.md`: interactive changes must trace handler/effect interactions; source-contract tests are insufficient.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: preserve chat/session identity boundaries and avoid broad workspace-scoped heuristics.
  - `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`: trace complete user input paths rather than assuming documentation means behavior exists.

## Implementation Checklist

- [x] Create a reusable project chat composer component for shared textarea, send, voice, slash-command, mention, auto-grow, ARIA, attachment button/chip rendering, and Ctrl/Cmd+Enter behavior.
- [x] Refactor `ChatInput` so it keeps new-task controls, profile edit dialog, submit error display, and task attachment data while delegating shared composer behavior.
- [x] Thin `FollowUpInput` so active-session follow-ups use the shared composer while preserving upload and idle/resume send behavior.
- [x] Pass `agentProfiles` and `slashCommands` from the project chat state into `ProjectMessageView` and then follow-up input without introducing duplicate fetches.
- [x] Add or update unit tests proving the shared composer exposes slash-command and `@mention` autocomplete, auto-grows, sends with Ctrl/Cmd+Enter, and preserves new-chat controls.
- [x] Add or update tests proving active follow-up inputs expose slash-command and `@mention` autocomplete when profiles/commands are available.
- [x] Add or run Playwright visual audit coverage for new-chat and active-session composers on mobile 375x667 and desktop 1280x800 with mock normal, long text, many/empty/error/special-character scenarios as applicable.
- [ ] Run targeted validation during implementation, then full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before PR.
- [ ] Run required review skills: `ui-ux-specialist`, `task-completion-validator`, and `constitution-validator` if the implementation introduces configurable/business constants.

## Acceptance Criteria

- New-chat initial prompt and active-session follow-up prompt share the same core composer behavior.
- Active follow-up input auto-grows multiline like the initial prompt input.
- Active follow-up input supports `@mention` autocomplete for agent profiles.
- Active follow-up input supports slash-command autocomplete for cached/static/client commands.
- Initial prompt input still shows new-task-only controls and behaves as before.
- Follow-up input does not show new-task-only controls.
- Existing backend mention enrichment remains unchanged unless tests reveal a bug.
- UI remains visually coherent on mobile and desktop with no horizontal overflow or clipping.
- PR is opened with validation results and screenshot/audit notes.
