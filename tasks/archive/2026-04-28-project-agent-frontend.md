# Project Agent Frontend UI

## Problem
The Project Agent backend (DO, routes, tools, system prompt) is fully implemented but has no frontend UI. Users need a chat interface to interact with the per-project AI technical lead. The frontend should share as much code as possible with the existing top-level SAM agent UI (SamPrototype.tsx).

## Research Findings

### Existing SAM UI Structure
- `SamPrototype.tsx` — monolithic page with inline SSE streaming, conversation loading, voice input, WebGL background
- `sam-prototype/components.tsx` — `ChatMessage` type, `MessageBubble`, `glass`/`glow` styles, mock data
- `sam-prototype/sam-markdown.tsx` — `SamMarkdown` component (react-markdown + prism-react-renderer)
- `sam-prototype/voice-input.ts` — `useVoiceInput` hook
- `sam-prototype/webgl-background.ts` — WebGL background animation

### Key Sharing Opportunities
1. **`ChatMessage` type** — identical structure for both SAM and project agent
2. **`MessageBubble` component** — renders user/agent messages with tool calls, can be parameterized with agent label
3. **SSE streaming logic** — `handleSend` pattern is identical, only URL differs
4. **Conversation loading** — same pattern, different API endpoint
5. **`SamMarkdown`** — markdown rendering, fully reusable
6. **`glass`/`glow` styles** — visual theme, reusable
7. **Voice input** — `useVoiceInput` hook, reusable as-is

### What Differs
- API endpoints: `/api/sam/*` vs `/api/projects/:projectId/agent/*`
- Agent label: "SAM" vs "Project Agent" (or project name)
- No WebGL background needed for project agent (embedded in project shell)
- No overview/project-node tab (project agent IS the project view)
- Layout: project agent lives inside the Project shell as a route

### Integration Points
- Route: `/projects/:id/agent` in App.tsx
- Nav: Add "Agent" item to `PROJECT_NAV_ITEMS` in NavSidebar.tsx
- Layout: Full-bleed like chat routes — regex update in Project.tsx
- Project context: Access `projectId` from `useParams()` or `ProjectContext`

### Backend API (already implemented)
- `POST /api/projects/:projectId/agent/chat` — SSE stream
- `GET /api/projects/:projectId/agent/conversations` — list conversations
- `GET /api/projects/:projectId/agent/conversations/:id/messages` — get messages
- `GET /api/projects/:projectId/agent/search` — full-text search

## Implementation Checklist

### Extract Shared Agent Chat Hook
- [x] Create `apps/web/src/hooks/useAgentChat.ts` — extract SSE streaming, conversation loading, message state from SamPrototype into a reusable hook
  - Parameters: `apiBase` (URL prefix), `agentLabel` (display name)
  - Returns: `messages`, `isSending`, `isLoadingHistory`, `conversationId`, `handleSend`, `inputValue`, `setInputValue`

### Create Project Agent Page
- [x] Create `apps/web/src/pages/ProjectAgentChat.tsx` — project agent chat page
  - Uses `useAgentChat` hook with `/api/projects/${projectId}/agent` base
  - Gets `projectId` from route params
  - Renders MessageBubble, SamMarkdown (shared components)
  - Full-bleed layout (like project chat)
  - No WebGL background (inherits project shell)
  - Agent label shows project name

### Wire Up Routing & Navigation
- [x] Add route `/projects/:id/agent` in App.tsx
- [x] Add "Agent" nav item to `PROJECT_NAV_ITEMS` in NavSidebar.tsx (after Chat)
- [x] Update full-bleed regex in Project.tsx to include agent route

### Refactor SamPrototype to Use Shared Hook
- [x] Refactor SamPrototype.tsx to use `useAgentChat` hook (proves sharing works)

### Tests
- [x] Unit test for `useAgentChat` hook
- [x] Verify all existing tests still pass

## Acceptance Criteria
- [ ] Project agent chat is accessible at `/projects/:id/agent`
- [ ] Chat sends messages and streams responses via SSE
- [ ] Conversation history persists across page loads
- [ ] MessageBubble, SamMarkdown, and tool call rendering are shared between SAM and project agent
- [ ] SSE streaming logic is shared via `useAgentChat` hook
- [ ] SamPrototype.tsx uses the same shared hook
- [ ] Navigation includes "Agent" item in project sidebar
- [ ] All existing tests pass
- [ ] New tests added for the shared hook

## References
- Backend DO: `apps/api/src/durable-objects/project-agent/index.ts`
- Backend routes: `apps/api/src/routes/project-agent.ts`
- SAM UI: `apps/web/src/pages/SamPrototype.tsx`
- Rule 26: Project Chat First (`.claude/rules/26-project-chat-first.md`)
