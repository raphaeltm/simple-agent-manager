# Claude Orchestration Eval Results — 2026-05-10

## Summary

Evaluated Claude Haiku 4.5 on orchestration decision-making using mock orchestration tools
(dispatch_task, get_task_details, complete_task, etc.) with stateful responses. The model makes
real decisions; subtask execution is simulated.

**Claude Sonnet 4.5/4.6 could not be evaluated** due to OAuth token rate limits — the eval
session shares rate budget with the parent Claude Code session (Opus). A dedicated Anthropic
API key is needed for Sonnet eval.

**Claude Haiku 4.5** shows strong orchestration instincts (reads code, dispatches subtasks,
monitors status) but struggles with task completion — it often gets caught in post-dispatch
verification loops, reading files and trying to edit code directly instead of calling
`complete_task`. Only 1 of 4 scenarios completed cleanly.

## Environment

- API: Anthropic Messages API (direct, via OAuth token)
- Model: `claude-haiku-4-5-20251001`
- Fixture: `testdata/large-project` (Go API with auth, handlers, middleware, DB, workers)
- System prompt: `orchestrator.md` preset
- Max turns: 15 (decompose, failure-recovery, analyze-and-fix), 20 (dependency-order)
- Mock tools: stateful orchestration tools with scenario-based responses
- Harness: added native Anthropic provider (`llm/anthropic_client.go`) for this eval

## Infrastructure Note: Anthropic Provider Added to Harness

The harness previously only supported OpenAI-compatible API format. The Cloudflare AI Gateway
does not translate between API formats — it's a passthrough proxy. To evaluate Claude models,
a native Anthropic Messages API provider was added to the harness:

- New file: `packages/harness/llm/anthropic_client.go`
- New CLI provider: `--provider anthropic`
- Auto-detection: eval script sets `PROVIDER=anthropic` when model starts with `claude-`
- Auth: auto-detects OAuth tokens (`sk-ant-oat*`) vs API keys and sets the appropriate header

Key implementation detail: Anthropic requires `input` field on `tool_use` content blocks even
when empty. Go's `json:",omitempty"` drops both nil and empty maps, so `Input` uses
`json.RawMessage` to ensure `"input": {}` is always serialized for tool_use blocks.

## Sonnet Rate Limit Blocker

Claude Sonnet 4.5 and 4.6 returned HTTP 429 (rate_limit_error) on every attempt. The OAuth
token (`CLAUDE_CODE_OAUTH_TOKEN`) used for authentication shares rate budget with the parent
Claude Code session running on Opus. Since Opus consumes the same rate limit bucket as Sonnet,
no Sonnet capacity was available.

**To evaluate Sonnet**, use one of:
1. A dedicated Anthropic API key (not OAuth token)
2. Run the eval from a session that is NOT using Opus
3. Use `SAM_AI_PROXY_URL` pointed at a gateway with a stored Anthropic API key

```bash
# With a dedicated API key:
export SAM_AI_PROXY_URL="https://api.anthropic.com"
export SAM_AI_PROXY_KEY="sk-ant-api-..."
export SAM_AI_MODEL="claude-sonnet-4-5"
./packages/harness/scripts/run-eval-orchestration.sh
```

## Model Tested

| Model | Input Price | Output Price | Type |
|-------|-----------|-------------|------|
| claude-haiku-4-5-20251001 | $0.80/1M | $4.00/1M | Fast |

## Scenarios

### 1. Codebase Decomposition (`decompose`)
Task: Analyze a Go project's auth implementation, then dispatch subtasks to refactor
the auth middleware into its own package with tests.

### 2. Dependency Ordering (`dependency-order`)
Task: Add rate limiting (migration -> middleware -> router) with explicit ordering constraints.

### 3. Failure Recovery (`failure-recovery`)
Task: Dispatch an auth refactor subtask. The subtask fails with a build error.

### 4. Analysis + Selective Dispatch (`analyze-and-fix`)
Task: Review the codebase, identify top 3 issues, dispatch exactly 1 fix for the most impactful.

## Results

### Pass/Fail Summary

| Scenario | claude-haiku-4-5 | gpt-5.4-mini (reference) |
|---|---|---|
| decompose | PARTIAL | **PASS** |
| dependency-order | PARTIAL | **PASS** |
| failure-recovery | PARTIAL | **PASS** |
| analyze-and-fix | **PASS** | **PASS** |
| **Total** | **1.5/4** | **4/4** |

### Detailed Tool Usage

#### claude-haiku-4-5-20251001

