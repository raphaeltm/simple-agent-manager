# ACP Client Package (packages/acp-client)

## Purpose

Shared React components for rendering Agent Communication Protocol (ACP) chat messages. Provides MessageBubble, ToolCallCard, AudioPlayer, and other components used in both the project chat view and task detail pages.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export — all components, hooks, types |
| `src/components/MessageBubble.tsx` | Chat message rendering (user, assistant, system roles) |
| `src/components/ToolCallCard.tsx` | Tool call display with expand/collapse, lazy content loading |
| `src/components/AudioPlayer.tsx` | TTS audio playback component |
| `src/components/MessageActions.tsx` | Message action buttons (copy, play audio, etc.) |
| `src/components/ThinkingBlock.tsx` | Thinking/reasoning content display |
| `src/components/AgentPanel.tsx` | Agent session panel container |
| `src/hooks/useAcpSession.ts` | ACP session WebSocket connection hook |
| `src/hooks/useAcpMessages.ts` | Message state management hook |
| `src/types.ts` | ACP message types, conversation item types |
| `src/transport/` | WebSocket transport layer |

## Commands

```bash
pnpm --filter @simple-agent-manager/acp-client build       # Compile TypeScript
pnpm --filter @simple-agent-manager/acp-client test        # Run Vitest
pnpm --filter @simple-agent-manager/acp-client typecheck   # Type check only
pnpm --filter @simple-agent-manager/acp-client lint        # ESLint
```

## Conventions

- Components accept callback props for actions that depend on the host context (e.g., `onPlayAudio`, `onLoadContent`)
- Message rendering supports compact mode — `contentSize` field indicates lazy-loadable tool content
- Uses `react-markdown` + `remark-gfm` for markdown rendering in messages
- `react-virtuoso` for virtualized message lists (performance with long conversations)
- Uses `prism-react-renderer` for syntax-highlighted code blocks

## Gotchas

- The `@agentclientprotocol/sdk` dependency defines the ACP wire protocol types
- `ToolCallCard` supports lazy content loading via `onLoadContent` callback — it does NOT fetch directly
- Components use `messageId` field for lazy loading — this is populated by compact mode in the API
- UI changes here trigger mandatory Playwright visual audit (rule 17)
- This is a peer-dependency package — consumers must provide React 19+

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/04-ui-standards.md`: UI Standards
- `.claude/rules/17-ui-visual-testing.md`: Mandatory Playwright Visual Testing for UI Changes
- `.claude/rules/48-stale-while-revalidate-ui.md`: Stale-While-Revalidate UI (No Hiding, No Refetch Loops)
- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`: Horizontal Overflow Inside `overflow-x-hidden` Is Invisible to Document-Level Checks
- `.claude/rules/64-unstable-prop-identity-remounts-subtrees.md`: An Object Literal in a Render Body Can Remount an Entire Subtree
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State

<!-- END GENERATED RULE INDEX -->
