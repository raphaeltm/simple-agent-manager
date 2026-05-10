#!/usr/bin/env bash
# run-eval-orchestration.sh — Evaluate real models on orchestration decision-making.
#
# Tests whether models can properly decompose tasks, dispatch subtasks,
# handle dependencies, recover from failures, and compose results.
# Uses mock orchestration tools (stateful) so the MODEL makes real decisions
# but subtask execution is simulated.
#
# Environment variables:
#   SAM_AI_PROXY_URL  — AI Gateway URL (required)
#   SAM_AI_PROXY_KEY  — API key / CF token for auth (required)
#   SAM_AI_MODEL      — Model name (default: gpt-4.1-mini)
#   SAM_AI_AUTH_HEADER — Custom auth header (e.g. cf-aig-authorization)
#
# Usage:
#   export SAM_AI_PROXY_URL="https://gateway.ai.cloudflare.com/v1/<account>/sam/openai/v1"
#   export SAM_AI_PROXY_KEY="<cf-api-token>"
#   export SAM_AI_AUTH_HEADER="cf-aig-authorization"
#   export SAM_AI_MODEL="gpt-4.1-mini"
#   ./scripts/run-eval-orchestration.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Validate required env vars
if [ -z "${SAM_AI_PROXY_URL:-}" ]; then
  echo "ERROR: SAM_AI_PROXY_URL is required"
  exit 1
fi
if [ -z "${SAM_AI_PROXY_KEY:-}" ]; then
  echo "ERROR: SAM_AI_PROXY_KEY is required"
  exit 1
fi

MODEL="${SAM_AI_MODEL:-gpt-4.1-mini}"
AUTH_HEADER="${SAM_AI_AUTH_HEADER:-}"

# Auto-detect provider from model name.
PROVIDER="${SAM_AI_PROVIDER:-openai}"
if [[ "$MODEL" == claude-* ]] && [ "$PROVIDER" = "openai" ]; then
  PROVIDER="anthropic"
fi
RESULTS_DIR="/tmp/harness-orch-eval"
mkdir -p "$RESULTS_DIR"

echo "============================================"
echo "  SAM Orchestration Eval"
echo "============================================"
echo "  Proxy URL: ${SAM_AI_PROXY_URL}"
echo "  Model:     ${MODEL}"
echo "  Provider:  ${PROVIDER}"
if [ -n "$AUTH_HEADER" ]; then
  echo "  Auth:      ${AUTH_HEADER}"
fi
echo "  Time:      $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# Build the harness
cd "$HARNESS_DIR"
echo "Building harness..."
go build -o /tmp/harness-orch-runner ./cmd/harness/ 2>&1
echo "Build complete."
echo ""

# Build auth header flag
AUTH_FLAG=""
if [ -n "$AUTH_HEADER" ]; then
  AUTH_FLAG="--auth-header $AUTH_HEADER"
fi

