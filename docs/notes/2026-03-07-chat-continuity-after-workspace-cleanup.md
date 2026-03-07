# Chat Continuity After Workspace Cleanup

**Date**: 2026-03-07
**Status**: Design exploration (not a spec)

## Problem

When a workspace associated with a project chat session is cleaned up (node destroyed, idle timeout, task completion), the user loses the ability to continue the conversation. The chat history is preserved in the ProjectData DO, but the 409 response from `POST /:sessionId/prompt` (`apps/api/src/routes/chat.ts:235`) blocks further interaction: *"The workspace node is no longer running. Start a new chat to create a fresh workspace."*

This is frustrating because:
- The user may want to iterate on the agent's work (fix a bug it introduced, extend a feature)
- The git branch and PR exist — the code context is recoverable
- Starting a "new chat" loses conversational context and forces the user to re-explain what they want
- The 15-minute idle timeout (`SESSION_IDLE_TIMEOUT_MINUTES`) is aggressive for async workflows

## Hard Constraint: Node Destruction Is the Common Case

The most common cleanup path is full node destruction — the Hetzner server is deleted via API, and **everything on the VM is permanently gone**. This is not an edge case; it's the normal lifecycle:

- Task completes → workspace stopped → node enters warm pool → warm timeout expires → cron sweep calls `deleteNodeResources()` → Hetzner server deleted
- Manual node delete → `deleteNodeResources()` → gone
- Max lifetime exceeded → cron sweep → gone

**All continuation approaches must assume the node no longer exists.** The only data that survives is what lives in Cloudflare infrastructure (DO SQLite, D1, KV) and what was pushed to GitHub before cleanup. There is no VM to wake up, no Docker container to restart, no volume to mount.

This means every continuation path requires **full re-provisioning from scratch**: new node (or warm pool claim) → new workspace → fresh `git clone` → checkout of the output branch (if it exists on the remote). The only context available to the new agent is what we can reconstruct from the DO chat history and D1 task metadata.

## Current State

### What survives (in Cloudflare + GitHub — always available)
- **Chat messages** — all messages (user, assistant, tool, system) in ProjectData DO SQLite (`chat_messages` table)
- **Task metadata** — title, description, status, `output_branch`, `output_pr_url`, `output_summary` in D1 (`tasks` table)
- **Git code** — anything pushed to the remote before cleanup (agent pushes on completion via `workspace_callbacks.go`)

### What is lost (on the VM — gone when node is destroyed)
- **VM state** — Docker container, volume, working tree, uncommitted changes
- **Agent process** — the Claude Code / Codex subprocess and its in-memory conversation context
- **ACP session** — the `AcpSessionID` in the SessionHost is gone with the VM
- **Unsent messages** — anything in the VM SQLite outbox that wasn't flushed
- **Local tool state** — any files the agent created outside the git repo (temp files, caches, logs)

### Key architectural facts
- Chat sessions are **per-project DO**, not per-workspace. The workspace link (`chat_sessions.workspace_id`) is a mutable foreign key.
- `linkSessionToWorkspace()` (`project-data.ts:357`) already supports re-linking a session to a different workspace (used for warm node pooling).
- The warm node pool's `tryClaim()` / `markActive()` flow already handles attaching new workspaces to existing infrastructure.
- The `MessageReporter.SetSessionID()` (`messagereport/reporter.go:141`) already handles session ID changes on warm nodes, including clearing stale outbox entries.

---

## Approaches

### Approach A: "Resume Session" — Re-provision and re-attach

**Concept**: Add a "Resume" action on stopped sessions that provisions a new workspace (or claims a warm node), checks out the output branch, and re-links the existing session to the new workspace. The new agent gets the conversation history injected as context.

**How it would work**:
1. User clicks "Resume" on a stopped chat session
2. API creates a new task linked to the same `sessionId` (or a continuation task referencing the parent)
3. TaskRunner provisions a workspace, checks out `output_branch` from the previous task
4. `linkSessionToWorkspace()` re-links the session to the new workspace
5. New agent session starts with a system prompt containing: previous conversation summary + user's new message
6. Messages append to the same `chat_messages` stream

