# Notification System Research: Human-in-the-Loop for Agentic Workflows

**Date**: 2026-03-14
**Status**: Research / Exploration
**Context**: SAM runs autonomous AI coding agents on VMs. When agents finish work, hit blockers, or need human input, there's currently no mechanism to notify the user — they must actively check the UI.

---

## 1. Problem Statement

SAM agents run autonomously in VM workspaces. Today, when an agent:
- Completes a task and creates a PR
- Gets stuck and needs human guidance
- Encounters an error and fails
- Hands control back after a conversation turn

...the user has **no way to know** without manually checking the UI. This is especially problematic when multiple agents run across multiple projects simultaneously.

### Current State in SAM

SAM already has several lifecycle signals that could drive notifications:

| Signal | Where It Fires | Current Behavior |
|--------|----------------|------------------|
| `OnPromptComplete` callback | `session_host.go:660,683` | Reports stop reason back to control plane via status callback |
| `complete_task` MCP tool | `apps/api/src/routes/mcp.ts` | Agent explicitly marks task done; transitions to `awaiting_followup` |
| `update_task_status` MCP tool | `apps/api/src/routes/mcp.ts` | Agent reports progress; recorded as activity event |
| Task state transitions | `task-runner.ts` | Steps: `node_selection` → ... → `running` → completion |
| Activity events | `project-data.ts` | Records `task.submitted`, `task.agent_completed`, `session.started`, etc. |
| Agent session stop reason | `session_host.go` | ACP SDK returns `end_turn`, `error`, etc. when `Prompt()` completes |
| Git push + PR creation | `server.go` (finalization) | Agent completion triggers git push and optional PR |

The infrastructure for **detecting** when things happen exists. What's missing is the **notification delivery** layer.

---

## 2. Prior Art: How Other Platforms Handle This

### 2.1 Detection Patterns

Platforms use a spectrum of approaches to detect when an agent needs human attention:

| Approach | Reliability | Used By | Notes |
|----------|------------|---------|-------|
| **Explicit tool call** ("mark_complete", "ask_user") | High | OpenAI Agents SDK, LangGraph, SAM (`complete_task`) | Agent decides when to signal |
| **Lifecycle hooks** | High | Claude Code (hooks system) | Platform fires events at state transitions |
| **Artifact creation** (PR, commit) | Medium | Devin, GitHub Copilot | May not always create one |
| **Exit code analysis** | High for CLI | Claude Code hooks | `Stop` event with exit code |
| **Heartbeat absence** | High for crashes | SAM's existing `NodeLifecycle` DO | Detects VM failure, not agent completion |
| **Checkpoint/interrupt** | High | LangGraph | Persisted state machine with explicit pause points |
| **Timeout/max turns** | High as fallback | All platforms | Safety net, not primary signal |
| **Output parsing** (detecting questions) | Low | Some custom implementations | Fragile, not recommended |

