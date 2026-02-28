# Post-Mortem: Missing Initial Prompt Delivery in Task Execution

**Date**: 2026-02-28
**Author**: Claude (analysis session)
**Severity**: Critical — the core feature (autonomous task execution) does not work
**Status**: Root cause identified, fix not yet implemented

---

## What Happened

On 2026-02-28, the first real test of the newly merged Task Durability Framework (TDF-3 through TDF-8, PR #219) was performed. A task was submitted through the project chat UI. The system successfully:

1. Created a task and chat session
2. Selected/provisioned a node (01KJFPKGX98AKD70ES2YGQA66W)
3. Created a workspace (01KJJ85T4YT43DYDB6M4K0VZ29)
4. Received the workspace-ready callback
5. Created an agent session on the VM agent
6. Transitioned the task to `in_progress`

**But Claude Code never received the task description and never started working.** The workspace sat idle. When the user manually opened the workspace ~33 minutes later, they found an ACP session with no initial prompt — Claude Code was waiting for its first message, which never came.

---

## Root Cause

There is no code path that delivers the task description to Claude Code after the workspace is provisioned.

The TaskRunner DO's `agent_session` step calls `createAgentSessionOnNode()`, which POSTs to the VM agent's `handleCreateAgentSession()` endpoint. This endpoint **only registers the session in memory** — it does not start Claude Code, does not create a SessionHost, and does not send any prompt.

Claude Code is only started when a **browser WebSocket viewer** connects to `/workspaces/:id/agent` on the VM agent, which triggers `getOrCreateSessionHost()` -> `SelectAgent()` -> `startAgent()`. Even then, the initial prompt must be sent as a `session/prompt` JSON-RPC message from the WebSocket client.

In other words: the entire task execution pipeline is a bridge to nowhere. It does everything needed to prepare the workspace, then stops one step short of actually telling the agent what to do.

---

## How We Missed This

This section traces the gap through every layer of our planning, specification, and review process to identify the systemic causes.

### 1. The Original Spec (021) Described the Outcome, Not the Mechanism

Spec 021 (Task-Chat Architecture) is the foundational feature specification. It correctly states the desired behavior:

> **FR-008**: "Each task MUST be linked to exactly one chat session upon creation. The task's description becomes the first user-role message in that session."

> **US2 Acceptance Scenario 2**: "Given a task is running and the workspace is provisioning, When the user watches the project page, Then they see status updates... then messages flowing in as the agent works."

But the spec never describes **how** the task description reaches the agent process. It specifies that the task description "becomes the first user-role message" (persistence into the ProjectData DO) and that messages should "flow in as the agent works" (VM agent -> control plane -> browser). It does not specify the reverse: control plane -> VM agent -> Claude Code.

The spec's assumptions section says:

> "The existing task runner orchestration (node selection, workspace creation, agent session startup, completion callbacks) is functional and can be extended rather than rewritten."

This assumption was wrong. The pre-TDF task runner had the same gap — `executeTaskRun()` created an agent session on the VM but never sent an initial prompt either. **The feature never worked end-to-end.** The spec assumed it did and built on top of a broken foundation.

### 2. The Pre-TDF System Analysis Documented the Gap Without Recognizing It

The Task Delegation System Analysis (`docs/notes/task-delegation-system-analysis.md`) was written as a deep-dive into a stuck-task failure. Section 2.3 ("Async Execution: What Happens Inside executeTaskRun") describes the execution steps:

> **Stage 3 — Agent Session**
> 1. Create agent session record (`status: running`)
> 2. Call VM agent `POST /workspaces/:id/agent-sessions` to start ACP session
> 3. Transition task: `delegated → in_progress`
>
> At this point the task runner is done. The agent runs autonomously.

The phrase "Call VM agent POST /workspaces/:id/agent-sessions to **start ACP session**" contains the assumption: that creating the agent session record on the VM agent also starts the ACP session. It does not. The `handleCreateAgentSession()` endpoint only registers the session in the agent sessions manager. The ACP process is started later, by a browser WebSocket connection.

The analysis then says "the agent runs autonomously" — but it cannot run if it was never started.

### 3. The Flow Map Stated the Desired Behavior as If It Were Implemented

The Task Delegation Flow Map (`docs/task-delegation-flow-map.md`) is the most complete system documentation. In Phase 3 (VM Execution), it describes:

```
VM Agent receives POST /workspaces/:id/agent-sessions:
    |
    |-- Start ACP (Agent Communication Protocol) session
    |-- Task description is the initial prompt
    |-- Agent (Claude Code) executes autonomously
```

This is aspirational, not actual. The VM agent's `handleCreateAgentSession()` does not "start an ACP session" and does not use the "task description as the initial prompt." The flow map was written as a design document describing the intended system, but was treated as a description of the existing system. Nobody verified these three lines against the actual code.

### 4. The Task Execution UX Document Repeated the Assumption

The Task Execution UX Current State document (`docs/notes/task-execution-ux-current-state.md`) Section 2.3 says:

> **Stage 3 — Agent Session (task-runner.ts:267-300)**
> 1. Create agent session record (`status: running`)
> 2. Call VM agent `POST /workspaces/:id/agent-sessions` to start ACP session
> 3. Transition task: `delegated → in_progress`

This repeats the exact same assumption. And in its gap analysis (Section 4), the document identifies six gaps — workspace warm period, git push, follow-up messages, etc. — but **does not identify "initial prompt delivery" as a gap**. It lists "Agent session creation" in the "Working" column of the summary table:

> | Agent session creation | Working | None |

It was never working.

### 5. TDF-2 (Orchestration Engine) Ported the Bug Faithfully

TDF-2 was the critical architectural migration from `waitUntil()` to Durable Objects. Its task file explicitly says:

> "Read all research references below before starting."

The agent read the flow map and system analysis (which contained the wrong assumption) and faithfully ported the broken flow into the new DO-based architecture. The TDF-2 spec's step table describes:

> | `agent_session` | HTTP POST to VM agent | ~1s | Persist session creation |

No mention of sending the task description. The data model (`specs/tdf-2-orchestration-engine/data-model.md`) stores `taskDescription` in `TaskRunConfig`, proving the data is available — but no step handler ever uses it to send a prompt to the agent.

The TDF-2 specification's step state machine ends at:

```
agent_session --> running : Session created + in_progress
running --> [*] : Agent handles from here
```

"Agent handles from here" — but the agent was never given anything to handle.

### 6. TDF-4 (VM Agent Contract) Formalized the Wrong Interface

TDF-4's purpose was to formalize the HTTP contract between the control plane and VM agent. Its task file lists the endpoints to formalize:

> | `/workspaces/:id/agent-sessions` | POST | Start agent session | `server.go` |

The description says "Start agent session" — but the endpoint doesn't start an agent session in the ACP sense. It registers a session record. TDF-4 created Zod schemas for request/response payloads and contract tests, but the schemas matched what the code already did (register a session), not what the system needed (start an agent with an initial prompt).

The TDF-4 acceptance criteria include:

> - [ ] Documented API contract for every endpoint between control plane and VM agent
> - [ ] Shared JSON schemas or type definitions for all request/response payloads
> - [ ] Contract tests on TypeScript side: client sends payloads matching the schema
> - [ ] Contract tests on Go side: server parses requests and returns responses matching the schema

All of these were met — the schemas accurately describe what the code does. But nobody asked: "does what the code does match what the system needs?"

The `createAgentSessionOnNode()` function sends `{ sessionId, label }`. The Go handler receives `{ sessionId, label }`. The contract tests verify this roundtrip. Everything is consistent. And wrong.

### 7. TDF-5 Through TDF-8 Built on the Foundation Without Questioning It

- **TDF-5** (Workspace Lifecycle) replaced D1 polling with callback-driven advancement for workspace readiness. It improved the `workspace_ready` -> `agent_session` transition but never questioned what `agent_session` actually does on the VM.

- **TDF-6** (Chat Session Management) fixed duplicate session creation and session linking. It ensured the chat session is created at submit time and linked to the workspace. But the chat session stores the task description as a user message for the **browser UI** — it's never read back and sent to the agent.

- **TDF-7** (Recovery & Resilience) added observability, diagnostic context, and orphan detection. It can detect and report failures, but cannot detect the absence of a feature that was never implemented.

- **TDF-8** (Frontend State Tracking) added provisioning progress bars, WebSocket reconnection, and idle timers. It polishes the UI for watching a task execute — a task that will never actually execute because the agent never receives the prompt.

### 8. No Human Review on Any TDF PR

All six TDF PRs (#213-#218) and the integration PR (#219) were reviewed exclusively by CodeRabbit (automated). CodeRabbit provided valuable feedback on code quality — label nullability mismatches, potential panics in retry logic, missing lint fixes — but it cannot verify that a system achieves its intended purpose. It reviews what the code does, not whether what the code does is correct for the product.

No human reviewer looked at the PRs. No human asked: "after the agent session is created, how does the task description get to Claude Code?"

### 9. No End-to-End Test of the Happy Path

The TDF series added 828 tests across all packages. These include:
- Unit tests for each DO step handler
- Contract tests for API payloads
- Integration tests for session linking and workspace readiness
- Frontend tests for provisioning progress display

None of them test the actual happy path end-to-end: **submit a task -> agent receives the task description -> agent produces output**. The tests verify each step in isolation and verify the transitions between steps. But the final step — "the agent actually receives the prompt and works" — was never tested because it was assumed to already work.

---

## Systemic Causes

### Cause 1: Documentation-as-Specification

The flow map, system analysis, and UX current-state documents were written as analysis of the existing system but contained aspirational statements ("Task description is the initial prompt") mixed with factual descriptions. Downstream work treated these documents as ground truth. Nobody verified the aspirational claims against the running code.

**Pattern**: When a document says "X happens" without citing the specific code path, "X happens" may be a design intent, not an implementation fact.

### Cause 2: Incremental Decomposition Lost the End-to-End View

The TDF series decomposed the task execution system into 8 focused tasks, each with clear scope and acceptance criteria. This decomposition was necessary for tractability but it orphaned the cross-cutting concern of "how does the task description travel from the user to the agent?" Each task assumed this was someone else's responsibility:

- TDF-2 (orchestration): "I create the agent session; the VM agent handles the rest"
- TDF-4 (VM contract): "I formalize what the endpoints already do"
- TDF-6 (chat sessions): "I persist the task message for the browser; the agent gets it elsewhere"
- TDF-8 (frontend): "I display messages; the backend delivers the prompt"

Nobody owned the complete path: user input -> D1 task record -> TaskRunner DO -> VM agent -> Claude Code process -> initial ACP prompt.

### Cause 3: Testing Verified Components, Not Capabilities

828 tests verify that individual components behave correctly: the DO advances through steps, the VM agent registers sessions, the frontend displays progress. But no test verifies the system-level capability: "a submitted task results in an agent working on that task." Component testing is necessary but not sufficient. The gap between "all components work" and "the system works" is where this bug lived.

### Cause 4: The Agent Session API Was Named Misleadingly

The endpoint `POST /workspaces/:id/agent-sessions` and the function `createAgentSessionOnNode()` suggest they "create an agent session" — which, to someone reading the orchestration code, sounds like "start the agent." In reality, they register a session record. The actual agent startup happens via a completely different code path (WebSocket viewer attachment). The naming created a false sense that the step was complete.

### Cause 5: No Automated Reviewer Could Catch This

CodeRabbit reviews code correctness within files and across a diff. It cannot determine that a system-level feature is unimplemented when every individual component is correctly coded. This type of gap — a missing integration between correctly-working components — requires either:
- A human reviewer who understands the full system intent
- An end-to-end integration test that exercises the complete flow
- A specification checklist that maps each acceptance criterion to a test

None of these were present.

---

## What Should Have Caught This

1. **A single end-to-end test**: `submitTask("Fix the bug") -> wait -> assertAgentReceivedPrompt("Fix the bug")`. This test would have failed immediately.

2. **Manual testing before merge**: Running the task submission flow once on staging would have revealed that the agent never starts working. The TDF PRs were merged without manual testing of the happy path.

3. **A specification review that traced data flow**: If someone had traced the task description from `task-submit.ts` (where the user types it) through every system until it reaches Claude Code's stdin, they would have found the gap at the VM agent boundary.

4. **The flow map verification step**: The flow map says "Task description is the initial prompt." If there had been a verification step that matched each flow map assertion to a code path, this line would have been flagged as unimplemented.

5. **A human PR reviewer asking "but how does the agent know what to do?"**: This single question, asked during review of TDF-2 or the integration PR, would have surfaced the gap.

---

## Proposed Fix

Add a new VM agent endpoint (option 3 from the initial analysis):

```
POST /workspaces/:id/agent-sessions/:sessionId/start
{
  "agentType": "claude",
  "initialPrompt": "Fix the login timeout bug in auth.ts"
}
```

This endpoint would:
1. Create a SessionHost for the session (currently only happens on WebSocket viewer attach)
2. Call `SelectAgent()` to start Claude Code
3. Send the initial prompt via `HandlePrompt()` — a server-initiated prompt, not browser-initiated

The TaskRunner DO's `handleAgentSession()` step would call this new endpoint after creating the agent session, passing `state.config.taskDescription` as the initial prompt.

This keeps the intelligence in the VM agent (no long-lived WebSocket from the Cloudflare Worker) and makes the agent session creation endpoint do what its name has always implied: actually start the agent.

---

## Lessons for Future Work

1. **Verify documentation claims against code before building on them.** If a document says "X happens," find the function that does X. If you can't find it, the document is wrong.

2. **Every feature needs at least one end-to-end test of the happy path.** Component tests prove components work. Only E2E tests prove the system works.

3. **When decomposing work, explicitly assign ownership of cross-cutting concerns.** Create a checklist item: "Who sends the task description to the agent?" and assign it to a specific task.

4. **Name endpoints and functions for what they actually do, not what you wish they did.** `registerAgentSession()` would have made the gap obvious. `createAgentSession()` hid it.

5. **Human review is not optional for system-level changes.** Automated reviewers catch code bugs. Humans catch design gaps.

6. **Test the deployed feature before considering it done.** The PR template and quality gates require testing, but the integration PR was merged without a manual test of the core flow.