**Pros**:
- Seamless UX — conversation appears continuous
- Git state is recovered (output branch)
- Reuses existing warm pool infrastructure
- `linkSessionToWorkspace()` already exists

**Cons**:
- The new Claude Code instance has **zero memory** of the previous conversation. Injecting chat history as a system prompt is lossy (token limits, no tool call context, no internal reasoning).
- If the previous session had 100+ messages, summarization is required — and summarization can lose critical details.
- The session state machine (`active` → `stopped`) needs a new transition (`stopped` → `active`), which complicates the lifecycle.
- Two tasks pointing at the same session creates ambiguity in task tracking.

**Complexity**: Medium-high. The infrastructure pieces exist, but agent context injection and session lifecycle changes are non-trivial.

---

### Approach B: "Continue as New" — New session with history context

**Concept**: Start a fresh chat session, but pre-populate it with a system message summarizing the previous session. The new workspace checks out the previous output branch. The UI links the two sessions visually.

**How it would work**:
1. User clicks "Continue" on a stopped session
2. API creates a new session and a new task
3. The new task's `initial_prompt` includes: a summary of the prior conversation + the user's new instruction
4. The workspace is provisioned on the output branch of the previous task
5. The new session has a `parent_session_id` field linking back to the original
6. UI shows a "Continued from [previous session]" indicator with a link

**Pros**:
- Clean session boundaries — no lifecycle state machine changes
- Task tracking remains 1:1 (one task per session)
- The agent gets context via its normal prompt interface (no special injection path)
- UI can show session chains: Session 1 → Session 2 → Session 3
- Failed continuations don't corrupt the original session

**Cons**:
- User sees a "new" session, which may feel like a break in flow
- Still relies on summarization for context (same lossy problem as Approach A)
- Need to add `parent_session_id` to the DO schema and wire up the UI linkage
- Branch management: does the continuation create a new branch or work on the same one?

**Complexity**: Medium. Mostly additive changes — new field on sessions, new UI affordance, prompt construction logic.

---

### Approach C: "Follow-up prompt with auto-provision"

**Concept**: The chat input stays enabled even after the workspace is cleaned up. When the user types a follow-up, the system transparently provisions a new workspace (or grabs a warm node), checks out the output branch, and delivers the message. The user experience is: "I just keep chatting."

**How it would work**:
1. When a session is `stopped` but the user sends a message, the API doesn't return 409
2. Instead, it persists the user message in the DO immediately (so it appears in the chat)
3. Then triggers a new TaskRunner flow: provision workspace → checkout output branch → start agent → deliver the user's message as the initial prompt (with prior conversation summary)
4. The provisioning indicator appears inline in the chat (same as initial task submission)
5. Once the agent is running, messages flow through the same session

**Pros**:
- Best UX — the chat never "breaks", it just has a delay while provisioning
- No new UI patterns — reuses the existing provisioning indicator
- Users don't need to understand session lifecycle at all
- Natural mental model: "I'm chatting with an agent about my project"

**Cons**:
- Most complex implementation — the `POST /:sessionId/prompt` endpoint needs to handle the "no workspace, need to provision" case, which is currently the TaskRunner's job
- Race conditions: what if the user sends multiple messages before provisioning completes?
- The workspace link changes mid-session, which may confuse the ACP WebSocket reconnection logic in `useProjectAgentSession`
- Agent context is still lossy (same summarization problem)
- Cost: every follow-up after cleanup spins up a new VM (unless warm pool has one)

**Complexity**: High. Requires significant changes to the prompt endpoint, provisioning flow, and frontend state management.

---

### Approach D: "Extended warm period with wake-on-message"

> **Note**: This approach only helps during the warm window. Once the node is destroyed (the common case), it provides no benefit. It is a complementary optimization, not a standalone solution — any design must still handle the "node is gone" case via one of the other approaches.

**Concept**: Instead of destroying workspaces aggressively, keep the VM alive longer (or stop the Docker container without deleting the volume). When the user sends a follow-up during the warm window, wake the container and deliver the message. The agent process is gone, but the filesystem state is intact.

