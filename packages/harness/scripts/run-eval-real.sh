#!/usr/bin/env bash
# run-eval-real.sh — Run harness eval tasks against a real LLM via SAM AI Gateway.
#
# This script is for MANUAL validation only — it is NOT run in CI.
# It builds a small Go program that uses the real OpenAI-compatible provider
# to exercise the same eval scenarios as the mock-based tests.
#
# Environment variables:
#   SAM_AI_PROXY_URL  — AI Gateway URL (required)
#   SAM_AI_PROXY_KEY  — API key / CF token for auth (required)
#   SAM_AI_MODEL      — Model name (default: @cf/google/gemma-3-27b-it)
#
# Usage:
#   export SAM_AI_PROXY_URL="https://api.sammy.party/api/ai/proxy/openai/v1"
#   export SAM_AI_PROXY_KEY="your-api-key"
#   ./scripts/run-eval-real.sh
#
# Output: structured results table (task, status, turns, duration)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Validate required env vars
if [ -z "${SAM_AI_PROXY_URL:-}" ]; then
  echo "ERROR: SAM_AI_PROXY_URL is required"
  echo "  Example: https://api.sammy.party/api/ai/proxy/openai/v1"
  exit 1
fi

if [ -z "${SAM_AI_PROXY_KEY:-}" ]; then
  echo "ERROR: SAM_AI_PROXY_KEY is required"
  exit 1
fi

MODEL="${SAM_AI_MODEL:-@cf/google/gemma-3-27b-it}"

echo "============================================"
echo "  SAM Harness Real Model Evaluation"
echo "============================================"
echo "  Proxy URL: ${SAM_AI_PROXY_URL}"
echo "  Model:     ${MODEL}"
echo "  Time:      $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# Build the eval runner
cd "$HARNESS_DIR"
go build -o /tmp/harness-eval-runner ./cmd/harness/ 2>/dev/null || true

# Define eval tasks as (name, prompt, fixture_dir) tuples
declare -a TASKS=(
  "bug-fix|Diagnose and fix this failing test:\n\n--- FAIL: TestAbs (0.00s)\n    mathutil_test.go:15: Abs(-3) = -3, want 3\n    mathutil_test.go:15: Abs(-100) = -100, want 100\nFAIL|buggy-project"
  "multi-file-rename|Rename the function ComputeSum to Add across all Go files in this project. Update the definition, all callers, and all tests.|multi-file-project"
  "codebase-navigation|Which file in this project handles password hashing? Answer with the file path.|large-project"
  "test-diagnosis|Diagnose why this test fails and explain the root cause:\n\n--- FAIL: TestAbs (0.00s)\n    mathutil_test.go:15: Abs(-3) = -3, want 3\nFAIL\n\nRead the test file and implementation, then explain the bug.|buggy-project"
  "refactor-export|Export the unexported function 'reverse' as 'Reverse' in stringutil.go. Update all call sites and tests. Then create a git commit with a descriptive message.|refactor-project"
)

# Results tracking
PASS_COUNT=0
FAIL_COUNT=0
TOTAL=${#TASKS[@]}

printf "\n%-25s %-8s %-8s %-10s\n" "TASK" "STATUS" "TURNS" "DURATION"
printf "%-25s %-8s %-8s %-10s\n" "-------------------------" "--------" "--------" "----------"

for task_spec in "${TASKS[@]}"; do
  IFS='|' read -r TASK_NAME PROMPT FIXTURE <<< "$task_spec"

  # Prepare isolated working directory
  WORK_DIR=$(mktemp -d)
  cp -r "$HARNESS_DIR/testdata/$FIXTURE/"* "$WORK_DIR/"

  # For refactor task, init a git repo
  if [ "$FIXTURE" = "refactor-project" ]; then
    (cd "$WORK_DIR" && git init -q && git config user.email "eval@test" && git config user.name "Eval" && git add . && git commit -q -m "initial") 2>/dev/null
  fi

  TRANSCRIPT="/tmp/harness-eval-${TASK_NAME}.json"
  START_TIME=$(date +%s)

  # Run the harness CLI against the real model
  set +e
  OUTPUT=$(timeout 120 /tmp/harness-eval-runner \
    --dir "$WORK_DIR" \
    --prompt "$(echo -e "$PROMPT")" \
    --transcript "$TRANSCRIPT" \
    --provider openai \
    --api-url "$SAM_AI_PROXY_URL" \
    --api-key "$SAM_AI_PROXY_KEY" \
    --model "$MODEL" \
    --max-turns 15 2>&1)
  EXIT_CODE=$?
  set -e

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  # Extract turns from transcript if available
  TURNS="?"
  if [ -f "$TRANSCRIPT" ]; then
    TURNS=$(grep -c '"type":"llm_request"' "$TRANSCRIPT" 2>/dev/null || echo "?")
  fi

  if [ $EXIT_CODE -eq 0 ]; then
    STATUS="PASS"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    STATUS="FAIL"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  printf "%-25s %-8s %-8s %-10s\n" "$TASK_NAME" "$STATUS" "$TURNS" "${DURATION}s"

  # Cleanup
  rm -rf "$WORK_DIR"
done

echo ""
echo "============================================"
echo "  Results: ${PASS_COUNT}/${TOTAL} passed, ${FAIL_COUNT} failed"
echo "============================================"

if [ $FAIL_COUNT -gt 0 ]; then
  echo ""
  echo "Transcript files saved to /tmp/harness-eval-*.json"
  echo "Review failed task transcripts for details."
  exit 1
fi
