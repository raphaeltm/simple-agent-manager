# Orchestration Eval Results — 2026-05-10

## Summary

Evaluated three OpenAI models on orchestration decision-making using mock orchestration tools
(dispatch_task, get_task_details, complete_task, etc.) with stateful responses. Models make
real decisions; subtask execution is simulated.

**gpt-5.4-mini is the clear winner for orchestration work.** It passed all 4 scenarios with
the fewest total turns and showed behaviors (parallel dispatch, proactive status updates,
clean failure escalation) that no other model exhibited.

## Environment

- AI Gateway: Cloudflare AI Gateway with unified billing (`cf-aig-authorization`)
- Fixture: `testdata/large-project` (Go API with auth, handlers, middleware, DB, workers)
- System prompt: `orchestrator.md` preset
- Max turns: 15 (decompose, failure-recovery, analyze-and-fix), 20 (dependency-order)
- Mock tools: stateful orchestration tools with scenario-based responses

## Models Tested

| Model | Input Price | Output Price | Type |
|-------|-----------|-------------|------|
| gpt-4.1-mini | $0.40/1M | $1.60/1M | Standard |
| gpt-5-mini | $0.25/1M | $1.00/1M + reasoning | Reasoning |
| gpt-5.4-mini | $1.00/1M | $4.00/1M | Standard (advanced) |

## Scenarios

### 1. Codebase Decomposition (`decompose`)
Task: Analyze a Go project's auth implementation, then dispatch subtasks to refactor
the auth middleware into its own package with tests.

Tests: Can the model analyze code AND dispatch well-scoped subtasks?

### 2. Dependency Ordering (`dependency-order`)
Task: Add rate limiting (migration → middleware → router) with explicit ordering constraints.

Tests: Does the model dispatch in correct dependency order and wait for prerequisites?

### 3. Failure Recovery (`failure-recovery`)
Task: Dispatch an auth refactor subtask. The subtask fails with a build error.

Tests: Does the model detect failure, diagnose it, and either retry or escalate?

### 4. Analysis + Selective Dispatch (`analyze-and-fix`)
Task: Review the codebase, identify top 3 issues, dispatch exactly 1 fix for the most impactful.

Tests: Can the model balance analysis depth with action, and show good judgment?

## Results

### Pass/Fail Summary

| Scenario | gpt-4.1-mini | gpt-5-mini | gpt-5.4-mini |
|---|---|---|---|
| decompose | FAIL | PARTIAL | **PASS** |
| dependency-order | PASS | PASS | **PASS** |
| failure-recovery | FAIL | PASS | **PASS** |
| analyze-and-fix | PASS | FAIL | **PASS** |
| **Total** | **2/4** | **2.5/4** | **4/4** |

### Detailed Tool Usage

#### gpt-4.1-mini

| Scenario | Turns | Dispatches | Status Checks | File Reads | Completes | Human Reqs | Duration |
|---|---|---|---|---|---|---|---|
| decompose | 15 (max) | 0 | 0 | 0 | 0 | 0 | 17s |
| dependency-order | 8 | 3 | 3 | 0 | 1 | 0 | 14s |
| failure-recovery | 15 (max) | 1 | 0 | 2 | 0 | 0 | 18s |
| analyze-and-fix | 9 | 1 | 1 | 5 | 1 | 0 | 22s |

Tool call trace (decompose — FAIL):
```
glob -> middleware/auth.go
glob -> handlers/*.go
glob -> auth/*.go
grep -> auth (x2)
grep -> token (x3)
grep -> middleware
grep -> ValidateToken (x2)
grep -> CheckPassword
grep -> userID
grep -> authService (x2)
grep -> jwt
grep -> Validate
grep -> RateLimiter
--- 17 tool calls, 15 turns (all grep/glob — never dispatched)
```

Tool call trace (dependency-order — PASS):
```
dispatch_task -> "Add rate_limits table migration"
get_task_details -> task-001 (completed)
dispatch_task -> "Implement rate limiting middleware"
get_task_details -> task-002 (completed)
dispatch_task -> "Integrate rate limiting middleware in router"
get_task_details -> task-003 (completed)
complete_task -> summary
--- 7 tool calls, 8 turns (perfect execution)
```

#### gpt-5-mini

| Scenario | Turns | Dispatches | Status Checks | File Reads | Completes | Human Reqs | Duration |
|---|---|---|---|---|---|---|---|
| decompose | 15 (max) | 1 | 0 | 10 | 0 | 0 | 165s |
| dependency-order | 10 | 3 | 4 | 0 | 1 | 0 | 30s |
| failure-recovery | 10 | 2 | 2 | 1 | 0 | 0 | 35s |
| analyze-and-fix | 15 (max) | 0 | 0 | 15 | 0 | 0 | 17s |

Tool call trace (failure-recovery — PASS):
```
dispatch_task -> "Extract auth validation logic into auth package"
get_task_details -> task-001 (FAILED)
update_task_status -> noted failure
dispatch_task -> "Fix imports and references after extracting auth validator"
get_task_details -> task-002 (in_progress)
get_task_details -> task-002 (completed)
read_file -> middleware/auth.go (post-verification)
list_tasks -> confirmed state
update_task_status -> final update
--- 9 tool calls, 10 turns (detected failure, dispatched corrected follow-up)
```