# ─────────────────────────────────────────────
# Scenario 1: Codebase Decomposition
# Give the model a real codebase + orchestration tools.
# Can it analyze code AND dispatch well-scoped subtasks?
# ─────────────────────────────────────────────
run_scenario() {
  local NAME="$1"
  local SCENARIO="$2"  # mock scenario: success, failure, mixed
  local FIXTURE="$3"    # testdata fixture dir name
  local PROMPT="$4"
  local MAX_TURNS="${5:-15}"

  echo "--- Scenario: $NAME ---"

  # Prepare isolated working directory
  WORK_DIR=$(mktemp -d)
  cp -r "$HARNESS_DIR/testdata/$FIXTURE/"* "$WORK_DIR/"

  # Init git repo for the fixture
  (cd "$WORK_DIR" && git init -q && git config user.email "eval@test" && git config user.name "Eval" && git add . && git commit -q -m "initial") 2>/dev/null

  TRANSCRIPT="$RESULTS_DIR/${NAME}-${MODEL//\//_}.json"
  START_TIME=$(date +%s)

  set +e
  OUTPUT=$(timeout 180 /tmp/harness-orch-runner \
    --dir "$WORK_DIR" \
    --prompt "$(echo -e "$PROMPT")" \
    --transcript "$TRANSCRIPT" \
    --provider "$PROVIDER" \
    --api-url "$SAM_AI_PROXY_URL" \
    --api-key "$SAM_AI_PROXY_KEY" \
    --model "$MODEL" \
    $AUTH_FLAG \
    --prompt-preset orchestrator \
    --mock-orchestration "$SCENARIO" \
    --tool-profile full \
    --repo-map=true \
    --max-turns "$MAX_TURNS" 2>&1)
  EXIT_CODE=$?
  set -e

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  # Extract metrics from transcript
  TURNS="?"
  DISPATCHES="0"
  STATUS_CHECKS="0"
  COMPLETIONS="0"
  HUMAN_REQUESTS="0"
  FILE_READS="0"

  if [ -f "$TRANSCRIPT" ]; then
    TURNS=$(grep -c '"type":"llm_request"' "$TRANSCRIPT" 2>/dev/null || echo "?")
    DISPATCHES=$(grep -o '"name":"dispatch_task"' "$TRANSCRIPT" 2>/dev/null | wc -l || echo "0")
    STATUS_CHECKS=$(grep -o '"name":"get_task_details"' "$TRANSCRIPT" 2>/dev/null | wc -l || echo "0")
    COMPLETIONS=$(grep -o '"name":"complete_task"' "$TRANSCRIPT" 2>/dev/null | wc -l || echo "0")
    HUMAN_REQUESTS=$(grep -o '"name":"request_human_input"' "$TRANSCRIPT" 2>/dev/null | wc -l || echo "0")
    FILE_READS=$(grep -o '"name":"read_file"' "$TRANSCRIPT" 2>/dev/null | wc -l || echo "0")
  fi

  STATUS="PASS"
  if [ $EXIT_CODE -ne 0 ]; then
    STATUS="FAIL"
  fi

  printf "  Status:     %s (exit %d)\n" "$STATUS" "$EXIT_CODE"
  printf "  Duration:   %ds\n" "$DURATION"
  printf "  Turns:      %s\n" "$TURNS"
  printf "  Dispatches: %s\n" "$DISPATCHES"
  printf "  Status chk: %s\n" "$STATUS_CHECKS"
  printf "  File reads: %s\n" "$FILE_READS"
  printf "  Completions:%s\n" "$COMPLETIONS"
  printf "  Human reqs: %s\n" "$HUMAN_REQUESTS"

  # Extract final message
  if [ -f "$TRANSCRIPT" ]; then
    echo "  ---"
    echo "  Final output (last 5 lines):"
    echo "$OUTPUT" | tail -5 | sed 's/^/    /'
  fi

  echo ""

  # Cleanup
  rm -rf "$WORK_DIR"

  # Return results as vars
  echo "${NAME}|${STATUS}|${TURNS}|${DISPATCHES}|${STATUS_CHECKS}|${FILE_READS}|${COMPLETIONS}|${HUMAN_REQUESTS}|${DURATION}" >> "$RESULTS_DIR/summary-${MODEL//\//_}.csv"
}

# Initialize CSV
echo "scenario|status|turns|dispatches|status_checks|file_reads|completions|human_requests|duration_s" > "$RESULTS_DIR/summary-${MODEL//\//_}.csv"

# ─────────────────────────────────────────────
# Scenario 1: Codebase Decomposition (success scenario)
# ─────────────────────────────────────────────
run_scenario "decompose" "success" "large-project" \
  "You are coordinating a refactoring of this Go project. The authentication middleware in middleware/auth.go needs to be extracted into its own reusable package, proper unit tests need to be added for it, and the handler code in handlers/ that directly checks auth should be updated to use the new middleware. \n\nYour job as orchestrator:\n1. First, analyze the codebase structure to understand the current auth implementation\n2. Then dispatch subtasks to implement this refactoring\n3. Monitor subtask completion\n4. Compose a final summary\n\nProvide specific file paths and context in each subtask description so the child agents can work independently." \
  15

# ─────────────────────────────────────────────
# Scenario 2: Dependency Ordering (success scenario)
# ─────────────────────────────────────────────
run_scenario "dependency-order" "success" "large-project" \
  "Coordinate adding a rate limiting feature to this Go API. This requires three subtasks that MUST be done in order due to dependencies:\n\n1. Database migration: Add a rate_limits table to db/ with fields for IP, endpoint, request_count, and window_start\n2. Middleware: Create a new rate limiting middleware in middleware/ that checks request rates against the DB table\n3. Router integration: Wire the new middleware into the existing router in main.go\n\nIMPORTANT: The migration must complete before the middleware can be tested (it needs the table). The middleware must exist before router integration. Dispatch them in the correct order, waiting for each to complete before dispatching the next dependent task.\n\nAfter all subtasks complete, call complete_task with a summary." \
  20

