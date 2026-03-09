# Quickstart: Chat Message Display Parity

## What Changed

Three changes ensure chat messages render identically in workspace and project views:

1. **Tool call content data field**: Project chat now populates the `data` field for all content types (not just diffs), enabling JSON fallback rendering when text is empty.

2. **Shared PlanView component**: Plan entries now render via a shared component in `@simple-agent-manager/acp-client`, eliminating duplicated code between AgentPanel and ProjectMessageView.

3. **Raw fallback rendering**: Project chat now renders unknown message types as a visible fallback instead of silently dropping them.

## How to Verify

1. Run an agent task that produces tool calls with diffs, terminal output, and text content
2. View the session in the workspace chat (via `/workspaces/:id`)
3. View the same session in the project chat (via `/projects/:id`)
4. Compare: all tool call content, plans, and any unknown messages should display identically

## Files Changed

- `packages/acp-client/src/components/PlanView.tsx` — new shared plan component
- `packages/acp-client/src/components/RawFallbackView.tsx` — new shared fallback component
- `packages/acp-client/src/components/AgentPanel.tsx` — uses PlanView
- `apps/web/src/components/chat/ProjectMessageView.tsx` — fixes data field, uses shared components
