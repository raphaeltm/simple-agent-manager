# Add Chat Search to Global Command Palette

## Problem

The global command palette (Cmd+K) can search pages, projects, and nodes, but has no way to search for chat sessions. Users need to find and jump to chats by title, ordered by most recent.

## Research Findings

- **Command palette**: `apps/web/src/components/GlobalCommandPalette.tsx` — already supports categories (Navigation, Projects, Nodes, Actions) with fuzzy matching
- **Chat sessions API**: `listChatSessions(projectId, params)` in `apps/web/src/lib/api.ts` — fetches per-project, returns `{ sessions, total }`
- **Session fields**: `id`, `topic` (title, nullable), `createdAt`, `startedAt`, `status`, `projectId` (from context)
- **Fuzzy matching**: `apps/web/src/lib/fuzzy-match.ts` — shared utility already used by palette
- Sessions are stored in per-project Durable Objects, so must fetch per-project

## Implementation Checklist

- [ ] Add `ChatResult` type to `GlobalCommandPalette.tsx` with `kind: 'chat'`, `projectId`, `projectName`, `path`, etc.
- [ ] Include `ChatResult` in `PaletteResult` union type
- [ ] Fetch chat sessions from all projects on mount (parallel with existing fetches)
- [ ] Store sessions in state with project context (`{ ...session, projectId, projectName }`)
- [ ] Add "Chats" category to `groups` useMemo with fuzzy matching on `topic`
- [ ] When no query, show recent chats ordered by `createdAt` DESC
- [ ] When querying, fuzzy match on topic, break ties by `createdAt` DESC
- [ ] Show project name as secondary text in chat results
- [ ] Handle `executeResult` for `chat` kind — navigate to `/projects/:projectId/chat/:sessionId`
- [ ] Add `MessageSquare` icon for chat results
- [ ] Update placeholder text to mention "chats"
- [ ] Add configurable fetch limit for chat sessions
- [ ] Add tests for the new chat search functionality

## Acceptance Criteria

- [ ] Typing in the command palette searches chat sessions by topic/title
- [ ] Results are ordered by most recent message when no query is entered
- [ ] Selecting a chat result navigates to the correct project chat view
- [ ] Sessions with no topic show a fallback label (e.g., "Untitled Chat")
- [ ] Chat results show which project they belong to
- [ ] Existing palette functionality (navigation, projects, nodes) is unaffected
