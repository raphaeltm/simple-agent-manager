# Task Completion Lifecycle

## Problem Statement

Tasks submitted through the project chat page remain in `in_progress` status with `executionStep: 'awaiting_followup'` indefinitely after the agent finishes work. There is no mechanism — manual or automatic — to reliably transition tasks to `completed` status.

The only existing completion path is the **idle cleanup timer** (15-minute DO alarm in `project-data.ts:644-724`), which auto-completes the task if the user doesn't send a follow-up message. This is a cleanup safety net, not an intentional completion signal. Users who actively monitor their tasks see them stuck as "active" with no way to mark them done.

### Current Flow (End-to-End)

```
User submits task in ProjectChat.tsx:handleSubmit()
  → POST /api/projects/:id/tasks/submit (task-submit.ts)
  → Task created in D1: status='queued', executionStep='node_selection'
  → TaskRunner DO started (task-runner.ts)

TaskRunner DO alarm loop:
  1. node_selection  → find/claim/provision node
  2. node_provisioning → create Hetzner VM (if needed)
  3. node_agent_ready → poll VM agent health
  4. workspace_creation → create workspace + link chat session
  5. workspace_ready → wait for VM agent callback
  6. agent_session → create ACP session, send initial prompt
  → Task: status='in_progress', executionStep='running'
  → TaskRunner DO exits (state.completed=true)

Agent executes autonomously:
  → VM agent persists messages to ProjectData DO
  → Agent finishes work

Agent completion (server.go:602-793):
  → git add + commit + push (gitPushWorkspaceChanges)
  → Create PR via gh CLI (tryCreatePR, best-effort)
  → POST callback: executionStep='awaiting_followup' + gitPushResult

Control plane processes callback (tasks.ts:643-834):
  → Task: executionStep='awaiting_followup', finalizedAt=now
  → Session: agentCompletedAt=now (markAgentCompleted)
  → Schedule idle cleanup: 15-min DO alarm

   ┌─────────────────────────────────┐
   │  ** THE GAP **                  │
   │  Task stays in_progress with    │
   │  executionStep=awaiting_followup│
   │  until idle timer fires (15min) │
   │  or user sends follow-up msg    │
   │  (which resets the timer)       │
   └─────────────────────────────────┘

Idle cleanup fires (project-data.ts:644-724):
  → Session stopped, task marked 'completed', workspace stopped
  → This is a CLEANUP mechanism, not a COMPLETION signal
```

### Why This Matters

1. **Dashboard shows stale active tasks** — The active tasks grid (`ActiveTaskCard.tsx`, dashboard) shows tasks that are functionally done but stuck in `in_progress`.
2. **No user agency** — Users cannot manually mark a task as completed from the chat view.
3. **Ambiguous state** — `awaiting_followup` is semantically "the agent is done, waiting for you" but the task status is still `in_progress`. This confuses users who see their task as "active" when the work is finished.
4. **No machine completion** — Even when a PR is merged (the natural endpoint of a coding task), nothing transitions the task.

## Research Findings

### Current Codebase Architecture

**Task state machine** (`packages/shared/src/types.ts:367-375`):
```
draft → ready → queued → delegated → in_progress → completed | failed | cancelled
```

**Execution steps** (`packages/shared/src/types.ts:381-390`):
```
node_selection → node_provisioning → node_agent_ready →
workspace_creation → workspace_ready → agent_session →
running → awaiting_followup
```

**Key files involved**:

| Component | File | Purpose |
|-----------|------|---------|
| Task submit | `apps/api/src/routes/task-submit.ts` | Creates task, session, starts TaskRunner DO |
| Task status callback | `apps/api/src/routes/tasks.ts:643-834` | Receives agent completion signal |
| TaskRunner DO | `apps/api/src/durable-objects/task-runner.ts` | Alarm-driven orchestration |
| ProjectData DO | `apps/api/src/durable-objects/project-data.ts` | Idle cleanup timer (579-724) |
| Branch naming | `apps/api/src/services/branch-name.ts` | `sam/{slug}-{taskId}` generation |
| Agent completion | `packages/vm-agent/internal/server/server.go:602-793` | Git push + PR creation + callback |
| Chat UI | `apps/web/src/pages/ProjectChat.tsx` | Task display, no completion control |
| Task status API | `apps/api/src/routes/tasks.ts` | `PUT /:taskId/status` exists for manual transitions |

**GitHub webhook handler** (`apps/api/src/routes/github.ts:178-258`):
- Currently only handles `installation` and `repository` events
- Does NOT handle `pull_request` events (no PR merge detection)
- Webhook signature verified via ENCRYPTION_KEY

