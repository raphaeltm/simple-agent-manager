# Conversation Forking & Context Summarization Research

**Date**: 2026-03-13
**Status**: Research document
**Related**: `docs/notes/2026-03-07-chat-continuity-after-workspace-cleanup.md`

## Problem Statement

When a workspace is destroyed (task completed, idle timeout, manual deletion), the user often wants to continue work in a new task. The code context is recoverable via git, but the *conversational* context — what files were discussed, what decisions were made, what the agent was doing — is lost. Starting fresh forces the user to re-explain everything.

We need a mechanism to **fork a conversation**: take the history from a completed session and provide meaningful context to a new agent instance, so work can continue without starting from zero.

## What We Have Today

### Existing Infrastructure

The codebase already has significant infrastructure for this:

1. **Messages survive workspace destruction** — All chat messages (user, assistant, system, tool) persist in ProjectData DO SQLite (`chat_messages` table). Messages are stored with role, content, tool_metadata, and sequence number.

2. **ACP session fork API exists** — `POST /api/projects/:id/acp-sessions/:sessionId/fork` creates a new ACP session with `parentSessionId` link, incremented `forkDepth` (max 10), and `contextSummary` stored as `initialPrompt`. The parent must be in a terminal state (completed/failed/interrupted).

3. **Fork lineage query exists** — `GET /api/projects/:id/acp-sessions/:sessionId/lineage` returns the full ancestry tree using a recursive CTE.

4. **Message retrieval API exists** — `GET /api/projects/:projectId/sessions/:sessionId` returns cursor-paginated messages (up to 1000 per batch) with `hasMore` for pagination.

5. **Task metadata survives** — D1 stores `output_branch`, `output_pr_url`, `output_summary`, and full task description.

6. **Workers AI integration** — `@cf/meta/llama-3.1-8b-instruct` via Mastra + workers-ai-provider. The `task-title.ts` service provides a proven pattern for LLM calls with timeout, retry, and fallback.

### The Gap

The fork API exists but requires the **client** to provide `contextSummary` as a string. There is:
- No server-side message summarization service
- No UI for triggering a fork or generating context
- No mechanism for the new agent to access the parent session's message history
- No smart filtering of messages (e.g., exclude tool calls, prioritize recent messages)

## Key Design Decisions

### 1. Where Should Summarization Happen?

**Option A: Server-side (Workers AI)**

Generate the summary on the control plane using Workers AI when the user requests a fork.

```
User clicks "Continue" → API fetches messages → Workers AI summarizes →
Summary stored as initialPrompt → New task provisioned with summary
```

Pros:
- Consistent quality — same model, same prompt every time
- User doesn't need to craft context manually
- Can be optimized over time without changing clients

Cons:
- Workers AI has latency (1-5s for Llama 3.1 8B)
- 8K token context window limits how many messages can be processed in one call
- Adds AI dependency to a user-facing action (fork)
- Cost per fork

**Option B: Client-side (browser)**

The web UI fetches messages, filters/truncates them, and sends as `contextSummary`.

Pros:
- No AI dependency for forking
- User can review/edit the context before submitting
- Works offline from the AI service

Cons:
- Context quality depends on simple heuristics (truncation, filtering)
- No intelligence about what's important
- More frontend code

**Option C: Hybrid (recommended)**

Server generates a summary via Workers AI, presents it to the user in the fork dialog for review/editing, then submits. Falls back to heuristic extraction if AI fails.

```
User clicks "Continue" → API generates summary (AI) →
UI shows summary for review → User edits if needed →
Fork submitted with final summary
```

This gives AI-quality summarization with user control, and degrades gracefully.

### 2. What Should the Summary Contain?

Based on what agents need to resume work effectively:

**Must include:**
- The original task description / user's request
- Key decisions made during the conversation
- Files that were modified or discussed (paths)
- Current state of the work (what's done, what's remaining)
- The output branch name (so the new workspace checks it out)
- Any errors or blockers encountered

**Should exclude:**
- Tool call details (file diffs, grep results, bash output) — too verbose, not useful as context
- System messages (status updates, workspace events)
- Thinking/plan blocks — internal reasoning doesn't help a new agent
- Duplicate information across messages

**Should prioritize:**
- Recent messages over older ones (recency bias matches how humans think about "where we left off")
- User messages (they contain intent and direction)
- Assistant messages that contain decisions, plans, or summaries
- The final few exchanges (most likely to contain the current state)

### 3. How Should the New Agent Access Context?

Three approaches, not mutually exclusive:

**A: Summary in initial prompt (current design)**