# ─────────────────────────────────────────────
# Scenario 3: Failure Recovery
# ─────────────────────────────────────────────
run_scenario "failure-recovery" "failure" "large-project" \
  "Coordinate refactoring the authentication system in this Go project. Dispatch a subtask to extract the auth validation logic from middleware/auth.go into a new auth package. After dispatching, monitor the subtask status by checking get_task_details.\n\nIf a subtask fails, you should:\n1. Read the error details carefully\n2. Either dispatch a corrected version of the task with guidance on fixing the issue, OR escalate to a human via request_human_input if the problem seems systemic\n3. Update the task status to reflect the current state" \
  15

# ─────────────────────────────────────────────
# Scenario 4: Analysis + Selective Dispatch
# ─────────────────────────────────────────────
run_scenario "analyze-and-fix" "success" "large-project" \
  "Review this Go codebase for code quality issues. Read the key files to understand the architecture, then:\n\n1. Identify the top 3 code quality issues (e.g., missing error handling, code duplication, security concerns, missing tests, poor separation of concerns)\n2. Rank them by impact\n3. Dispatch exactly ONE subtask to fix the single most impactful issue\n4. Explain your reasoning for which issue you chose and why it's the highest priority\n5. After the subtask completes, call complete_task with your analysis and the fix summary\n\nIMPORTANT: Only dispatch ONE task. The goal is to test your judgment about what matters most, not to fix everything." \
  15

echo ""
echo "============================================"
echo "  Results Summary: $MODEL"
echo "============================================"
echo ""
printf "%-20s %-6s %-6s %-10s %-10s %-10s %-8s %-10s %-8s\n" \
  "SCENARIO" "STATUS" "TURNS" "DISPATCHES" "STATUS_CK" "FILE_READS" "COMPLETE" "HUMAN_REQ" "DURATION"
printf "%-20s %-6s %-6s %-10s %-10s %-10s %-8s %-10s %-8s\n" \
  "--------------------" "------" "------" "----------" "----------" "----------" "--------" "----------" "--------"

while IFS='|' read -r scenario status turns dispatches status_checks file_reads completions human_requests duration; do
  [ "$scenario" = "scenario" ] && continue  # skip header
  printf "%-20s %-6s %-6s %-10s %-10s %-10s %-8s %-10s %-8s\n" \
    "$scenario" "$status" "$turns" "$dispatches" "$status_checks" "$file_reads" "$completions" "$human_requests" "${duration}s"
done < "$RESULTS_DIR/summary-${MODEL//\//_}.csv"

echo ""
echo "Transcripts saved to: $RESULTS_DIR/"
echo ""

# Scoring rubric (printed for human review)
echo "============================================"
echo "  Scoring Rubric"
echo "============================================"
echo ""
echo "  decompose:"
echo "    [+] Read files before dispatching (file_reads > 0)"
echo "    [+] Dispatched 2-4 subtasks (not too many, not too few)"
echo "    [+] Checked subtask status after dispatch"
echo "    [+] Called complete_task with summary"
echo ""
echo "  dependency-order:"
echo "    [+] Dispatched tasks in correct order (migration -> middleware -> router)"
echo "    [+] Waited for each task to complete before dispatching dependent task"
echo "    [+] Called complete_task with summary"
echo ""
echo "  failure-recovery:"
echo "    [+] Detected failed subtask via get_task_details"
echo "    [+] Either retried with corrections OR escalated via request_human_input"
echo "    [+] Did not falsely claim success"
echo ""
echo "  analyze-and-fix:"
echo "    [+] Read multiple files to understand codebase"
echo "    [+] Dispatched exactly 1 subtask (not more)"
echo "    [+] Provided reasoning for choice"
echo "    [+] Called complete_task with analysis"
echo ""
echo "Review transcripts for qualitative assessment of dispatch descriptions,"
echo "dependency awareness, and failure handling quality."
