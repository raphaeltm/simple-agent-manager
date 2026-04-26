# SAM Agent — Implementation Plan

**Status**: Draft
**Created**: 2026-04-26
**Scope**: Phase 5 (SAM Top-Level Agent) + Phase 6 (Live Overview)

## Architecture

SAM is a **serverless conversational agent** that runs entirely on Cloudflare Workers. No VM, no workspace, no git repo. It's an LLM agent loop inside a Durable Object that calls Claude via the Anthropic API (routed through Cloudflare AI Gateway for token/cost tracking), executes tools as local function calls to existing services, and streams responses back to the browser via SSE.

```
Browser (/sam)
    |
    |  POST /api/sam/chat  { message: "..." }
    |  <- SSE stream (text deltas + tool call cards)
    |
    v
API Worker
    |
    |  auth (session cookie) -> resolve userId
    |  forward to SAM_SESSION DO
    |
    v
SAM_SESSION Durable Object  (one per user, keyed by userId)
    |
    |  1. Persist user message to SQLite
    |  2. Build messages array from conversation history
    |  3. Call Claude via AI Gateway (streaming)
    |  4. For each tool_use block:
    |     a. Execute tool (local function call to existing service)
    |     b. Append tool_result
    |     c. Continue generation
    |  5. Persist assistant message + tool results
    |  6. Stream text deltas + tool call metadata back as SSE
    |
    |---> Cloudflare AI Gateway (/anthropic path)
    |       |
    |       |  logs tokens, cost, latency, model
    |       |  cf-aig-metadata: {"source":"sam","userId":"..."}
    |       |
    |       +---> Anthropic Messages API
    |               claude-sonnet-4-20250514 (default, configurable)
    |
    |---> D1 (projects, tasks, nodes, users)
    |---> ProjectData DOs (sessions, activity, knowledge, policies)
    |---> ProjectOrchestrator DOs (mission scheduling, status)
    +---> KV (overview cache, rate limits)
```

### LLM Routing: AI Gateway (mandatory)

All Claude calls from SAM go through Cloudflare AI Gateway. This is non-negotiable — it's how we track token usage and cost.

**How it works**: Instead of calling `https://api.anthropic.com/v1/messages` directly, we call `https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AI_GATEWAY_ID}/anthropic/v1/messages`. Same request format, same headers, same response — the gateway is transparent. It logs every request with token counts, cost, latency, and model.

**Reuse existing infra**: The `buildAnthropicUrl(env)` function in `ai-proxy.ts` already constructs this URL. SAM reuses it. The AI Gateway ID and CF Account ID are already in env vars (`AI_GATEWAY_ID`, `CF_ACCOUNT_ID`).

**Tagging**: SAM requests include `cf-aig-metadata` header with `{"source":"sam","userId":"...","conversationId":"..."}` so SAM usage can be filtered separately from AI proxy usage in the gateway dashboard.

**API key**: Uses the platform Anthropic API key (same credential the AI proxy uses for `claude-*` models). Retrieved via `getPlatformAgentCredential()`.

**No Mastra for the agent loop**: The agent loop is raw `fetch()` to the Anthropic API via AI Gateway. Mastra is used only for overview summarization (single-shot Workers AI calls, same pattern as task-title.ts). Rationale: full control over streaming format, tool execution, DO integration, and AI Gateway metadata headers. See the Mastra vs Raw API analysis in the design conversation.

### Why a DO, not a stateless Worker route?