**Existing manual status transition API** (`apps/api/src/routes/tasks.ts`):
- `PUT /api/projects/:projectId/tasks/:taskId/status` already exists
- Accepts `{ toStatus: TaskStatus }` body
- Validates ownership and allowed transitions
- No UI wired to this endpoint for completion

### Prior Art Research

#### How Other Coding Agents Handle Completion

**Devin AI** ([agents101](https://devin.ai/agents101)):
- Uses a **confidence scoring system** — assigns self-assessed confidence to each completed task
- Test-driven verification — refuses to mark done until tests pass
- CI/CD integration — uses passing CI checks as a completion signal
- Delivers final result as a PR and awaits human review/merge
- Supports multi-round feedback cycles before final completion

**GitHub Copilot Coding Agent** ([GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)):
- Works entirely within the GitHub issue → PR lifecycle
- Task is "assigned" via GitHub issue, work delivered as PR
- Completion = PR created + security scan passed + CI green
- Tracks lifecycle metrics: PRs created, PRs merged, time to merge
- Human review is the explicit gate — merge = done

**Cursor Agent Mode** ([cursor.com](https://forum.cursor.com/)):
- Interactive feedback loop — agent works, user reviews inline
- No explicit "completion" state — the session ends when the user is satisfied
- Follows up to confirm changes were applied

**Augment Code** ([augmentcode.com](https://www.augmentcode.com/blog/how-we-built-tasklist)):
- Typed task lifecycle: `todo → in_progress → finished | cancelled`
- Tasks are first-class entities with strict lifecycle
- Clear visual states (grey, blue, green) in UI
- Cross-session persistence

**AGENTS.md Standard** ([blakecrosley.com](https://blakecrosley.com/blog/agents-md-patterns)):
- Defines explicit "definition of done" in config files
- "Done" = specific exit codes, not agent self-assessment
- Adopted by 60,000+ projects across Codex, Cursor, Copilot, etc.

#### Workflow Orchestration Patterns

**AWS Step Functions / Durable Task Framework**:
- Event-driven completion — state machine waits for callback, not polling
- Event sourcing — all state transitions logged for replay/audit
- Checkpoint-based persistence — execution resumes from last successful step

**CI/CD Pipeline Patterns** ([Netlify](https://www.netlify.com/blog/guide-to-ci-cd-automation-using-webhooks/)):
- Webhook callbacks for stage completion
- Idempotent processing with event ID deduplication
- `workflow_run` event chaining in GitHub Actions

**GitHub Webhook PR Events** ([GitHub Docs](https://docs.github.com/en/webhooks/webhook-events-and-payloads)):
- `pull_request` event with `action: closed` + `merged: true` detects PR merges
- `X-GitHub-Event` header identifies event type
- `pull_request.head.ref` contains the branch name (can match `sam/...` pattern)

#### General Task Management Patterns

**Multi-signal completion** (common across systems):
1. **Explicit user action** — "Mark as done" button (simplest, most reliable)
2. **Objective criteria met** — all tests pass, CI green, PR merged
3. **Time-based** — no activity for N minutes (current SAM approach)
4. **Agent self-assessment** — agent declares task complete (unreliable alone)
5. **Composite** — combine multiple signals with confidence weighting

**The "false completion" problem** ([arxiv.org](https://arxiv.org/html/2512.12791v1)):
- Agents falsely reporting tasks as complete is the #1 reliability issue
- Success rate degrades after ~35 minutes of continuous work
- Multi-pillar evaluation (LLM + Memory + Tools + Environment) needed
- Runtime behavior monitoring, not just final outcome checking

**Bounded autonomy** ([ema.co](https://www.ema.co/additional-blogs/addition-blogs/agentic-ai-trends-predictions-2025)):
- Checkpoints + escalation paths + human oversight
- Agents pause and route to humans when confidence is low
- Clear stage boundaries act as completion gates

## Proposed Approaches

### Approach A: Manual Completion (Quick Win)

Add a dropdown/button in the chat header bar that lets users mark a task as completed/cancelled.

**Implementation**:
- Add a status dropdown to the chat header (next to session info)
- Wire it to `PUT /api/projects/:projectId/tasks/:taskId/status` with `{ toStatus: 'completed' }`
- Only show when `executionStep === 'awaiting_followup'` (agent is done)
- Optionally prompt for a brief summary

**Pros**: Simple, gives users control, no false positives
**Cons**: Requires manual action, easy to forget, tasks still accumulate if users don't act

**Effort**: Small (1-2 days)

### Approach B: PR Merge Detection via GitHub App Webhook

Subscribe to `pull_request` webhook events and auto-complete tasks when the associated PR is merged.

**Implementation**:
1. Add `pull_request` to GitHub App webhook subscriptions
2. Extend `apps/api/src/routes/github.ts` webhook handler for `pull_request` events
3. When `action === 'closed'` and `merged === true`:
   - Match `pull_request.head.ref` against task `outputBranch` (e.g., `sam/dark-mode-a1b2c3`)
   - If match found, transition task to `completed`
   - Set `completedAt`, `outputPrUrl` from webhook payload
4. Also handle `action === 'closed'` (not merged) — optionally transition to `cancelled`

**Matching strategy**:
- Primary: Exact match on `outputBranch` column in tasks table
- Fallback: Pattern match `sam/.*` branches against task records by project
- The `outputBranch` is already stored on the task record (`task-submit.ts:117-121`)

**Pros**: Natural completion signal (PR merge = work accepted), fully automatic, works for the common case
**Cons**: Only works if agent creates a PR (best-effort today), requires GitHub App permission update, doesn't cover tasks that don't produce PRs

**Effort**: Medium (2-3 days)

### Approach C: Agent Self-Assessment Query

When the agent signals `awaiting_followup`, have the control plane send one final message asking "Is the original task complete? Answer YES or NO" and parse the response.

**Implementation**:
1. After receiving `awaiting_followup` callback, wait N seconds
2. Send a structured prompt to the agent via the existing ACP session
3. Parse the YES/NO response
4. If YES → auto-complete task; if NO → leave as awaiting_followup

**Pros**: Leverages the agent's context about the task, could be accurate
**Cons**: Awkward — becomes part of the visible message chain, agent might be wrong (false completion problem), adds latency, uses API credits, the ACP session might already be closed

**Effort**: Medium (2-3 days), but architecturally awkward

### Approach D: LLM-Based Final Message Analysis

When `agentCompletedAt` is set and control is returned, use a lightweight LLM call to analyze the agent's final messages against the original task description.

**Implementation**:
1. After `awaiting_followup` + 60 seconds of no user interaction:
2. Fetch the original task description and last N agent messages
3. Call a fast/cheap model (e.g., Haiku) with a structured prompt:
   ```
   Given the task: "{task.description}"
   And the agent's final messages: [...]
   Has the task been completed successfully? Answer with JSON: { "completed": boolean, "confidence": number, "reason": string }
   ```
4. If `completed === true && confidence > 0.8` → auto-complete
5. If confidence is low → leave for manual completion

**Pros**: Doesn't pollute the message chain, uses proper evaluation, can incorporate nuance
**Cons**: Additional API cost per task, latency, requires AI binding in worker, confidence threshold tuning, could be wrong

**Effort**: Medium-Large (3-4 days)

### Approach E: Composite Completion (Recommended)

Combine multiple signals into a completion decision, prioritizing user agency while providing smart defaults.

**Implementation**:
1. **Manual override (always available)**: Dropdown in chat header for explicit completion
2. **PR merge auto-complete**: GitHub webhook detects PR merge → auto-complete
3. **Idle cleanup (existing)**: 15-min timer as final safety net
4. **Smart suggestion**: When agent is done (`awaiting_followup`), show a banner: "This task appears complete. [Mark as Done] [Keep Working]"

**Completion priority** (first match wins):
```
1. User explicitly marks complete/cancelled → immediate
2. PR with matching branch merged → auto-complete
3. PR with matching branch closed (not merged) → suggest cancelled
4. User sends follow-up → reset idle timer, keep in_progress
5. Idle timer expires (15 min) → auto-complete (existing behavior)
```

**Workspace spin-down integration**:
- Any completion signal (manual, PR merge, idle) could also trigger workspace stop
- Already partially implemented: idle cleanup stops workspace (`project-data.ts:670`)
- PR merge completion should also stop workspace + return node to warm pool

**Pros**: Layered defense, user always has control, automatic for the common case, graceful degradation
**Cons**: More complex to implement, multiple code paths to test

**Effort**: Large (5-7 days total, but can be phased)

## Implementation Checklist

### Phase 1: Manual Completion (Approach A) — Quick Win
- [ ] Add task status dropdown component to chat header bar
  - Show when `task.executionStep === 'awaiting_followup'`
  - Options: "Mark Complete", "Mark Cancelled"
  - Confirm dialog before action
- [ ] Wire dropdown to `PUT /api/projects/:projectId/tasks/:taskId/status`
- [ ] Update `ProjectChat.tsx` to refetch task status after transition
- [ ] Update active tasks grid on dashboard to reflect completion
- [ ] Add "completion banner" when agent is done: "Task appears complete. [Mark Done] [Keep Working]"
- [ ] Write behavioral tests for the dropdown interaction
- [ ] Write integration test for the status transition flow

### Phase 2: PR Merge Auto-Completion (Approach B)
- [ ] Research GitHub App permission requirements for `pull_request` webhook events
- [ ] Add `pull_request` event subscription to GitHub App manifest
- [ ] Extend `github.ts` webhook handler:
  - Parse `pull_request` event with `action: closed, merged: true`
  - Extract `head.ref` (branch name)
  - Query D1 tasks by `outputBranch` match
  - Transition matching task to `completed`
- [ ] Handle edge cases:
  - PR closed without merge → optionally mark `cancelled`
  - Multiple PRs for same branch → use latest
  - Branch name doesn't match any task → ignore
  - Task already completed → idempotent no-op
- [ ] Trigger workspace cleanup on PR merge completion
- [ ] Write integration tests for webhook processing
- [ ] Write capability test: submit task → agent pushes branch → PR created → PR merged → task auto-completes

### Phase 3: Smart Completion UX (Polish)
- [ ] Show task status badge in chat header (draft/queued/in_progress/completed)
- [ ] Show execution step progress indicator during provisioning
- [ ] Show "Agent finished — PR created" banner with PR link when `outputPrUrl` is set
- [ ] Show completion summary when task transitions to `completed`
- [ ] Auto-refresh dashboard active tasks when task completes
- [ ] Consider: notification when task completes (if user navigated away)

### Phase 4 (Future): LLM-Based Completion Assessment
- [ ] Evaluate whether Cloudflare Workers AI binding can call a fast model
- [ ] Design structured prompt for task completion assessment
- [ ] Implement confidence-scored auto-completion
- [ ] Add telemetry to measure accuracy of auto-completion decisions
- [ ] Consider: use this as a "suggestion" rather than auto-action

## Acceptance Criteria

- [ ] Users can manually mark a task as completed from the chat view
- [ ] Tasks auto-complete when associated PR is merged (Phase 2)
- [ ] The dashboard active tasks grid accurately reflects task state
- [ ] Idle cleanup timer continues to work as a safety net
- [ ] Workspace is stopped and node returned to warm pool on any completion path
- [ ] All completion paths are tested with capability tests
- [ ] No regression in existing task submission or execution flow

## References

- Task state machine: `packages/shared/src/types.ts:367-396`
- Task submit route: `apps/api/src/routes/task-submit.ts`
- Task status callback: `apps/api/src/routes/tasks.ts:643-834`
- Idle cleanup: `apps/api/src/durable-objects/project-data.ts:579-724`
- GitHub webhook handler: `apps/api/src/routes/github.ts:178-258`
- Agent completion + git push: `packages/vm-agent/internal/server/server.go:602-793`
- Branch naming: `apps/api/src/services/branch-name.ts`
- TaskRunner DO: `apps/api/src/durable-objects/task-runner.ts`
- NodeLifecycle DO: `apps/api/src/durable-objects/node-lifecycle.ts`
- Chat UI: `apps/web/src/pages/ProjectChat.tsx`

### Prior Art Sources
- [Devin AI — Coding Agents 101](https://devin.ai/agents101) — confidence scoring, test-driven verification
- [GitHub Copilot Coding Agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent) — issue → PR lifecycle, PR merge as completion
- [Augment Code — Typed Task Lists](https://www.augmentcode.com/blog/how-we-built-tasklist) — strict task lifecycle, visual states
- [AGENTS.md Standard](https://blakecrosley.com/blog/agents-md-patterns) — explicit "definition of done", exit codes
- [Beyond Task Completion (arxiv)](https://arxiv.org/html/2512.12791v1) — false completion is #1 reliability issue
- [Agentic AI Trends 2026](https://www.ema.co/additional-blogs/addition-blogs/agentic-ai-trends-predictions-2025) — bounded autonomy, checkpoints
- [GitHub Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) — pull_request event with merged detection
- [Agentic Workflows for Software Development (McKinsey)](https://medium.com/quantumblack/agentic-workflows-for-software-development-dc8e64f4a79d) — deterministic orchestration + bounded execution
- [CI/CD Automation Using Webhooks (Netlify)](https://www.netlify.com/blog/guide-to-ci-cd-automation-using-webhooks/) — event-driven completion patterns
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — task status can lag, manual nudging needed