**Key insight**: The most reliable pattern is **agent-initiated signaling** (the agent tells you it's done or blocked) rather than external monitoring (trying to infer state from the outside). SAM's existing MCP tools (`complete_task`, `update_task_status`) already follow this best practice.

### 2.2 Platform Comparison

**Claude Code** uses a hooks system that fires events like `Stop`, `Notification` (with subtypes `permission_prompt`, `idle_prompt`, `elicitation_dialog`), and `TaskCompleted`. Users can wire these to OS notifications, Slack, etc. via shell scripts.

**GitHub Copilot Coding Agent** uses PR creation as the primary completion signal. It adds an eye emoji on the issue when starting, pushes commits to a draft PR, and converts to ready-for-review when done. The CLI shows background task status in a timeline with `/resume` to switch contexts.

**Devin** opens a PR when work completes and sends Slack notifications for status updates. The web UI shows real-time workspace state.

**OpenAI Agents SDK** uses `RunResult.interruptions` — tool approval items surface in the result object. The execution loop terminates on text output with no pending tool calls.

**LangGraph** provides an `interrupt()` function with a checkpointer. Graph execution pauses at a checkpoint, marks the thread as interrupted, and stores interrupt data. Resume with `Command(resume=...)`.

**Cursor** added sound notifications (v0.48+) and desktop notifications when the agent is waiting for confirmation. No native mobile push — this is a frequent community complaint.

### 2.3 MCP-Based Notification Patterns

Several MCP tools have emerged for agent-to-human notification:

- **MCP Elicitation** (draft spec): Standardized protocol for servers to request structured user input mid-execution. Two modes: form (JSON Schema fields) and URL (redirect for sensitive data). Limitation: client timeout continues during elicitation.

- **Pushary**: Commercial MCP server for mobile push notifications. Key tool: `ask_user_yes_no()` for approval flows. Design philosophy: "The agent decides when it's blocked, not the user."

- **ntfy-mcp-server**: Open-source, self-hostable. Agent calls a tool to send a push notification via ntfy.sh.

- **ask-user-questions-mcp**: Lightweight MCP server for multi-choice questions with native OS notification and question queuing.

### 2.4 Cloudflare-Native Patterns

Since SAM runs on Cloudflare Workers, these patterns are directly applicable:

**Cloudflare Agents SDK + Knock**: Agent calls Knock to trigger a multi-channel notification workflow. Knock sends via in-app, email, SMS, push, Slack — respecting user preferences. User interacts (approve/reject), Knock fires webhook back to the agent, agent resumes. Uses Durable Objects for state persistence.

**Cloudflare Workflows**: Durable, multi-step processes that can wait hours/days/weeks for human input. Natural fit for approval gates.

---

## 3. Notification Type Taxonomy

Based on the research, notifications should map to distinct categories with different urgency levels:

| Type | Urgency | SAM Trigger | Example |
|------|---------|-------------|---------|
| **Task Complete** | Medium | `complete_task` MCP tool / `awaiting_followup` state | "Agent finished task #42 — PR ready for review" |
| **Needs Input** | High | New MCP tool (`request_human_input`) or agent exit with questions | "Agent on Project X needs your guidance on database schema" |
| **Error/Failed** | High | Task transitions to `failed` state | "Task #42 failed: build error in project X" |
| **Progress Update** | Low | `update_task_status` MCP tool | "Agent completed 3/5 checklist items on task #42" |
| **Session Ended** | Medium | `OnPromptComplete` with `end_turn` stop reason (non-task chat) | "Chat session in Project X is waiting for your reply" |
| **PR Created** | Medium | Git push + PR creation in finalization | "Agent created PR #123 in project X" |

### Urgency → Channel Mapping (Default)

| Urgency | Channels |
|---------|----------|
| **High** | In-app + browser push + external (Slack/email) |
| **Medium** | In-app + browser push |
| **Low** | In-app only (badge update) |

Users should be able to override these defaults per-project and per-type.

---

## 4. Proposed Architecture for SAM

### 4.1 Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   VM Agent      │     │   API Worker      │     │   Web UI            │
│                 │     │                   │     │                     │
│ OnPromptComplete├────►│ Notification      ├────►│ Notification Center │
│ MCP tools       │     │ Service           │     │ (bell icon + drawer)│
│ Status callback │     │                   │     │                     │
│                 │     │ ┌───────────────┐ │     │ ┌─────────────────┐ │
│                 │     │ │ Notification  │ │     │ │ EventSource/WS  │ │
│                 │     │ │ DO (per-user) │ │     │ │ subscription    │ │
│                 │     │ └───────┬───────┘ │     │ └─────────────────┘ │
│                 │     │         │         │     │                     │
│                 │     │    ┌────┴────┐    │     └─────────────────────┘
│                 │     │    │ Channel │    │
│                 │     │    │ Router  │    │
│                 │     │    └────┬────┘    │
│                 │     │    ┌───┬┴──┬───┐  │
│                 │     │    │   │   │   │  │
└─────────────────┘     │  Push Email Slack │
                        │  Notif       Webhook│
                        └──────────────────┘
```

### 4.2 Components

#### A. Notification Events (Sources)

Notification events originate from existing lifecycle hooks — **no new detection logic needed**:

1. **Task state transitions** (already tracked in `project-data.ts` activity events):
   - `task.agent_completed` → "Task Complete" notification
   - Task failed → "Error/Failed" notification

2. **MCP tool calls** (already handled in `mcp.ts`):
   - `complete_task` → "Task Complete" notification
   - `update_task_status` → "Progress Update" notification (batched/throttled)
   - **New**: `request_human_input` → "Needs Input" notification (high urgency)

3. **Agent session lifecycle** (via `OnPromptComplete` callback → status callback):
   - `end_turn` stop reason in a chat context → "Session Ended" notification
   - `error` stop reason → "Error/Failed" notification

4. **Git/PR events** (already in finalization flow):
   - PR created → "PR Created" notification

#### B. Notification Service (API Worker)

A new service that:
1. Receives notification events from existing hooks (task state changes, MCP tool completions, status callbacks)
2. Resolves the target user(s) from the project/task ownership
3. Creates a notification record (stored in a per-user Notification DO or D1 table)
4. Routes to configured channels based on urgency and user preferences

#### C. Notification Durable Object (Per-User)

A per-user DO that:
- Stores notification state (unread count, notification list, preferences)
- Maintains a WebSocket or SSE connection to the user's browser for real-time delivery
- Handles read/dismiss/mark-all-read operations
- Manages notification preferences (per-project, per-type, per-channel)

**Why a per-user DO?** Notifications are inherently user-scoped and write-heavy (multiple projects firing events). A DO per user avoids D1 write contention and enables real-time push via WebSocket.

#### D. Web UI Notification Center

- Bell icon with unread badge in the top navigation bar
- Slide-out drawer showing chronological notification list
- Filter tabs: All / Unread / By Type
- Inline action buttons: "View PR", "Open Chat", "Dismiss"
- Click-through navigation to the relevant project/task/chat
- Group by project when multiple notifications from same project

#### E. External Channel Integrations (Phase 2+)

- **Browser Push Notifications** (Web Push API) — works even when the tab is not active
- **Slack webhook** — post to a user-configured channel
- **Email digest** — batched summary of notifications (hourly/daily)
- **ntfy.sh** — self-hostable push notification service (lightweight, no vendor lock-in)

### 4.3 New MCP Tool: `request_human_input`

This is the most interesting new capability. It gives agents an explicit way to say "I'm blocked and need human help."

```typescript
// New MCP tool definition
{
  name: "request_human_input",
  description: "Request input from the human user. Use when you are blocked, need a decision, or need clarification. Provide context about what you need.",
  inputSchema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description: "What you need from the human and why (max 1000 chars)"
      },
      category: {
        type: "string",
        enum: ["decision", "clarification", "approval", "error_help", "other"],
        description: "The type of input needed"
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional: specific choices for the human to pick from"
      }
    },
    required: ["context"]
  }
}
```

When called:
1. Creates a high-urgency "Needs Input" notification
2. Stores the context/options in the notification record
3. The notification links directly to the chat session where the agent is waiting
4. The agent can then either continue working on other things or wait

**Important design decision**: This tool should NOT block the agent. It fires a notification and returns immediately. The agent can choose to:
- Continue working on other aspects of the task
- Call `complete_task` with a partial summary, noting what needs human input
- Simply end its turn (in chat mode, control returns to the human naturally)

### 4.4 Passive Detection: Agent Turn Completion in Chat Mode

For non-task chat sessions, we can infer "human attention needed" without the agent explicitly calling a tool:

1. `OnPromptComplete` fires with `end_turn` stop reason
2. VM agent sends status callback to control plane
3. If the session is a **chat** (not a task), this means the agent has finished its turn and is waiting for human input
4. Generate a "Session Ended / Your Turn" notification

**Suppression logic** — don't notify if:
- The user is currently viewing that chat session (they saw it happen)
- The agent called `complete_task` (already generating a different notification)
- The turn was very short (< 5 seconds) — likely an error or trivial response

### 4.5 Data Model

```sql
-- Per-user notification storage (could be in D1 or per-user DO SQLite)
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,           -- ULID
  user_id TEXT NOT NULL,
  project_id TEXT,               -- nullable for system notifications
  task_id TEXT,                  -- nullable
  session_id TEXT,               -- nullable
  type TEXT NOT NULL,            -- 'task_complete' | 'needs_input' | 'error' | 'progress' | 'session_ended' | 'pr_created'
  urgency TEXT NOT NULL,         -- 'high' | 'medium' | 'low'
  title TEXT NOT NULL,
  body TEXT,                     -- detailed context
  action_url TEXT,               -- deep link into SAM UI
  metadata TEXT,                 -- JSON blob for type-specific data (e.g., PR URL, options for input request)
  read_at TEXT,                  -- null if unread
  dismissed_at TEXT,             -- null if not dismissed
  created_at TEXT NOT NULL
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;