1. **Conversation state is write-heavy** — every message round-trip writes to SQLite. DO gives us colocated storage with zero-latency reads.
2. **Agent loop can be long-running** — a multi-tool-call turn might take 30-60s. DO handles this naturally; a Worker route would need `waitUntil()` (the exact pattern we're moving away from).
3. **Per-user isolation** — one DO per user means zero contention, natural rate limiting, and Cloudflare colocates it near the user.
4. **Future state** — Phase 7 policy learning needs persistent per-user state (approval patterns, preference history). The DO already has SQLite for this.

## Data Model

### SAM_SESSION DO — SQLite Tables

```sql
-- Migration v1
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool_result')),
  content TEXT NOT NULL,
  tool_calls_json TEXT,        -- JSON array of tool calls (for assistant messages)
  tool_call_id TEXT,           -- which tool_use this result responds to (for tool_result)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sequence INTEGER NOT NULL
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, sequence);

-- Metadata
CREATE TABLE IF NOT EXISTS do_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Simple. Two tables. The conversation history is the core state. Tool call results are stored inline so the full context can be rebuilt for the next LLM call.

### Why not reuse ProjectData DO?

ProjectData is project-scoped. SAM is user-scoped and cross-project. Different entity, different lifecycle, different access patterns. Forcing SAM into ProjectData would require a synthetic "SAM project" hack and complicate the already-large ProjectData DO.

## Agent Loop

The core loop follows the standard Anthropic tool-use pattern, implemented inside the DO:

```typescript
async function runAgentLoop(
  conversationId: string,
  userMessage: string,
  env: Env,
  userId: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  // 1. Load conversation history from SQLite
  const history = this.getMessages(conversationId);

  // 2. Build messages array
  const messages = [
    ...history.map(toAnthropicMessage),
    { role: 'user', content: userMessage },
  ];

  // 3. Persist user message
  this.persistMessage(conversationId, 'user', userMessage);

  // 4. Agent loop — keep calling until no more tool_use
  let continueLoop = true;
  while (continueLoop) {
    continueLoop = false;

    const response = await callAnthropic({
      model: this.config.model,
      system: SAM_SYSTEM_PROMPT,
      messages,
      tools: SAM_TOOLS,
      max_tokens: this.config.maxTokens,
      stream: true,
    });

    // 5. Process streaming response
    const { textContent, toolCalls } = await processStream(response, writer);

    // 6. Persist assistant message
    this.persistMessage(conversationId, 'assistant', textContent, toolCalls);

    // 7. If tool calls, execute them and continue
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const result = await executeTool(tc.name, tc.input, { env, userId });

        // Stream tool result to browser
        streamEvent(writer, { type: 'tool_result', tool: tc.name, result });

        // Persist tool result
        this.persistMessage(conversationId, 'tool_result', JSON.stringify(result), null, tc.id);

        // Add to messages for next iteration
        messages.push({
          role: 'assistant',
          content: [
            ...(textContent ? [{ type: 'text', text: textContent }] : []),
            ...toolCalls.map(toToolUseBlock),
          ],
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(result) }],
        });
      }
      continueLoop = true;
    }
  }

  streamEvent(writer, { type: 'done' });
}
```

### Streaming to the Browser

The DO returns an SSE stream. Each event is one of:

```
data: {"type":"text_delta","content":"I'll check on that..."}\n\n
data: {"type":"tool_start","tool":"list_projects","input":{}}\n\n
data: {"type":"tool_result","tool":"list_projects","result":{...}}\n\n
data: {"type":"text_delta","content":"You have 5 projects..."}\n\n
data: {"type":"done"}\n\n
```

The frontend maps these to UI elements:
- `text_delta` -> append to current message bubble
- `tool_start` -> show a "thinking" card (e.g., "Checking projects...")
- `tool_result` -> render as an inline card (MissionCard, ProjectStatusCard, etc.)
- `done` -> finalize the message

All events are unnamed SSE (just `data:` lines) — same pattern as the trial SSE events. This ensures `EventSource.onmessage` fires correctly. The `type` field inside the JSON payload discriminates event kinds.

### Calling Claude via AI Gateway

Direct Anthropic API call routed through AI Gateway. The DO makes the HTTP call itself — no need to go through the AI proxy route, since we're server-side and don't need the OpenAI format translation.

```typescript
async function callAnthropic(params: AnthropicRequest, env: Env, metadata: AigMetadata): Promise<Response> {
  // Route through AI Gateway for token/cost tracking
  const gatewayId = env.AI_GATEWAY_ID;
  const url = gatewayId
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages`
    : 'https://api.anthropic.com/v1/messages';

  // Platform Anthropic API key (same as AI proxy uses)
  const apiKey = await getAnthropicApiKey(env);

  return fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Tag for AI Gateway dashboard filtering
      'cf-aig-metadata': JSON.stringify(metadata),
    },
    body: JSON.stringify(params),
  });
}
```

The `cf-aig-metadata` header tags every SAM request so usage is filterable in the AI Gateway dashboard:
```json
{
  "source": "sam",
  "userId": "user_abc",
  "conversationId": "conv_xyz"
}
```

This lets you see SAM's token usage, cost, and latency separately from the AI proxy's usage. The gateway dashboard supports filtering by metadata fields.

**API key resolution**: Uses the platform Anthropic API key via `getPlatformAgentCredential(db, 'anthropic', 'api_key')` — same credential the AI proxy retrieves for `claude-*` model requests.

Configurable model — defaults to `claude-sonnet-4-20250514` for speed/cost, overridable to Opus via `SAM_MODEL` env var.

## SAM's Tool Set

SAM's tools are **direct function calls** to existing service-layer code. No MCP, no HTTP round-trip to self. The DO has access to `env` bindings (D1, KV, other DOs), so it calls the same service functions the API routes use.

Tool definitions follow Anthropic's tool schema format (not Mastra's `createTool`):