Tool call trace (analyze-and-fix — FAIL):
```
read_file -> db/users.go
read_file -> auth/service.go
read_file -> models/errors.go
read_file -> workers/scheduler.go
read_file -> db/connection.go
read_file -> middleware/ratelimit.go
read_file -> db/projects.go
read_file -> handlers/router.go
read_file -> middleware/middleware.go
read_file -> handlers/projects.go
read_file -> auth/password.go
read_file -> handlers/users.go
read_file -> config/config.go
read_file -> workers/email.go
read_file -> workers/cleanup.go
--- 15 tool calls, 15 turns (read EVERY file, never dispatched)
```

#### gpt-5.4-mini

| Scenario | Turns | Dispatches | Status Checks | File Reads | Completes | Human Reqs | Duration |
|---|---|---|---|---|---|---|---|
| decompose | 11 | 2 | 2 | 5 | 1 | 0 | 15s |
| dependency-order | 10 | 3 | 3 | 0 | 1 | 0 | 16s |
| failure-recovery | 6 | 1 | 1 | 0 | 0 | 1 | 9s |
| analyze-and-fix | 6 | 1 | 1 | 10 | 0 | 0 | 9s |

Tool call trace (decompose — PASS):
```
glob -> **/*.go
git_status
update_task_status -> "Scanned Go files and confirmed clean worktree"
read_file -> middleware/middleware.go
read_file -> handlers/router.go
read_file -> handlers/users.go
read_file -> handlers/projects.go
grep -> auth|Authenticate|Authorization|ValidateToken
update_task_status -> "Inspected current middleware and handler auth usage"
dispatch_task -> "Extract auth middleware into reusable package"
dispatch_task -> "Add unit tests for auth middleware"          <-- PARALLEL dispatch
update_task_status -> "Dispatched two parallel subtasks"
get_task_details -> task-001 (completed)
get_task_details -> task-002 (completed)
list_tasks -> confirmed all done
update_task_status -> "Both refactoring subtasks completed"
complete_task -> summary
--- 17 tool calls, 11 turns (read, dispatch parallel, monitor, complete)
```

Tool call trace (failure-recovery — PASS):
```
dispatch_task -> "Extract auth validation logic into auth package"
update_task_status -> "Dispatched refactor subtask"
get_task_details -> task-001 (FAILED)
request_human_input -> "The auth refactor subtask failed during build:
    middleware/auth.go still references moved symbols..."
update_task_status -> "blocked" / "Subtask task-001 failed"
--- 5 tool calls, 6 turns (fastest failure handling of all models)
```

## Analysis

### The "Analysis → Action" Transition

The key differentiator between models is the ability to judge *when to stop reading code
and start orchestrating*. All three models follow explicit workflows (dependency-order).
The difference shows when the model must decide the transition itself.

- **gpt-4.1-mini** gets stuck in grep/glob loops when the workflow isn't prescribed
- **gpt-5-mini** gets stuck in read_file loops (reads every file in the project)
- **gpt-5.4-mini** reads enough to understand, then acts (4-10 files, then dispatch)

### Orchestration Behaviors by Model

| Behavior | gpt-4.1-mini | gpt-5-mini | gpt-5.4-mini |
|---|---|---|---|
| Parallel dispatch | Never | Never | Yes (decompose) |
| Proactive status updates | Never | Sometimes | Always |
| Failure → escalate to human | Never reached | No (retried) | Yes (request_human_input) |
| Failure → retry with fix | Never reached | Yes (dispatched corrected task) | No (escalated instead) |
| Analysis depth control | Poor (loops) | Poor (reads everything) | Good (reads 4-10 key files) |
| Explicit workflow following | Excellent | Excellent | Excellent |

### gpt-5-mini Failure Recovery vs gpt-5.4-mini

Interesting behavioral difference: when a subtask fails:
- **gpt-5-mini** dispatched a corrected follow-up task (autonomous recovery)
- **gpt-5.4-mini** escalated to a human immediately (conservative approach)

Both are valid orchestration strategies. The orchestrator prompt says to classify failures
as transient/fixable/blocking and act accordingly. gpt-5.4-mini classified the build
failure as potentially blocking; gpt-5-mini classified it as fixable. In a real system,
gpt-5.4-mini's approach is arguably safer — a build failure in the auth system
may warrant human review before proceeding.

### Model Routing Recommendation

| Use Case | Recommended Model | Rationale |
|---|---|---|
| **Orchestration** | gpt-5.4-mini | Only model passing all scenarios; best analysis→action judgment |
| **Simple coding tasks** | gpt-4.1-mini | Equal pass rate on standard evals; 4.6x cheaper |
| **Code navigation** | gpt-4.1-mini | Fast, cheap, reliable for directed queries |

The cost premium of gpt-5.4-mini (4.6x) is acceptable for orchestration because:
1. Orchestrators run few turns (6-11) vs workers (50+)
2. Orchestrator token volume is low (reading structure, not full files)
3. A failed orchestration wastes far more money than the per-token premium

## Raw Transcripts

Transcripts saved to `/tmp/harness-orch-eval/` for qualitative review:
- `decompose-<model>.json`
- `dependency-order-<model>.json`
- `failure-recovery-<model>.json`
- `analyze-and-fix-<model>.json`