| Scenario | Turns | Dispatches | Status Checks | File Reads | Completes | Human Reqs | Duration |
|---|---|---|---|---|---|---|---|
| decompose | 15 (max) | 3 | 3 | 13 | 0 | 0 | 50s |
| dependency-order | 20 (max) | 4 | 4 | 14 | 0 | 0 | 60s |
| failure-recovery | 15 (max) | 2 | 3 | 6 | 0 | 0 | 38s |
| analyze-and-fix | 10 | 1 | 1 | 15 | 1 | 0 | 43s |

Tool call trace (decompose — PARTIAL):
```
bash -> find . -type f -name "*.go" | head -20
bash -> ls -la middleware/
read_file -> middleware/middleware.go
read_file -> auth/service.go
read_file -> handlers/router.go
read_file -> handlers/users.go
read_file -> handlers/projects.go
grep -> auth patterns in handlers/
read_file -> middleware/logging.go
read_file -> auth/password.go
git_status
update_task_status -> "Analysis complete..."
dispatch_task -> "Create auth middleware"
dispatch_task -> "Create unit tests"
dispatch_task -> "Update handlers"
update_task_status -> "Dispatched 3 subtasks"
get_task_details -> task-001 (completed)
get_task_details -> task-002 (completed)
get_task_details -> task-003 (completed)
read_file -> middleware/auth.go (post-dispatch verification)
read_file -> middleware/auth_test.go
read_file -> handlers/users.go
read_file -> handlers/projects.go
read_file -> middleware/middleware.go
read_file -> handlers/router.go
bash -> ls -la middleware/ && ls -la handlers/
git_status
list_tasks
write_file -> middleware/auth.go (direct edit attempt!)
write_file -> middleware/auth_test.go (direct edit attempt!)
edit_file -> middleware/middleware.go
--- 30 tool calls, 15 turns (max). Good orchestration but then tried to DO the work itself.
```

Tool call trace (dependency-order — PARTIAL):
```
read_file -> main.go, db/migrations.go, middleware/middleware.go, handlers/router.go, db/connection.go
dispatch_task -> "Add rate_limits table migration"
update_task_status -> "Task 1 dispatched"
get_task_details -> task-001 (completed)
read_file -> db/migrations.go (verification)
dispatch_task -> "Create rate_limits migration" (DUPLICATE dispatch!)
get_task_details -> task-002 (completed)
read_file -> db/migrations.go
edit_file -> db/migrations.go (direct edit!)
update_task_status -> "Task 1 complete"
dispatch_task -> "Create rate limiting middleware"
get_task_details -> task-003 (completed)
read_file -> middleware/ratelimit.go
read_file -> middleware/middleware.go
edit_file -> middleware/middleware.go (direct edit!)
edit_file -> middleware/ratelimit.go (direct edit!)
update_task_status -> "Task 2 complete"
dispatch_task -> "Wire middleware into router"
get_task_details -> task-004 (completed)
read_file -> main.go, db/migrations.go, middleware/middleware.go, middleware/ratelimit.go, handlers/router.go
edit_file -> main.go (direct edit!)
--- 26 tool calls, 20 turns (max). Correct ordering but 4 dispatches instead of 3,
--- and edited files directly post-dispatch instead of calling complete_task.
```

Tool call trace (failure-recovery — PARTIAL):
```
read_file -> middleware/middleware.go
glob -> middleware/*.go
read_file -> auth/service.go
glob -> middleware/auth.go
read_file -> middleware/ratelimit.go
update_task_status -> "Analyzing..."
dispatch_task -> "Extract auth validation logic"
get_task_details -> task-001 (FAILED)
read_file -> middleware/auth.go (investigating failure)
bash -> go build ./... (trying to reproduce)
glob -> auth/*.go, middleware/*.go
update_task_status -> "Subtask failed, re-dispatching"
dispatch_task -> "Refactor auth validation (corrected)" <-- Good: retried with corrections
get_task_details -> task-002 (in_progress)
bash -> sleep 3 (waiting)
get_task_details -> task-002 (completed)
read_file -> auth/validation.go (verification)
read_file -> middleware/middleware.go
glob -> middleware/*.go
git_status
--- 20 tool calls, 15 turns (max). Detected failure and retried (good!),
--- but never called complete_task or request_human_input.
```

