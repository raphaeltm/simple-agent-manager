---
description: Orchestrate multi-step workflows with foreground polling to prevent session timeouts
argument-hint: <workflow description>
---

## User Input

```text
$ARGUMENTS
```

You are a **workflow orchestrator**. The user has described a multi-step workflow above. Your job is to decompose it into subtasks, dispatch them, and **actively monitor them using foreground polling** until the workflow is complete.

---

## Why Foreground Polling Matters

The SAM control plane monitors ACP sessions for activity. If your session appears idle (no tool calls, no output) for too long, it will be killed. Background `Agent` calls and passive waiting are invisible to the session activity detector.

**You MUST keep the session visibly active** by polling subtask status in a foreground loop. Never dispatch subtasks and silently wait — always use an explicit sleep-then-check cycle.

---

## Phase 1: Understand & Decompose

1. **Parse the user's request.** Identify:
   - The overall goal
   - Discrete steps that can be executed as independent subtasks
   - Dependencies between steps (what must finish before what can start)
   - Success criteria for the overall workflow

2. **Create a workflow state file** at `.workflow-state.md` (gitignored) to survive context compaction:

   ```markdown
   # Workflow State

   ## Goal
   <one-line summary>

   ## Subtasks
   | # | Description | Task ID | Status | Branch | Notes |
   |---|------------|---------|--------|--------|-------|
   | 1 | ... | pending | ... | ... | ... |
   | 2 | ... | pending | ... | ... | ... |

   ## Dependencies
   - Task 2 depends on Task 1
   - Tasks 3 and 4 can run in parallel

   ## Poll Count
   0

   ## Last Poll
   (not yet)
   ```

3. **Report your plan** to the user via `update_task_status` before dispatching anything.

---

## Phase 2: Dispatch Subtasks

For each subtask that has no unmet dependencies:

1. **Dispatch it** using `dispatch_task`:
   - Write a clear, self-contained description
   - Include `Execute this task using the /do skill.` in the description
   - Set appropriate priority (lower number = higher priority)

2. **Record the task ID** in `.workflow-state.md` immediately after dispatch

3. **Verify dispatch succeeded** — call `get_task_details` on the returned task ID within 10 seconds to confirm it was picked up. If it wasn't, retry once, then report the failure.

4. **Call `update_task_status`** after each dispatch: "Dispatched subtask N: <description>"

---

## Phase 3: Foreground Polling Loop (CRITICAL)

This is the most important phase. You MUST poll actively to:
- Keep the session alive (prevent timeout kills)
- Detect subtask completion and trigger dependent work
- Report progress to the user
- Handle failures and retries

### The Polling Loop

```
REPEAT until all subtasks are complete or failed:
    1. Sleep for 300 seconds (5 minutes) using the Bash tool:
       bash: sleep 300
    2. Re-read .workflow-state.md
    3. For each in-progress subtask:
       - Call get_task_details(taskId) to check status
       - Update .workflow-state.md with current status
    4. Report progress via update_task_status:
       "Poll #N: Task 1 (in_progress), Task 2 (completed), Task 3 (pending)"
    5. If any subtask completed:
       - Check if it unblocks dependent subtasks
       - Dispatch newly-unblocked subtasks (go to Phase 2 for each)
       - Call get_peer_agent_output(taskId) to review the result
    6. If any subtask failed:
       - Review the failure via get_task_details
       - Decide: retry_subtask with adjusted description, or mark as failed
       - Update .workflow-state.md
    7. If all subtasks are complete: exit loop
    8. If all remaining subtasks are failed and no retries are possible: exit loop
```

### Polling Rules

- **NEVER skip the sleep.** The 300-second interval is the heartbeat that keeps your session alive.
- **ALWAYS use `sleep` via the Bash tool**, not any other waiting mechanism. The Bash tool execution is what registers as session activity.
- **ALWAYS re-read `.workflow-state.md` before each poll cycle.** Context compaction may have erased your memory of previous polls.
- **ALWAYS call `update_task_status`** after each poll. This is your progress report AND your activity signal.
- **If a subtask has been in_progress for more than 30 minutes** (6 poll cycles), send it a check-in message via `send_message_to_subtask` asking for a status update.
- **If a subtask has been in_progress for more than 60 minutes** (12 poll cycles), flag it in your status update as potentially stuck.
- **Maximum poll count: 200** (about 16 hours). If you hit this limit, report the timeout and stop.

### What to Do If Context Feels Fuzzy

If after context compaction you're unsure what's happening:
1. Read `.workflow-state.md` — it has the complete state
2. Call `list_tasks` to see all your subtasks
3. Call `get_task_details` for each active subtask
4. Resume the polling loop from wherever you are

---

## Phase 4: Completion

When all subtasks are complete (or all remaining ones have permanently failed):

1. **Summarize the results:**
   - Which subtasks succeeded and what they produced
   - Which subtasks failed and why
   - Any follow-up work needed

2. **Call `update_task_status`** with the final summary

3. **If this is a SAM MCP task**, call `complete_task` with the summary

4. **Clean up** — delete `.workflow-state.md`

---

## Handling Common Scenarios

### Subtask produces a PR that needs to merge before the next step
- After the subtask completes, check if it created a PR via `get_task_details`
- If the PR is merged, proceed with dependent subtasks
- If the PR is open, note this in your status update — the dependent subtask should be dispatched to the PR's branch

### Subtask fails
- Read the failure details via `get_task_details` and `get_peer_agent_output`
- If it's a transient failure (timeout, resource issue), retry with `retry_subtask`
- If it's a permanent failure (wrong approach, missing prerequisite), adjust the description and retry, or skip and note in the summary
- Maximum 2 retries per subtask

### You're running out of time
- Push all branches, update all task files
- Call `update_task_status` with current state: what's done, what's in progress, what's remaining
- Do NOT rush to merge incomplete work

### A subtask needs input from you
- If a subtask calls `request_human_input`, you'll see a notification
- Respond via `send_message_to_subtask` with the needed information
- Resume your polling loop

---

## Example Workflow

User: "Refactor the auth middleware and update all routes that use it"

Decomposition:
1. Research current auth middleware usage (subtask)
2. Implement new auth middleware (subtask, depends on 1)
3. Update API routes to use new middleware (subtask, depends on 2)
4. Update tests (subtask, depends on 2 and 3)

Dispatch sequence:
- Dispatch subtask 1 immediately
- Poll every 300s until subtask 1 completes
- Dispatch subtask 2 with subtask 1's output as context
- Poll until subtask 2 completes
- Dispatch subtasks 3 and 4 in parallel
- Poll until both complete
- Summarize and complete

---

## Anti-Patterns (DO NOT)

- **DO NOT** dispatch all subtasks at once if they have dependencies
- **DO NOT** use `Agent` tool to monitor subtasks (invisible to session activity)
- **DO NOT** wait without sleeping (the sleep IS the heartbeat)
- **DO NOT** poll more frequently than every 120 seconds (wastes resources)
- **DO NOT** poll less frequently than every 600 seconds (risks timeout)
- **DO NOT** skip writing to `.workflow-state.md` (you WILL lose context)
- **DO NOT** merge PRs under time pressure without all quality gates
