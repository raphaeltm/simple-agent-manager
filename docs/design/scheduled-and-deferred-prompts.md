# Scheduled and Deferred Prompt Execution

> **Status**: Design exploration (March 2026)
> **Scope**: What it would take to support (1) prompts that run on a recurring schedule and (2) prompts that run at a specific future time — and how both connect to the DAG execution model.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [What Exists Today](#what-exists-today)
3. [Capability 1: Deferred Prompts (Run at Future Time)](#capability-1-deferred-prompts-run-at-future-time)
4. [Capability 2: Scheduled Prompts (Run on Recurring Schedule)](#capability-2-scheduled-prompts-run-on-recurring-schedule)
5. [Connection to the DAG System](#connection-to-the-dag-system)
6. [Data Model](#data-model)
7. [Infrastructure Requirements](#infrastructure-requirements)
8. [Cost and Resource Considerations](#cost-and-resource-considerations)
9. [UI/UX Considerations](#uiux-considerations)
10. [Implementation Phases](#implementation-phases)
11. [Open Questions](#open-questions)

---

## Executive Summary

Today, SAM tasks execute immediately when a user clicks "Run" or submits a prompt. There is no way to say "run this at 3am" or "run this every Monday at 9am." Adding these two capabilities — **deferred execution** (one-shot, future-dated) and **scheduled execution** (recurring, cron-like) — would unlock powerful automation patterns, especially when combined with the planned DAG/graph execution model.

The good news: SAM's existing architecture already has most of the primitives needed. Durable Object alarms, the TaskRunner DO step machine, warm node pooling, and the cron sweep infrastructure all provide a foundation. The main new work is a **SchedulerDO** (Durable Object) that manages timing, a scheduling data model in D1, and UI for creating/managing schedules.

---

## What Exists Today

### Primitives We Can Build On

| Primitive | Where | How It Helps |
|-----------|-------|-------------|
| **DO Alarms** | TaskRunner, NodeLifecycle, ProjectData | Cloudflare DO alarms fire at a specific future time. This is the core mechanism for "run at time X." Each DO gets one alarm at a time; when it fires, the DO's `alarm()` handler runs. |
| **Cron Triggers** | `wrangler.toml` → `apps/api/src/index.ts:scheduled()` | Workers cron runs every 5 minutes. Currently handles cleanup/recovery. Could dispatch scheduled tasks, but 5-minute granularity limits precision. |
| **TaskRunner DO** | `apps/api/src/durable-objects/task-runner.ts` | Already handles the full task lifecycle: node selection → provisioning → workspace creation → agent session → running. A scheduler just needs to instantiate TaskRunner DOs at the right time. |
| **Warm Node Pooling** | NodeLifecycle DO | Warm nodes can be claimed instantly for scheduled tasks, avoiding cold-start provisioning delays. Critical for time-sensitive scheduled execution. |
| **Task Submission API** | `POST /api/projects/:projectId/tasks/submit` | Atomic task creation + TaskRunner DO instantiation. A scheduler can call this internally. |
| **MCP dispatch_task** | `apps/api/src/routes/mcp.ts` | Agents can already spawn child tasks. A scheduled prompt could dispatch a graph of tasks. |
| **task_dependencies table** | D1 schema | Dependency edges exist in the schema. Combined with `apps/api/src/services/task-graph.ts` utilities (`isTaskBlocked`, `wouldCreateTaskDependencyCycle`), DAG scheduling is partially implemented. |

### What's Missing

| Gap | Why It Matters |
|-----|---------------|
| No scheduling data model | No tables for storing "run prompt X at time Y" or "run prompt X every Z" |
| No Scheduler Durable Object | Nothing to wake up at a future time and trigger task creation |
| No schedule management UI | Users can't create, view, edit, or delete schedules |
| No prompt templates | Scheduled prompts need a stored prompt — today prompts are ephemeral chat messages |
| No execution history per schedule | No way to see "this schedule ran 5 times, 4 succeeded, 1 failed" |
| No concurrency policy | What happens if a scheduled run is still executing when the next trigger fires? |

---

## Capability 1: Deferred Prompts (Run at Future Time)

**"Run this prompt tomorrow at 3am."**

This is the simpler of the two capabilities — a one-shot delayed execution.

### How It Would Work

```
User creates deferred prompt
        │
        ▼
  API: POST /api/projects/:id/prompts/schedule
  Creates `scheduled_prompt` row in D1 (type: 'once', run_at: <timestamp>)
  Instantiates SchedulerDO: env.SCHEDULER.idFromName(scheduleId)
  SchedulerDO sets alarm for run_at time
        │
        ▼
  [Time passes... DO alarm fires at run_at]
        │
        ▼
  SchedulerDO.alarm():
    1. Reads scheduled_prompt from D1
    2. Calls task submission service internally (same as POST /tasks/submit)
    3. TaskRunner DO takes over — standard execution flow
    4. Records execution in scheduled_prompt_runs table
    5. Marks schedule as 'completed'
```

### What Needs to Be Built

1. **SchedulerDO** — A Durable Object (one per schedule) that:
   - Stores the schedule ID and type ('once' | 'recurring')
   - Sets a DO alarm for the target execution time
   - On alarm: creates a task via the existing task submission pipeline
   - Records the execution result

2. **D1 tables** — `scheduled_prompts` and `scheduled_prompt_runs` (see Data Model section)

3. **API endpoints**:
   - `POST /api/projects/:id/prompts/schedule` — create a deferred prompt
   - `GET /api/projects/:id/prompts/schedules` — list schedules for a project
   - `DELETE /api/projects/:id/prompts/schedules/:scheduleId` — cancel a deferred prompt
   - `GET /api/projects/:id/prompts/schedules/:scheduleId/runs` — execution history

4. **Prompt storage** — The prompt text needs to be stored persistently (today prompts are just chat messages). This becomes a `prompt_text` column on `scheduled_prompts`, or a separate `prompt_templates` table if we want reusable prompts.

### Complexity: Low-Medium

The core mechanism (DO alarm → create task) is straightforward and mirrors existing patterns (NodeLifecycle uses the same alarm → action pattern). The main work is the data model, API, and UI.

### Cloudflare DO Alarm Constraints

- **One alarm per DO instance.** Each SchedulerDO handles one schedule. For recurring schedules, the alarm is reset after each execution.
- **Alarm precision**: Alarms fire "at or after" the scheduled time. Typically within seconds, but not guaranteed to be millisecond-precise. Fine for "run at 3am" — not suitable for sub-second precision.
- **DO eviction**: If a DO is evicted from memory, the alarm still fires and the DO is rehydrated. Alarms survive DO lifecycle — this is a key reliability guarantee.
- **Maximum alarm delay**: Cloudflare doesn't document a maximum future alarm time, but DOs have been tested with alarms days/weeks in advance. For very long delays (months), a cron reconciliation sweep adds safety.

---

## Capability 2: Scheduled Prompts (Run on Recurring Schedule)

**"Run this prompt every Monday at 9am" or "Run this every 6 hours."**

This builds on deferred prompts by adding recurrence.

### How It Would Work

```
User creates recurring schedule
        │
        ▼
  API: POST /api/projects/:id/prompts/schedule
  Creates `scheduled_prompt` row (type: 'recurring', cron_expression: '0 9 * * 1')
  Instantiates SchedulerDO
  SchedulerDO computes next_run_at from cron expression, sets alarm
        │
        ▼
  [Alarm fires at next_run_at]
        │
        ▼
  SchedulerDO.alarm():
    1. Checks concurrency policy (skip if previous run still active?)
    2. Creates task via submission pipeline
    3. Records run in scheduled_prompt_runs
    4. Computes NEXT next_run_at from cron expression
    5. Sets alarm for next execution
    6. Repeats forever (until paused/deleted)
```

### Additional Requirements Beyond Deferred Prompts

1. **Cron expression parsing** — Need a library to parse cron expressions and compute next execution times. Options:
   - `cron-parser` (npm) — lightweight, well-maintained
   - `croner` (npm) — modern, supports seconds precision
   - Custom implementation — not recommended, cron parsing is deceptively complex

2. **Concurrency policy** — What happens when the previous run is still executing?
   - **Skip**: Don't start a new run if the previous one is still active (safest default)
   - **Queue**: Start the new run on a different workspace (parallel execution)
   - **Replace**: Cancel the in-progress run and start fresh
   - Recommendation: default to **skip**, make configurable per schedule

3. **Schedule lifecycle management**:
   - **Pause/Resume**: Temporarily disable a schedule without deleting it
   - **Edit**: Modify the cron expression, prompt, or configuration
   - **Disable on failure**: Optionally auto-pause after N consecutive failures

4. **Timezone handling** — Cron expressions need a timezone. Store as `timezone` column (IANA timezone, e.g., `America/New_York`). Compute next execution in the user's timezone.

5. **Cron reconciliation sweep** — Safety net in the existing 5-minute cron handler:
   - Query `scheduled_prompts` where `next_run_at < now() - 10 minutes` and status is active
   - If a SchedulerDO missed its alarm (rare but possible after DO migration/outage), the cron sweep catches it
   - Same pattern as stuck task recovery — defense in depth

### Complexity: Medium

Cron parsing, timezone handling, concurrency policies, and the recurring alarm loop add significant complexity beyond one-shot deferred execution. But the core pattern (DO alarm → create task → reset alarm) is sound.

---

## Connection to the DAG System

This is where things get really powerful. Scheduled and deferred prompts become **trigger sources** for DAG execution graphs.

### Today's Mental Model

```
User types prompt → Single task → Single agent → Single workspace
```

### With Scheduling + DAGs

```
Schedule fires at 9am Monday
        │
        ▼
  Prompt: "Review all open PRs, run test suites,
           and generate a weekly status report"
        │
        ▼
  GraphRunner decomposes into DAG:
        │
   ┌────┴────┐
   ▼         ▼
[List PRs] [Run tests on main]
   │         │
   ▼         ▼
[Review PR 1] [Review PR 2] [Review PR 3]   [Analyze test results]
   │            │              │                     │
   └────────────┴──────────────┴─────────────────────┘
                        │
                        ▼
              [Generate weekly report]
                        │
                        ▼
              [Post to Slack/create summary issue]
```

### Three Integration Points

#### 1. Schedule as DAG Trigger

A schedule doesn't just create a single task — it can create an **orchestration run**:

```typescript
// SchedulerDO.alarm() — recurring schedule fires
async alarm() {
  const schedule = await this.getSchedule();

  if (schedule.executionMode === 'single') {
    // Simple: create one task
    await this.submitTask(schedule.promptText, schedule.config);
  } else if (schedule.executionMode === 'graph') {
    // Complex: create an orchestration run with a planner
    await this.createOrchestrationRun({
      projectId: schedule.projectId,
      promptText: schedule.promptText,
      mode: 'plan-first',  // Let a planner agent decompose the work
      config: schedule.config,
    });
  }

  // Schedule next execution
  this.scheduleNextAlarm();
}
```

This means a single cron schedule can orchestrate complex multi-agent workflows automatically.

#### 2. DAG Nodes as Deferred Prompts

Within a DAG, individual nodes could be scheduled for specific times:

```
[Data collection node] ── runs at 2am (when API rate limits reset)
        │
        ▼
[Analysis node] ── runs after collection completes (deferred until dependency met)
        │
        ▼
[Report generation] ── runs at 8am (before standup)
```

This introduces **time-based dependencies** in addition to completion-based dependencies. A DAG node's "ready" condition becomes: `all dependencies completed AND scheduled_time <= now`.

The GraphRunner would need to understand two types of edges:
- **Completion edges**: "run B after A completes" (existing `task_dependencies`)
- **Time edges**: "run B after A completes AND after 8am" (new)

#### 3. Schedule Chaining (Schedule → Schedule)

The output of one scheduled run can trigger another schedule:

```
Weekly code quality scan (Sunday 2am)
  → If issues found, triggers: "Fix critical issues" run (immediate)
    → On completion, triggers: "Deploy fixes to staging" (immediate)
      → Deferred: "Run smoke tests" (30 minutes after deploy)
```

This is essentially a **temporal DAG** — a graph where some edges are time-based rather than data-based. The SchedulerDO and GraphRunner work together:

- SchedulerDO handles time-based triggers
- GraphRunner handles completion-based triggers
- A "temporal edge" is a completion edge + a SchedulerDO alarm

### Why This Combination Is Powerful

| Pattern | Example | What It Enables |
|---------|---------|----------------|
| **Recurring maintenance** | "Every night, run the test suite and report failures" | Continuous quality monitoring without human intervention |
| **Batch processing** | "Every Sunday, review all PRs opened this week" | Automated code review cadence |
| **Event-driven chains** | "When deploy completes, wait 10 min, then run smoke tests" | Post-deployment verification |
| **Conditional branching** | "Run security scan; if critical issues, auto-fix; if not, just report" | Intelligent automation with conditional paths |
| **Multi-project coordination** | "After backend deploys, trigger frontend rebuild + deploy" | Cross-project orchestration |
| **Cost-optimized execution** | "Run expensive analysis at 3am when spot prices are lower" | Time-shifted compute for cost savings |
| **Human-in-the-loop** | "Generate PR every morning; if not reviewed by 5pm, ping Slack" | Automated workflows with human checkpoints |

---

## Data Model

### New D1 Tables

```sql
-- Stored prompts that can be scheduled
CREATE TABLE scheduled_prompts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),

  -- What to run
  name TEXT NOT NULL,                    -- Human-readable name
  prompt_text TEXT NOT NULL,             -- The prompt to execute
  execution_mode TEXT NOT NULL DEFAULT 'single',  -- 'single' | 'graph'

  -- Schedule configuration
  schedule_type TEXT NOT NULL,           -- 'once' | 'recurring'
  run_at TEXT,                           -- ISO timestamp for 'once' type
  cron_expression TEXT,                  -- Cron expression for 'recurring' type
  timezone TEXT NOT NULL DEFAULT 'UTC',  -- IANA timezone

  -- Execution configuration
  vm_size TEXT,                          -- Override project default
  agent_type TEXT,                       -- Override project default
  branch TEXT,                           -- Git branch to work on
  workspace_profile TEXT,                -- 'lightweight' | 'full'
  cloud_provider TEXT,                   -- Provider override
  concurrency_policy TEXT NOT NULL DEFAULT 'skip',  -- 'skip' | 'queue' | 'replace'
  max_consecutive_failures INTEGER DEFAULT 5,       -- Auto-pause after N failures

  -- State
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'completed' | 'failed'
  next_run_at TEXT,                      -- Computed next execution time
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  -- Metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at TEXT,

  -- Scheduler DO reference
  scheduler_do_id TEXT                   -- For DO lookup/cleanup
);

-- Execution history for each schedule
CREATE TABLE scheduled_prompt_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES scheduled_prompts(id),
  task_id TEXT REFERENCES tasks(id),     -- The task created for this run
  run_id TEXT,                           -- Orchestration run ID (for graph mode)

  -- Execution state
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,

  -- Results
  skip_reason TEXT,                      -- Why this run was skipped (e.g., 'previous_still_running')
  error_message TEXT,                    -- Failure details
  summary TEXT,                          -- Agent's completion summary

  -- For concurrency tracking
  was_concurrent INTEGER NOT NULL DEFAULT 0  -- Was previous run still active when this triggered?
);

CREATE INDEX idx_scheduled_prompts_project ON scheduled_prompts(project_id);
CREATE INDEX idx_scheduled_prompts_next_run ON scheduled_prompts(next_run_at) WHERE status = 'active';
CREATE INDEX idx_scheduled_prompt_runs_schedule ON scheduled_prompt_runs(schedule_id);
CREATE INDEX idx_scheduled_prompt_runs_status ON scheduled_prompt_runs(status) WHERE status = 'running';
```

### SchedulerDO State

```typescript
interface SchedulerDOState {
  scheduleId: string;
  projectId: string;
  userId: string;
  scheduleType: 'once' | 'recurring';
  nextRunAt: string;         // ISO timestamp
  lastRunId: string | null;  // For concurrency checks
  status: 'active' | 'paused' | 'completed';
}
```

---

## Infrastructure Requirements

### New Components

| Component | Type | Effort | Description |
|-----------|------|--------|-------------|
| **SchedulerDO** | Durable Object | Medium | Per-schedule DO that manages alarm timing and task creation |
| **Cron expression parser** | npm dependency | Small | Parse cron expressions → next execution time |
| **Schedule API routes** | Hono routes | Medium | CRUD for schedules + run history |
| **Schedule management UI** | React components | Medium | Create/edit/pause/delete schedules, view run history |
| **Cron reconciliation** | Addition to existing cron | Small | Safety net for missed DO alarms |
| **Prompt template storage** | D1 migration | Small | Store prompt text persistently |

### Wrangler Configuration Changes

```toml
# New Durable Object binding (add to top-level wrangler.toml)
[[durable_objects.bindings]]
name = "SCHEDULER"
class_name = "Scheduler"

[[migrations]]
tag = "v<next>"
new_classes = ["Scheduler"]
```

### Environment Variables (Constitution Principle XI)

```
SCHEDULER_MAX_SCHEDULES_PER_PROJECT=50     # Prevent unbounded schedule creation
SCHEDULER_MAX_CONSECUTIVE_FAILURES=5        # Auto-pause threshold
SCHEDULER_RECONCILIATION_INTERVAL_MS=300000 # 5 min cron sweep for missed alarms
SCHEDULER_MIN_INTERVAL_MS=300000            # Minimum 5 min between recurring runs
SCHEDULER_MAX_FUTURE_DAYS=365               # Max days ahead for deferred prompts
```

---

## Cost and Resource Considerations

### VM Cost Impact

Scheduled prompts create tasks that provision VMs. Unbounded scheduling could lead to significant infrastructure costs.

**Guardrails needed:**

1. **Minimum interval** — Don't allow recurring schedules more frequent than every 5 minutes (`SCHEDULER_MIN_INTERVAL_MS`)
2. **Maximum active schedules per project** — Cap at 50 (`SCHEDULER_MAX_SCHEDULES_PER_PROJECT`)
3. **Cost estimation** — Show estimated monthly cost when creating a schedule based on: `frequency × average_task_duration × vm_hourly_rate`
4. **Budget alerts** — Notify user when scheduled execution costs exceed a threshold
5. **Auto-pause on failure** — Don't keep burning VMs on a schedule that always fails

### Warm Node Optimization

Scheduled prompts are **ideal candidates for warm node pooling**:
- Predictable execution times mean nodes can be pre-warmed
- Recurring schedules could keep a dedicated warm node alive between runs
- Future optimization: "warm node reservation" — keep a node warm specifically for a schedule's next execution

### Cloudflare Costs

- **DO alarm storage**: Negligible (pennies/month for alarm metadata)
- **DO requests**: Each alarm fire = 1 DO request (~$0.15/million). Even 1000 schedules firing hourly = ~$0.50/month
- **D1 queries**: Schedule reads/writes are minimal compared to existing task/chat traffic
- **Worker invocations**: Same cost as manual task submission

The infrastructure cost is negligible. The VM compute cost is the real expense, and that scales linearly with usage regardless of whether tasks are manual or scheduled.

---

## UI/UX Considerations

### Schedule Creation

Two entry points:

1. **From chat**: "Schedule this" button/command after composing a prompt — creates a schedule from the current prompt text
2. **From project settings**: Dedicated "Schedules" section for managing all project schedules

### Schedule Management View

```
┌─────────────────────────────────────────────────┐
│ Project: my-app  >  Schedules                    │
├─────────────────────────────────────────────────┤
│                                                   │
│  ● Weekly PR Review           Every Mon 9:00 AM  │
│    Last run: 2h ago (✓ completed)                │
│    Next run: in 5 days                           │
│    [Pause] [Edit] [Delete]                       │
│                                                   │
│  ● Nightly Test Suite         Every day 2:00 AM  │
│    Last run: 8h ago (✓ completed)                │
│    Next run: in 16h                              │
│    [Pause] [Edit] [Delete]                       │
│                                                   │
│  ◉ Deploy to staging          Mar 24 at 3:00 PM │
│    Status: scheduled (one-time)                  │
│    [Cancel]                                      │
│                                                   │
│  ○ Security scan (paused)     Every Sun 1:00 AM  │
│    Paused: auto-paused after 3 failures          │
│    Last error: "npm audit timeout"               │
│    [Resume] [Edit] [Delete]                      │
│                                                   │
│  [+ New Schedule]                                │
│                                                   │
└─────────────────────────────────────────────────┘
```

### Run History View

```
┌─────────────────────────────────────────────────┐
│ Weekly PR Review — Run History                   │
├─────────────────────────────────────────────────┤
│                                                   │
│  ✓ Mar 17, 9:00 AM   completed in 23 min        │
│    "Reviewed 4 PRs, approved 2, commented on 2"  │
│    [View chat session]                           │
│                                                   │
│  ✓ Mar 10, 9:01 AM   completed in 18 min        │
│    "Reviewed 2 PRs, approved 2"                  │
│    [View chat session]                           │
│                                                   │
│  ⊘ Mar 3, 9:00 AM    skipped                    │
│    "Previous run still in progress"              │
│                                                   │
│  ✗ Feb 24, 9:00 AM   failed after 5 min         │
│    "Node provisioning timeout"                   │
│    [View error details]                          │
│                                                   │
└─────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Deferred Prompts (One-Shot)

**Effort**: Medium (1-2 weeks)
**Dependencies**: None — can build on existing infrastructure

1. D1 migration: `scheduled_prompts` and `scheduled_prompt_runs` tables
2. SchedulerDO implementation (alarm → task creation, one-shot only)
3. Add SchedulerDO binding to `wrangler.toml`
4. API routes: create, get, list, cancel deferred prompts
5. Basic UI: "Schedule for later" option in task submission
6. Cron reconciliation: add missed-alarm check to existing cron handler
7. Tests: unit tests for SchedulerDO, integration tests for the create→fire→execute flow

### Phase 2: Recurring Schedules

**Effort**: Medium-Large (2-3 weeks)
**Dependencies**: Phase 1

1. Add cron expression parsing (npm dependency)
2. Extend SchedulerDO: recurring alarm loop, next-run computation, timezone handling
3. Concurrency policy implementation (skip/queue/replace)
4. Auto-pause on consecutive failures
5. API routes: pause, resume, edit schedules
6. Full schedule management UI (list, create, edit, pause, history)
7. Tests: timezone edge cases, concurrency policies, failure auto-pause

### Phase 3: DAG Integration

**Effort**: Large (3-4 weeks)
**Dependencies**: Phase 2 + Graph Execution Model (separate track)

1. `execution_mode: 'graph'` support in SchedulerDO
2. Schedule → GraphRunner DO instantiation
3. Time-based dependency edges in task_dependencies
4. GraphRunner awareness of time constraints on nodes
5. UI: show graph execution status within schedule run history
6. Tests: scheduled graph execution, time-based dependency resolution

### Phase 4: Advanced Patterns

**Effort**: Large (ongoing)
**Dependencies**: Phase 3

1. Schedule chaining (output of one schedule triggers another)
2. Conditional execution (run only if condition met — e.g., "only if there are open PRs")
3. Warm node reservation for predictable schedules
4. Cost estimation and budget alerts
5. Webhook triggers (external events fire a deferred prompt)
6. Template library (reusable prompt templates across schedules)

---

## Open Questions

### Design Decisions Needed

1. **Prompt templates vs. inline prompts**: Should schedules reference a reusable prompt template, or store the prompt text directly? Templates enable reuse and versioning; inline is simpler to start.

2. **Schedule ownership**: Project-level or user-level? Can any project member edit any schedule, or only the creator? Matters for future team/org support.

3. **Execution context**: When a scheduled prompt runs, what git branch does it work on? Options:
   - Always `main` (simplest)
   - Configurable per schedule (most flexible)
   - Create a new branch per run (safest for recurring schedules)

4. **Notification policy**: How are users notified of scheduled run results?
   - Always notify (noisy for frequent schedules)
   - Notify on failure only (might miss important results)
   - Configurable per schedule (most flexible, more UI complexity)

5. **Idempotency**: If a schedule fires and creates a task, but the task fails to start, should the scheduler retry? How many times? What's the retry window before it's considered a missed execution?

6. **Maximum alarm horizon**: DO alarms work well for hours/days. For "run next January 1st," do we trust a DO alarm set 9 months in advance, or do we use a cron sweep to check for upcoming schedules within the next hour?

### Technical Questions

7. **Cron library choice**: `cron-parser` (battle-tested, no seconds) vs `croner` (modern, supports seconds, Deno-compatible). Both are lightweight.

8. **Timezone handling in Workers**: Cloudflare Workers run in UTC. Need to verify that timezone conversions work correctly in the Workers runtime (Intl API support).

9. **DO alarm reliability at scale**: What happens with 10,000 active SchedulerDOs each with an alarm? Cloudflare's documentation suggests this scales well, but should be tested.

10. **Schedule migration**: If we change the SchedulerDO's interface, existing DOs need to handle the old state format. Standard DO migration patterns apply.

### Product Questions

11. **Free tier limits**: How many schedules should free users get? Schedules consume compute resources even without user interaction.

12. **Audit trail**: Should schedule modifications (edit, pause, resume) be logged in the project activity feed?

13. **External triggers**: Beyond time-based triggers, should we support webhook triggers (GitHub push → run prompt)? This is a natural extension but significantly expands scope.

---

## Related Documents

- [Graph-Based Task Execution Model](../../tasks/backlog/2026-03-19-graph-execution-model.md) — the DAG system this connects to
- [Orchestration Platform Vision](orchestration-platform-vision.md) — high-level platform evolution
- [Task-Chat Architecture (Spec 021)](../../specs/021-task-chat-architecture/) — current task execution
- [TDF-2 Orchestration Engine](../../specs/tdf-2-orchestration-engine/) — TaskRunner DO design
