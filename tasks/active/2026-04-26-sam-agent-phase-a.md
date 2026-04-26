# SAM Agent Phase A: DO + Agent Loop + SSE Streaming

## Problem

Build the core "it talks" milestone for the SAM top-level agent. This creates a per-user Durable Object (`SamSession`) with an embedded agentic loop that calls Claude via Cloudflare AI Gateway, executes tools, and streams responses to the browser as SSE. The existing prototype UI at `/sam` gets wired to real data for the chat view.

## Research Findings

### Architecture
- SamSession DO: one per user, keyed by `userId`. SQLite tables: `conversations` + `messages`
- Raw Anthropic API via AI Gateway (NOT Mastra) — `fetch()` to `https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AI_GATEWAY_ID}/anthropic/v1/messages`
- AI Gateway URL built with same pattern as `buildAnthropicUrl()` in `ai-proxy.ts:106`
- API key: `getPlatformAgentCredential(db, 'claude-code', encryptionKey)` — same as AI proxy
- SSE streaming: unnamed events (`data: {json}\n\n`), same pattern as trial SSE events
- Tool definitions: Anthropic native tool schema format

### Key Patterns
- Auth: `requireAuth()` middleware → `c.get('auth').user.id` for userId
- DO binding: add to `wrangler.toml` top-level only, sync script copies to env sections
- DO export: from `apps/api/src/index.ts`
- Route mounting: `app.route('/api/sam', samRoutes)` in index.ts
- Env interface: `apps/api/src/env.ts` — add `SAM_SESSION: DurableObjectNamespace`
- Current migration tag: v10 → next is v11
- Platform credential for Anthropic: agent type `claude-code`, key `api_key`
- SSE format: unnamed events (just `data:` lines, no `event:` line) per trial SSE post-mortem

### Reference Files
- `specs/sam-agent/plan.md` — full architecture, data model, code examples
- `apps/api/src/routes/ai-proxy.ts:106` — `buildAnthropicUrl()` pattern
- `apps/api/src/routes/trial/events.ts` — SSE streaming pattern
- `apps/api/src/durable-objects/project-data/` — DO + SQLite pattern
- `apps/api/src/durable-objects/project-orchestrator.ts` — DO alarm pattern
- `apps/api/src/middleware/auth.ts` — requireAuth, AuthContext
- `apps/api/src/services/platform-credentials.ts` — getPlatformAgentCredential
- `apps/web/src/pages/SamPrototype.tsx` — prototype UI to wire up

## Implementation Checklist

### 1. Shared Constants
- [ ] Create `packages/shared/src/constants/sam.ts` with SAM-specific defaults
- [ ] Export from `packages/shared/src/constants/index.ts`
- [ ] Build shared package

### 2. Wrangler + Env Setup
- [ ] Add `SAM_SESSION` DO binding to `apps/api/wrangler.toml` (top-level)
- [ ] Add migration `v11` with `new_sqlite_classes = ["SamSession"]`
- [ ] Add `SAM_SESSION: DurableObjectNamespace` to `apps/api/src/env.ts`
- [ ] Add SAM env vars to `apps/api/src/env.ts` (SAM_MODEL, SAM_MAX_TOKENS, etc.)

### 3. SamSession Durable Object
- [ ] Create `apps/api/src/durable-objects/sam-session/` directory structure
- [ ] Create `index.ts` — main DO class with SQLite migration, fetch handler
- [ ] Create `agent-loop.ts` — runAgentLoop, callAnthropic, processAnthropicStream
- [ ] Create `tools/index.ts` — tool registry and executor
- [ ] Create `tools/list-projects.ts` — query D1 projects table
- [ ] Create `tools/get-project-status.ts` — project detail + orchestrator status + recent tasks
- [ ] Create `tools/search-tasks.ts` — search tasks by status/project/keyword
- [ ] Create `types.ts` — shared types for SAM session

### 4. API Routes
- [ ] Create `apps/api/src/routes/sam.ts` with:
  - `POST /chat` — auth, forward to DO, relay SSE stream
  - `GET /conversations` — list conversations
  - `GET /conversations/:id/messages` — load history
- [ ] Mount in `apps/api/src/index.ts`
- [ ] Export SamSession class from `apps/api/src/index.ts`

### 5. Frontend Wiring
- [ ] Wire `SamPrototype.tsx` chat input to `/api/sam/chat` SSE stream
- [ ] Parse SSE events: text_delta, tool_start, tool_result, done
- [ ] Display streaming text and tool results
- [ ] Handle error states and loading

### 6. Tests
- [ ] Unit test: message persistence in SamSession DO
- [ ] Unit test: agent loop with mocked Anthropic response
- [ ] Unit test: tool execution (list_projects, get_project_status, search_tasks)
- [ ] Unit test: SSE format correctness (unnamed events)
- [ ] Integration test: full chat round-trip with mocked Anthropic API

## Acceptance Criteria

1. User can navigate to `/sam` and send a chat message
2. SAM responds via SSE streaming (text deltas appear incrementally)
3. SAM can use tools: list_projects, get_project_status, search_tasks
4. Tool calls appear as cards in the chat UI
5. Conversation history persists in DO SQLite
6. All Claude calls routed through AI Gateway with cf-aig-metadata
7. Rate limiting enforced (configurable RPM per user)
8. All constants configurable via env vars (constitution Principle XI)
9. Unit and integration tests pass
10. No horizontal overflow on mobile (375px)