```typescript
const SAM_TOOLS: AnthropicTool[] = [
  {
    name: 'list_projects',
    description: 'List all projects owned by the current user with their status and recent activity.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'archived', 'all'],
          description: 'Filter by project status. Defaults to active.',
        },
      },
      required: [],
    },
  },
  // ... more tools
];
```

### Cross-Project Awareness

| Tool | What it does | Existing service |
|------|-------------|-----------------|
| `list_projects` | List all user's projects with status | `db.select().from(projects).where(eq(userId))` |
| `get_project_status` | Project detail + orchestrator status + recent tasks | Orchestrator DO `.getStatus()` |
| `get_recent_activity` | Recent activity across all projects | ProjectData DO `.getActivityEvents()` |
| `search_tasks` | Search tasks by status, project, keyword | D1 tasks table queries |
| `get_task_details` | Full task detail including execution state | D1 + ProjectData DO |

### Orchestration (Phases 2-3)

| Tool | What it does | Existing service |
|------|-------------|-----------------|
| `create_mission` | Create a multi-task mission | `missionService.createMission()` |
| `dispatch_task` | Dispatch a single task to an agent | `taskService.dispatchTask()` |
| `get_mission` | Get mission state and progress | `missionService.getMission()` |
| `get_orchestrator_status` | Scheduling queue, active missions | Orchestrator DO `.getStatus()` |
| `pause_mission` / `resume_mission` / `cancel_mission` | Mission lifecycle | Orchestrator DO RPCs |

### Communication (Phase 1)

| Tool | What it does | Existing service |
|------|-------------|-----------------|
| `send_message_to_agent` | Send durable message to running agent | Mailbox service |
| `get_agent_messages` | Check pending/recent messages for an agent | Mailbox service |

### Knowledge & Policy (Phase 4)

| Tool | What it does | Existing service |
|------|-------------|-----------------|
| `search_knowledge` | Search knowledge graph across projects | ProjectData DO |
| `list_policies` | List active delegation policies | PolicyService |
| `add_policy` | Create a new policy | PolicyService |

### Meta

| Tool | What it does | New code needed? |
|------|-------------|-----------------|
| `get_overview` | Aggregated cross-project health summary | New — aggregates from multiple DOs |

~15 tools total. All backed by existing service code. The only new implementation is `get_overview` which aggregates data from multiple sources.

## System Prompt

```
You are SAM — Simple Agent Manager. You are a senior engineering manager who orchestrates AI coding agents across multiple projects.

You have access to all of the user's projects, tasks, missions, and agents. You can dispatch work, check progress, coordinate multi-project efforts, and answer questions about what's happening across their engineering organization.

## Your personality
- Direct and concise — you're a busy manager, not a chatbot
- You proactively surface problems (stalled tasks, CI failures, blocked agents)
- You confirm before taking destructive or expensive actions (dispatching tasks, canceling missions)
- You think in terms of dependencies and priorities, not just individual tasks

## How you work
- When asked about status, check the real data — don't guess
- When asked to do something, create missions/tasks using the orchestration tools
- When multiple projects are involved, think about dependencies and sequencing
- When an agent is stuck, check its messages and suggest interventions

## What you don't do
- You don't write code yourself — you delegate to agents who do
- You don't make up project status — you check with tools
- You don't take action without confirming — dispatch, cancel, and policy changes are confirmed first
```