-- User notification preferences
CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL,
  notification_type TEXT NOT NULL, -- matches type column above, or '*' for default
  project_id TEXT,                 -- nullable, null = global default
  channel TEXT NOT NULL,           -- 'in_app' | 'browser_push' | 'slack' | 'email'
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, notification_type, project_id, channel)
);
```

---

## 5. Implementation Phasing

### Phase 1: In-App Notification Center (Foundation)

- Notification service in API worker
- Per-user Notification DO with SQLite storage
- WebSocket connection for real-time delivery to browser
- Bell icon + notification drawer in web UI
- Wire up existing lifecycle hooks (task complete, task failed, session ended)
- Basic preferences (enable/disable per type)

**Scope**: ~2-3 weeks. Delivers immediate value — users can see when agents finish across all projects.

### Phase 2: Agent-Initiated Notifications

- Add `request_human_input` MCP tool
- Passive detection for chat turn completion
- Notification suppression logic (user already viewing, etc.)
- Notification grouping by project

**Scope**: ~1-2 weeks. Adds the most differentiated capability.

### Phase 3: External Channels

- Browser Push Notifications (Web Push API with VAPID keys)
- Slack integration (webhook-based, user configures in Settings)
- Email digest (batched, configurable frequency)
- Per-channel, per-project, per-type preference matrix

**Scope**: ~2-3 weeks per channel. Can be incremental.

### Phase 4: Advanced Patterns

- Smart notification batching (combine multiple progress updates into one)
- Escalation chains (in-app → push after 5 min → Slack after 15 min if unacknowledged)
- Notification analytics (which types get read, response times)
- Cross-agent coordination notifications ("Agent A is waiting for Agent B's PR")

---

## 6. Key Design Decisions to Make

### 6.1 Storage: D1 vs Per-User DO?

| Option | Pros | Cons |
|--------|------|------|
| **D1 table** | Simple queries, familiar SQL, cross-user queries for admin | Write contention under load, no built-in real-time push |
| **Per-user DO** | Real-time WebSocket, no contention, SQLite for queries | Can't easily query across users, slightly more complex |
| **Hybrid** | D1 for preferences + admin; DO for real-time state | Two storage layers to maintain |

**Recommendation**: Per-user DO with SQLite, matching the existing `ProjectData` DO pattern. Notifications are inherently user-scoped and benefit from real-time WebSocket delivery.

### 6.2 Real-Time Delivery: WebSocket vs SSE vs Polling?

| Option | Pros | Cons |
|--------|------|------|
| **WebSocket** (via DO) | Bidirectional, proven pattern in SAM | Connection management overhead |
| **SSE** (Server-Sent Events) | Simpler, HTTP-based, auto-reconnect | One-directional, CF Workers SSE support is good |
| **Polling** | Simplest implementation | Latency, unnecessary requests |

**Recommendation**: WebSocket via the per-user Notification DO, matching SAM's existing DO WebSocket patterns. SSE is a viable alternative if simpler implementation is preferred.

### 6.3 Notification Lifetime and Cleanup

- **Auto-dismiss**: Read notifications older than 30 days
- **Auto-delete**: All notifications older than 90 days
- **Max stored**: 500 per user (FIFO for old dismissed notifications)
- All limits configurable via env vars per constitution Principle XI

### 6.4 Multi-Tab Handling

If a user has multiple browser tabs open:
- All tabs connect to the same per-user DO via WebSocket
- Unread count syncs across all tabs
- "Mark as read" in one tab propagates to others via the DO's broadcast
- Suppression check (user is viewing chat) only needs one tab to be viewing it

---

## 7. Relationship to Existing SAM Concepts

### Activity Events vs Notifications

SAM already has an activity event system in `ProjectData` DO (`task.submitted`, `task.agent_completed`, etc.). Notifications are **not** the same as activity events:

| | Activity Events | Notifications |
|---|---|---|
| **Scope** | Per-project | Per-user (cross-project) |
| **Purpose** | Audit trail / project history | User attention routing |
| **Storage** | ProjectData DO | Notification DO (per-user) |
| **Delivery** | Pull (query API) | Push (real-time to browser) |
| **Lifecycle** | Permanent record | Transient (read → dismissed → deleted) |

Activity events are the **source** for some notifications, but they serve different purposes. A notification is "you need to look at this"; an activity event is "this happened."

### Chat Sessions vs Notifications

Chat sessions already have real-time WebSocket delivery for messages. Notifications complement this:
- If the user is watching the chat, they see agent output in real-time → no notification needed
- If the user is on a different page or has the browser minimized → notification tells them to come back
- Cross-project: user is chatting in Project A, agent finishes in Project B → notification alerts them

---

## 8. Open Questions

1. **Should `request_human_input` support structured responses?** The MCP Elicitation spec supports JSON Schema-validated forms. Should SAM's version allow the agent to define response schemas, or keep it simple (free-text reply in the chat)?

2. **Should notifications aggregate across a team?** Current design is single-user (the project owner). If SAM adds team/org support, notifications would need to route to multiple users with role-based filtering.

3. **How aggressive should passive detection be?** For every chat turn completion, generating a notification could be noisy. Should there be a configurable delay (e.g., only notify if the user hasn't returned to the chat within 2 minutes)?

4. **Should we integrate with Claude Code's hooks system?** When agents run Claude Code on the VM, Claude Code itself has a hooks system that fires events. Could the VM agent subscribe to these hooks for richer signals (e.g., permission prompts)?

5. **What about mobile?** Browser push works on mobile browsers but not as reliably as native push. If mobile is important, an external service (ntfy, Pushover, or a thin notification proxy) would be needed.

---

## 9. Sources

- [Cloudflare Agents SDK: Human-in-the-Loop](https://developers.cloudflare.com/agents/guides/human-in-the-loop/)
- [Cloudflare + Knock: Building AI Agents](https://blog.cloudflare.com/building-agents-at-knock-agents-sdk/)
- [MCP Elicitation Specification (Draft)](https://modelcontextprotocol.io/specification/draft/client/elicitation)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [OpenAI Agents SDK: Human-in-the-Loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [LangGraph: interrupt() for HITL](https://blog.langchain.com/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt/)
- [Vercel AI SDK: Agent Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [GitHub Copilot Coding Agent](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/)
- [Pushary MCP](https://www.producthunt.com/products/pushary)
- [ntfy-mcp-server](https://github.com/cyanheads/ntfy-mcp-server)
- [ask-user-questions-mcp](https://github.com/paulp-o/ask-user-questions-mcp)
- [Smashing Magazine: Notification UX Guidelines](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)
- [Carbon Design System: Notification Pattern](https://carbondesignsystem.com/patterns/notification-pattern/)