**How it would work**:
1. On task completion, stop the Docker container but don't remove it or its volume
2. Extend `NODE_WARM_TIMEOUT_MS` significantly (hours instead of 30 min) or make it user-configurable
3. When a follow-up arrives during the warm window, `docker start` the container, start a new agent session with conversation context
4. If the warm timeout expires, fully destroy — and fall back to another approach (B, C, or E)

**Pros**:
- Filesystem state is fully preserved during the warm window (uncommitted changes, local files, tool state)
- No git checkout needed — the working tree is exactly where the agent left it
- Faster resume than full re-provision (container start vs. VM + devcontainer build)

**Cons**:
- **Only works during the warm window** — once the node is destroyed, this is useless. Requires a fallback path regardless.
- Cost: keeping VMs alive costs money (Hetzner charges for running servers even when idle)
- The Hetzner VM must stay alive for the Docker container to persist — volumes are local, not network-attached
- Conflicts with BYOC model — users pay for idle VMs they're not using
- `NODE_WARM_TIMEOUT_MS` is already user-configurable but applies to the node, not per-workspace

**Complexity**: Low-medium for the "extend warm period" part. High if adding Docker stop/start lifecycle (currently not supported — workspace stop closes sessions but doesn't stop the container).

---

### Approach E: "Exportable conversation context"

**Concept**: Don't try to make the system seamlessly resume. Instead, make it trivially easy to start a new chat with the right context by offering a "Copy context" or "Use as template" action that pre-fills a new chat with the previous session's output branch and a conversation summary.

**How it would work**:
1. Stopped sessions show a "Start follow-up" button
2. Clicking it opens the new chat input pre-filled with:
   - Auto-selected branch: the `output_branch` from the completed task
   - A system-generated summary: "Previous session worked on [topic]. Changes: [output_summary]. Branch: [output_branch]. PR: [output_pr_url]."
3. User edits/extends the pre-filled message and submits
4. New task/session is created normally

**Pros**:
- Simplest implementation — almost entirely frontend
- User has full control over what context carries forward
- No session lifecycle changes, no re-linking, no special provisioning
- Works even if the output branch was force-pushed, rebased, or merged
- The "copy context" pattern is familiar from other tools

**Cons**:
- Least seamless UX — the user explicitly starts a "new" conversation
- Relies on the user to provide good follow-up context
- No automatic conversation history injection (user must reference prior work manually)
- The `output_summary` may not exist or may be low quality

**Complexity**: Low. Frontend changes + minor API additions (endpoint to generate a context summary from a stopped session).

---

## Recommendation

**Start with Approach B ("Continue as New") as the foundation, with Approach E's UX affordances.**

Rationale:
- Clean session boundaries avoid lifecycle complexity
- `parent_session_id` creates a navigable session chain
- The "Continue" button on stopped sessions is intuitive
- Pre-filling the new chat with branch + summary context is low-risk
- This can later be upgraded to Approach C's seamless auto-provision if the UX proves too clunky

**The agent context problem is shared across all approaches** — no approach fully solves it because the Claude Code process is gone. The best mitigation is:
1. Always include the conversation history (or a summary) in the new agent's initial prompt
2. Check out the output branch so the agent can read the code diff as context
3. Accept that the new agent instance is a "fresh start with good notes", not a true session resume

**Approach D (extended warm) is worth exploring independently** as a cost-vs-convenience knob. Users who want faster follow-ups can increase `NODE_WARM_TIMEOUT_MS`. But it doesn't eliminate the need for a post-cleanup continuation path.

---

## Open Questions

1. **Branch management for continuations**: Should the continuation work on the same branch, or create a new one? Same branch is simpler but risks conflicts if the original PR was merged.
2. **Summarization strategy**: How do we generate a useful summary of a 100+ message session? Use the task's `output_summary` (generated by the agent on completion)? Use an LLM to summarize the chat history? Both?
3. **Multi-hop chains**: If a user continues 5 times, the context window fills with summaries-of-summaries. How do we prevent context degradation?
4. **Cost model**: Should auto-provisioning for follow-ups use the same VM size as the original task, or allow the user to pick?
5. **Merged PR handling**: If the output branch was already merged to main, should the continuation branch off main instead?