## API Routes

### `POST /api/sam/chat`

Authenticated (session cookie). Accepts a user message, forwards to SAM_SESSION DO, returns SSE stream.

```typescript
samRoutes.post('/chat', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const { message, conversationId } = await c.req.json();

  // Get or create conversation
  const stubId = c.env.SAM_SESSION.idFromName(userId);
  const stub = c.env.SAM_SESSION.get(stubId);

  // Forward to DO — returns SSE stream
  const response = await stub.fetch('https://sam-session/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, conversationId, userId }),
  });

  // Relay SSE stream to client
  return new Response(response.body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});
```

### `GET /api/sam/conversations`

List user's SAM conversations (for history sidebar, later).

### `GET /api/sam/conversations/:id/messages`

Load conversation history (for resuming a conversation).

### `GET /api/sam/overview`

Aggregated cross-project status for the Overview tab. Does NOT go through the DO — it's a stateless read that queries D1 + orchestrator DOs directly.

```typescript
samRoutes.get('/overview', requireAuth(), async (c) => {
  const userId = c.get('userId');

  // 1. List user's projects
  const userProjects = await db.select().from(projects).where(eq(projects.userId, userId));

  // 2. For each project, get orchestrator status + recent tasks
  const projectStatuses = await Promise.all(
    userProjects.map(async (p) => {
      const orchStub = c.env.PROJECT_ORCHESTRATOR.idFromName(p.id);
      const status = await orchStub.fetch('https://orch/status').then(r => r.json()).catch(() => null);
      const recentTasks = await getRecentTasks(db, p.id, 5);
      return { project: p, orchestrator: status, recentTasks };
    })
  );

  // 3. Optional: LLM summarization of each project's state (cached in KV)
  const summaries = await generateOverviewSummaries(projectStatuses, c.env);

  return c.json({ projects: summaries, generatedAt: new Date().toISOString() });
});
```

### Overview Summarization

For each project, generate a one-line summary like "3 agents running: auth refactor, policy tests, blog post. Auth agent 80% done."

- Use a cheap/fast model via Mastra + Workers AI (same pattern as task-title.ts): `@cf/google/gemma-3-12b-it` default
- Cache in KV with 60s TTL, keyed by `sam-overview-${projectId}`
- Summaries regenerated on cache miss or when project activity changes
- Fallback to template-based summary if LLM fails: "${activeCount} active tasks, last activity ${timeAgo}"

## Wrangler Binding

```toml
# wrangler.toml (top-level only — sync script copies to env sections)
[[durable_objects.bindings]]
name = "SAM_SESSION"
class_name = "SamSession"

[[migrations]]
tag = "v11"
new_sqlite_classes = ["SamSession"]
```

## Frontend Integration

Wire `SamPrototype.tsx` to real data:

### Chat View

```typescript
async function sendMessage(text: string) {
  setMessages(prev => [...prev, { role: 'user', content: text }]);

  const response = await fetch('/api/sam/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, conversationId }),
    credentials: 'include',
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentAssistantMessage = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));

      switch (event.type) {
        case 'text_delta':
          currentAssistantMessage += event.content;
          updateLastAssistantMessage(currentAssistantMessage);
          break;
        case 'tool_start':
          addToolCard({ tool: event.tool, status: 'running' });
          break;
        case 'tool_result':
          updateToolCard(event.tool, { status: 'done', result: event.result });
          break;
        case 'done':
          finalizeMessage();
          break;
      }
    }
  }
}
```

### Overview Tab

```typescript
const { data: overview } = useSWR('/api/sam/overview', fetcher, {
  refreshInterval: 30_000,  // refresh every 30s
});
```

Replace mock project data with `overview.projects`. Each project object includes:
- `name`, `status` (green/amber/grey), `summary` (LLM-generated one-liner)
- `activeAgents` count, `activeBranch`, `lastActivity` timestamp

## Configuration

All configurable via env vars with defaults in `packages/shared/src/constants/sam.ts`:

