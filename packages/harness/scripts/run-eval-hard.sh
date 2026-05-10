#!/usr/bin/env bash
# run-eval-hard.sh — Run harder eval tasks designed to stress-test turn efficiency.
#
# Same environment variables as run-eval-real.sh:
#   SAM_AI_PROXY_URL  — AI Gateway URL (required)
#   SAM_AI_PROXY_KEY  — API key / CF token for auth (required)
#   SAM_AI_MODEL      — Model name (required)
#   SAM_AI_AUTH_HEADER — Custom auth header (e.g. cf-aig-authorization)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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
AUTH_HEADER_FLAG=""
if [ -n "$AUTH_HEADER" ]; then
  AUTH_HEADER_FLAG="--auth-header $AUTH_HEADER"
fi

echo "============================================"
echo "  SAM Harness HARD Eval Suite"
echo "============================================"
echo "  Proxy URL:    ${SAM_AI_PROXY_URL}"
echo "  Model:        ${MODEL}"
echo "  Auth Header:  ${AUTH_HEADER:-Authorization (default)}"
echo "  Time:         $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# Build the eval runner
cd "$HARNESS_DIR"
go build -o /tmp/harness-eval-runner ./cmd/harness/ 2>/dev/null || true

# Hard tasks — these require reading 3+ files and cross-referencing
declare -a TASKS=(
  "cross-file-bug|The tests in orders_test.go are failing. The bug is NOT in the test — the tests are correct. Read ALL source files (types.go, pricing.go, orders.go) to find and fix the bug. The issue involves function arguments being passed in the wrong order somewhere.|cross-ref-bug"
  "data-flow-trace|Trace the data flow for task status updates in this project. The flow goes: api/handlers.go -> util/validate.go -> store/tasks.go -> store/events.go. There is a missing validation: when UpdateTaskStatus is called, it should reject updates where the actor is empty string. Add this validation in the appropriate layer (util/validate.go) and update the test file (api/handlers_test.go) to cover this case.|dataflow-project"
  "multi-pkg-refactor|Rename the type TaskStatus to State and all its constants (TaskStatusPending -> StatePending, TaskStatusActive -> StateActive, TaskStatusCompleted -> StateCompleted, TaskStatusCancelled -> StateCancelled) across ALL files in this project. The type is defined in models/task.go but used in models/event.go, store/tasks.go, util/validate.go, api/handlers.go, and api/handlers_test.go. Update every reference.|dataflow-project"
)

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=${#TASKS[@]}

printf "\n%-25s %-8s %-8s %-10s\n" "TASK" "STATUS" "TURNS" "DURATION"
printf "%-25s %-8s %-8s %-10s\n" "-------------------------" "--------" "--------" "----------"

for task_spec in "${TASKS[@]}"; do
  IFS='|' read -r TASK_NAME PROMPT FIXTURE <<< "$task_spec"

  WORK_DIR=$(mktemp -d)
  cp -r "$HARNESS_DIR/testdata/$FIXTURE/"* "$WORK_DIR/"

  # Init git repo for all hard tasks (they may need git operations)
  (cd "$WORK_DIR" && git init -q && git config user.email "eval@test" && git config user.name "Eval" && git add . && git commit -q -m "initial") 2>/dev/null

  TRANSCRIPT="/tmp/harness-hard-${TASK_NAME}.json"
  START_TIME=$(date +%s)

  set +e
  OUTPUT=$(timeout 180 /tmp/harness-eval-runner \
    --dir "$WORK_DIR" \
    --prompt "$(echo -e "$PROMPT")" \
    --transcript "$TRANSCRIPT" \
    --provider openai \
    --api-url "$SAM_AI_PROXY_URL" \
    --api-key "$SAM_AI_PROXY_KEY" \
    --model "$MODEL" \
    $AUTH_HEADER_FLAG \
    --max-turns 20 2>&1)
  EXIT_CODE=$?
  set -e

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  TURNS="?"
  if [ -f "$TRANSCRIPT" ]; then
    TURNS=$(jq '[.[] | select(.type == "llm_request")] | length' "$TRANSCRIPT" 2>/dev/null || echo "?")
  fi

  if [ $EXIT_CODE -eq 0 ]; then
    STATUS="PASS"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    STATUS="FAIL"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  printf "%-25s %-8s %-8s %-10s\n" "$TASK_NAME" "$STATUS" "$TURNS" "${DURATION}s"

  rm -rf "$WORK_DIR"
done

echo ""
echo "============================================"
echo "  Results: ${PASS_COUNT}/${TOTAL} passed, ${FAIL_COUNT} failed"
echo "============================================"

if [ $FAIL_COUNT -gt 0 ]; then
  echo ""
  echo "Transcript files saved to /tmp/harness-hard-*.json"
  echo "Review failed task transcripts for details."
  exit 1
fi