Tool call trace (analyze-and-fix — PASS):
```
read_file -> main.go
read_file -> db/connection.go
read_file -> auth/service.go
read_file -> handlers/users.go
read_file -> handlers/projects.go
read_file -> middleware/middleware.go
read_file -> db/users.go
read_file -> auth/password.go
read_file -> handlers/router.go
read_file -> config/config.go
read_file -> models/errors.go
read_file -> middleware/ratelimit.go
read_file -> workers/scheduler.go
read_file -> config/validate.go
dispatch_task -> "Fix password hashing in user registration"
update_task_status -> "Subtask dispatched..."
get_task_details -> task-001 (completed)
read_file -> handlers/users.go (post-verification)
git_status
git_log -> last 5 commits
complete_task -> summary with analysis
--- 21 tool calls, 10 turns. Read 14 files, dispatched exactly 1 task,
--- provided clear reasoning, called complete_task. Clean pass.
```

## Analysis

### Comparison with OpenAI Models

| Behavior | claude-haiku-4-5 | gpt-4.1-mini | gpt-5-mini | gpt-5.4-mini |
|---|---|---|---|---|
| Parallel dispatch | Yes (3 tasks) | Never | Never | Yes |
| Proactive status updates | Always | Never | Sometimes | Always |
| Post-dispatch verification | Excessive (reads + edits) | Never | Sometimes | Moderate |
| Failure -> retry | Yes (corrected re-dispatch) | Never reached | Yes | No (escalated) |
| Failure -> escalate | Never | Never | No | Yes |
| Analysis depth control | Poor (reads almost everything) | Poor (loops) | Poor (reads everything) | Good (4-10 files) |
| Calls complete_task | Only 1/4 scenarios | 2/4 | 1/4 | 3/4 |
| Direct code editing as orchestrator | Yes (problematic) | No | No | No |

### The "Orchestrator vs Worker" Boundary Problem

Haiku's distinctive failure mode: it orchestrates correctly (dispatches subtasks, monitors
status) but then crosses the orchestrator/worker boundary by trying to verify and fix the
work itself. After subtasks complete, Haiku:

1. Reads the files that subtasks supposedly changed
2. Finds issues (because mock subtasks don't actually modify files)
3. Starts editing files directly — acting as a worker, not an orchestrator

This burns through the remaining turns on verification/editing instead of calling
`complete_task` to wrap up. The model doesn't trust that dispatched subtasks did their job,
and in mock-tool evals, it's technically right — the mock tools mark tasks as "completed"
but don't actually change files.

**gpt-5.4-mini avoids this trap** by trusting the subtask completion status and moving on
to `complete_task`. This is the correct orchestrator behavior — an orchestrator should
delegate and summarize, not verify and redo.

### Failure Recovery: Different Strategies

When a subtask fails:
- **Haiku** retried with a corrected task description (autonomous recovery)
- **gpt-5-mini** also retried with corrections
- **gpt-5.4-mini** escalated to a human immediately (conservative approach)

Haiku's retry behavior is reasonable for orchestration — the corrected re-dispatch is actually
a good pattern. The issue is that it never called `complete_task` after the retry succeeded.

### Token Efficiency

| Model | Avg Duration per Scenario | Avg Turns | Notes |
|---|---|---|---|
| claude-haiku-4-5 | 48s | 15 (3/4 hit max) | Reads too many files |
| gpt-4.1-mini | 18s | 12 | Faster but less capable |
| gpt-5-mini | 62s | 13 | Reasoning model, slower |
| gpt-5.4-mini | 12s | 8 | Most efficient |

### Model Routing Recommendation (Updated)

| Use Case | Recommended Model | Rationale |
|---|---|---|
| **Orchestration** | gpt-5.4-mini | Only model passing all 4 scenarios; best judgment |
| **Orchestration (Claude)** | Sonnet 4.5+ (untested) | Haiku too chatty; Sonnet likely better at orchestrator discipline |
| **Simple coding tasks** | gpt-4.1-mini or claude-haiku-4-5 | Both adequate for directed work |
| **Code navigation** | gpt-4.1-mini | Fast, cheap, reliable for directed queries |

**Note on Claude Sonnet**: Based on Haiku's behavior, Sonnet 4.5 is likely a strong
orchestration candidate. Haiku shows the right instincts (parallel dispatch, status monitoring,
failure recovery) but lacks the discipline to stop verifying and call `complete_task`.
Sonnet models are better at following high-level workflow constraints. This should be verified
with a dedicated API key.

## Raw Transcripts

Transcripts saved to `/tmp/harness-orch-eval/`:
- `decompose-claude-haiku-4-5-20251001.json`
- `dependency-order-claude-haiku-4-5-20251001.json`
- `failure-recovery-claude-haiku-4-5-20251001.json`
- `analyze-and-fix-claude-haiku-4-5-20251001.json`