The fork's `contextSummary` becomes the `initialPrompt` for the new ACP session. The agent starts with: "Here's a summary of previous work: [summary]. Now, [new user instruction]."

Pros: Simple, works with any agent. Cons: Limited by prompt size, lossy.

**B: Message history accessible via API**

The new agent could access the parent session's full message history via an API or MCP tool. For example, the `get_instructions` MCP tool could include a `parentSessionId` and the agent could call `get_session_messages(parentSessionId)` to browse history.

Pros: Full fidelity, agent can search for specific details. Cons: Requires agent to know to look, uses context window reading history.

**C: Structured context document**

Generate a structured document (not just a text summary) that includes:
```
## Previous Task Context
- **Task**: [original description]
- **Branch**: sam/fix-login-timeout
- **PR**: #42
- **Files Modified**: src/auth.ts, src/middleware/session.ts
- **Status**: Completed — login timeout increased from 30s to 60s
- **Key Decisions**:
  - Used exponential backoff instead of fixed retry
  - Added configurable timeout via SESSION_TIMEOUT_MS env var

## Conversation Summary (last 20 messages)
[filtered, summarized conversation]
```

This gives the agent actionable context without needing to parse a wall of text.

**Recommendation: A + C combined** — structured context document as the initial prompt, with the option to access full history via MCP in a future iteration.

## Summarization Strategy

### Message Filtering Pipeline

```
All messages in session
  → Filter: exclude role='tool' (removes tool calls/results)
  → Filter: exclude role='system' (removes status events)
  → Filter: exclude role='thinking' and role='plan'
  → Keep: role='user' and role='assistant' only
  → Sort: chronological (created_at + sequence)
  → Weight: recent messages get more space in summary
```

### Chunking for LLM Context Window

Llama 3.1 8B has ~8K token context. A typical conversation message is 50-200 tokens. So we can fit roughly 30-100 messages in context.

**Strategy for conversations of different sizes:**

| Session Size | Approach |
|-------------|----------|
| ≤20 messages (after filtering) | Include all messages verbatim in context |
| 21-50 messages | Include all, but truncate individual messages to 500 chars |
| 51-100 messages | Include first 5 + last 30 messages, truncate to 300 chars each |
| 100+ messages | Include first 5 + last 20 messages, summarize middle section |

### Summary Prompt Template

```
You are a conversation summarizer for an AI coding agent platform. Given a
conversation between a user and a coding agent, produce a structured context
summary that will help a NEW agent instance continue the work.

The new agent has NO memory of this conversation. It needs to understand:
1. What was the original task/goal?
2. What files were discussed or modified?
3. What key decisions were made?
4. What is the current state of the work?
5. What remains to be done (if anything)?

Rules:
- Focus on ACTIONABLE context, not play-by-play
- List specific file paths mentioned
- Note the git branch name if mentioned
- Prioritize the most recent state over historical progression
- Maximum {maxLength} characters
- Output in markdown with clear section headers

Conversation:
{messages}
```

### Fallback (No AI)

If Workers AI is unavailable or times out:

1. Take the last 10 user+assistant messages
2. Prepend: "Previous session context (extracted from conversation history):"
3. Include task metadata: title, description, output_branch, output_pr_url
4. Concatenate messages with role labels: `User: ...`, `Agent: ...`
5. Truncate to 64KB (the `contextSummary` API limit)

This is less polished but gives the new agent something to work with.

## Implementation Approach

### Phase 1: Message Summarization Service

Create `apps/api/src/services/message-summarization.ts` following the `task-title.ts` pattern:

```typescript
// Pseudocode
export async function summarizeSessionMessages(
  env: Env,
  projectId: string,
  sessionId: string,
  options?: { maxMessages?: number; maxLength?: number }
): Promise<string> {
  // 1. Fetch messages from ProjectData DO (filtered by role)
  // 2. Apply chunking strategy based on count
  // 3. Call Workers AI with summary prompt
  // 4. Fall back to heuristic extraction on failure
  // 5. Return structured context summary
}
```

Configuration (following Constitution Principle XI):
- `CONTEXT_SUMMARY_MODEL` — Workers AI model (default: `@cf/meta/llama-3.1-8b-instruct`)
- `CONTEXT_SUMMARY_MAX_LENGTH` — max output chars (default: 4000)
- `CONTEXT_SUMMARY_TIMEOUT_MS` — per-attempt timeout (default: 10000)
- `CONTEXT_SUMMARY_MAX_MESSAGES` — messages to include (default: 50)
- `CONTEXT_SUMMARY_RECENT_WEIGHT` — how many recent messages to always include (default: 20)

