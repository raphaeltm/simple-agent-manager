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
