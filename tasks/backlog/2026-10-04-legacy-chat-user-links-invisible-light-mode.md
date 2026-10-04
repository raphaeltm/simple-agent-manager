# Links in workspace-chat user bubbles are invisible in light mode

## Problem

In the workspace chat for workspaces without a linked project session
(`LegacyChatSessionsView` → acp-client `AgentPanel` → `MessageBubble`), a link inside
a user message cannot be seen in the light theme. The user bubble uses `bg-blue-600`
and links use `text-blue-400`. `apps/web/src/styles/acp-chat.css` maps both to the
same color in light mode:

- `.bg-blue-600 { background-color: var(--sam-color-accent-primary); }`
- `[data-ui-theme='sam-light'] .text-blue-400 { color: var(--sam-color-accent-primary); }`

The link text matches the bubble background exactly. The dark theme is unaffected
(`.text-blue-400` is `#6ee7b7` there), and so is the project chat, whose user bubble
uses `glass-msg-user`.

## Context

Seen 2026-10-04 in the `user-message-actions-workspace-light-1280x800.png` screenshot from
`apps/web/tests/playwright/user-message-actions-audit.spec.ts`: the URL in
"Please review <url> and explain…" renders as blank space.

## Acceptance Criteria

- [ ] Links in the built-in user bubble are readable in both themes, for example a
      light-on-accent link color scoped to the user bubble
- [ ] A Playwright assertion compares the link's computed color against the bubble's
      background in light mode, and fails on the current CSS