### Phase 2: Fork API Enhancement

Add a new endpoint or enhance the existing fork:

```
POST /api/projects/:id/sessions/:sessionId/summarize
→ Returns { summary: string, messageCount: number, filteredCount: number }
```

The fork endpoint continues to accept `contextSummary` from the client. The summarize endpoint is a helper — the client calls it, shows the result for review, then sends to fork.

### Phase 3: UI — "Continue" Button

On completed/stopped sessions in the chat UI:
1. Show a "Continue in new task" button
2. Clicking it calls the summarize endpoint
3. Shows the summary in an editable text area
4. User can modify, then clicks "Submit"
5. This creates a fork + new task with the summary as initial prompt
6. New workspace provisions, checks out the output branch
7. Agent starts with the structured context

### Phase 4 (Future): Agent-Accessible History

Add an MCP tool that lets the new agent browse the parent session:
```
get_parent_session_messages(parentSessionId, options)
→ Returns paginated messages from the forked-from session
```

This lets the agent dig deeper when the summary isn't enough. The agent would see in its instructions: "This task continues from a previous session. Use `get_parent_session_messages` to review the full conversation history if needed."

## Architecture Considerations

### Context Window Degradation in Multi-Fork Chains

If a user forks 5 times, each summary summarizes the previous summary. Information degrades:

```
Session 1: Full conversation (100 messages)
Session 2: Summary of Session 1 (4KB) + new work
Session 3: Summary of Session 2 (which includes summary of 1) + new work
...degrades...
```

**Mitigation options:**
- Always include the *original* task description, not just the parent's summary
- Store `rootSessionId` so the agent can access the original conversation
- Cap fork depth (already at 10) and warn at depth 3+
- Each summary always references the git branch (code is the ground truth)

### Cost & Performance

- Workers AI call: ~2-5s latency, minimal cost per call
- Only happens when user explicitly requests a fork (not on every message)
- Fallback to heuristic extraction avoids blocking the user
- Summary can be cached — if the session is terminal, its messages won't change

### Privacy & Data Scope

- Summaries are generated from data already in the user's project DO
- No data leaves the Cloudflare environment (Workers AI runs on CF infra)
- Summaries are stored as `initialPrompt` — same access controls as regular messages
- Fork lineage is scoped to a project — no cross-project data access

## Comparison with Claude Code's Context Compression

Claude Code (and similar agents) compress context using a technique sometimes called "context window compaction" or "auto-summarization":

1. When the conversation approaches the context limit, the agent summarizes older messages
2. The summary replaces the original messages in the context window
3. Recent messages are kept verbatim
4. The agent continues with summary + recent messages

Our use case is different in a key way: we're not maintaining a *running* agent. We're starting a *new* agent with context from a *dead* session. This means:

- We don't need incremental compression (summarize as you go)
- We do need one-shot summarization (summarize everything at fork time)
- We can afford more latency (fork is a deliberate user action, not a mid-conversation operation)
- We should prioritize structured output over natural prose (the new agent needs facts, not narrative)

## Open Questions

1. **Should the summary include code diffs?** The output branch has the full diff, but a summary of "what changed" (not the literal diff) might help the agent ramp up faster.

2. **Should we support forking from any message, not just the end?** "Continue from message #42" could be useful for branching off from an earlier point in the conversation.

3. **How should branch management work for forks?** Options:
   - Fork creates a new branch from the parent's output branch
   - Fork continues on the same branch
   - Fork branches from main (if the parent's PR was already merged)

4. **Should there be a "quick fork" that skips summarization?** For simple cases like "just keep going on the same branch," a fork with minimal context (just the task title and branch name) might be enough.

5. **Should summarization be async?** For very long sessions, AI summarization could take 10+ seconds. Could show a placeholder and fill in the summary when ready.

6. **Can we leverage `output_summary` from task completion?** Tasks already have an `output_summary` field. If agents populate it reliably, we could use it as the primary context and only fall back to message summarization when it's missing.

## Recommendation

Start with **Phase 1 + Phase 3** (message summarization service + UI "Continue" button). This delivers the core user value — continuing work after a workspace is gone — with a relatively modest implementation effort.

Phase 2 (separate summarize endpoint) can be deferred if we generate the summary inline during the fork flow.

Phase 4 (MCP-accessible history) is a nice-to-have that becomes more valuable as fork chains get longer.

The key insight is that **the code is always the ground truth**. The git branch and its diff provide authoritative context about what changed. The conversation summary provides *intent* context — why changes were made, what the user wants next. Both are needed, but the code context is more reliable and should be prioritized.