| Env Var | Default | Purpose |
|---------|---------|---------|
| `SAM_MODEL` | `claude-sonnet-4-20250514` | LLM model for SAM agent loop |
| `SAM_MAX_TOKENS` | `4096` | Max output tokens per turn |
| `SAM_MAX_TURNS` | `20` | Max tool-use loop iterations per message |
| `SAM_SYSTEM_PROMPT_APPEND` | `""` | Additional system prompt (user customization) |
| `SAM_OVERVIEW_CACHE_TTL_MS` | `60000` | Overview summary cache duration |
| `SAM_OVERVIEW_MODEL` | `@cf/google/gemma-3-12b-it` | Cheap model for overview summaries (via Mastra + Workers AI) |
| `SAM_RATE_LIMIT_RPM` | `30` | Max messages per minute per user |
| `SAM_MAX_CONVERSATIONS` | `100` | Max stored conversations per user |
| `SAM_MAX_MESSAGES_PER_CONVERSATION` | `500` | Max messages before truncation |
| `SAM_CONVERSATION_CONTEXT_WINDOW` | `50` | Messages sent to LLM per turn |
| `SAM_AIG_SOURCE` | `sam` | Source tag in cf-aig-metadata for AI Gateway filtering |

## Implementation Phases

### Phase A: DO + Agent Loop (the core)
1. Add `SamSession` DO class with SQLite migration, alarm, and `fetch()` handler
2. Add SAM constants to `packages/shared/src/constants/sam.ts`
3. Add `SAM_SESSION` binding to `wrangler.toml` + `Env` interface
4. Export `SamSession` class from `apps/api/src/index.ts`
5. Implement the agent loop: Anthropic API call via AI Gateway -> streaming -> tool execution -> persist
6. Implement 3 starter tools: `list_projects`, `get_project_status`, `search_tasks`
7. Add `/api/sam/chat` route with auth + SSE relay
8. Wire `SamPrototype.tsx` chat input to real SSE stream
9. Unit tests for DO state machine, tool execution, message persistence

### Phase B: Full Tool Set
10. Implement remaining tools: `create_mission`, `dispatch_task`, `get_mission`, orchestrator lifecycle, mailbox, knowledge, policies
11. Add confirmation flow: SAM asks "Should I dispatch this?" -> user confirms -> SAM executes
12. Tool result -> card rendering: map each tool's output to the appropriate inline card component
13. Integration tests for tool execution paths

### Phase C: Live Overview
14. Add `/api/sam/overview` endpoint with cross-project aggregation
15. Add KV-cached LLM summarization for project one-liners (Mastra + Workers AI, same pattern as task-title.ts)
16. Wire Overview tab to real data
17. Add real-time status indicators (agent counts, CI status, stall detection)

### Phase D: Conversation Management
18. Add conversation list/history endpoint
19. Add conversation switching in the UI
20. Add conversation title generation (reuse existing task-title Mastra pattern)
21. Add context window management (truncate old messages, keep system prompt + recent N)

### Phase E: Polish
22. Error handling: LLM failures, tool failures, rate limiting, timeout
23. Loading states: typing indicator while SAM thinks, skeleton cards while tools run
24. Mobile polish: keyboard handling, scroll-to-bottom, haptic feedback on tool cards
25. Desktop layout: consider side-by-side chat + overview at wide viewports

## Dependencies

- **Anthropic API key**: Must be available as a platform credential (already is for AI proxy)
- **AI Gateway**: Already configured for the AI proxy — same gateway, `/anthropic` path. `AI_GATEWAY_ID` and `CF_ACCOUNT_ID` env vars already set.
- **All orchestration primitives**: Phases 1-4 are deployed and working
- **No new external services**: Everything is internal to the existing Cloudflare stack

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Agent loop timeout (Worker 30s limit) | DO has no request timeout — the loop runs inside the DO, not the Worker. Worker just relays the SSE stream. |
| LLM cost per message | Default to Sonnet (fast, cheap). Rate limit per user. Monitor via AI Gateway dashboard — SAM tagged with `source: sam`. |
| Tool execution failures | Each tool has try/catch. On failure, return error message to LLM — it can explain the failure to the user. |
| Conversation context growth | Cap at N recent messages. Summarize older messages with cheap model. |
| Concurrent messages from same user | DO is single-threaded — second message queues behind first. UI disables input during generation. |
| AI Gateway unavailable | Falls back to direct Anthropic API (no gateway). Token tracking lost but functionality preserved. |
