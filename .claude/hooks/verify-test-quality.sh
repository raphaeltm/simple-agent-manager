#!/bin/bash
# verify-test-quality.sh — Stop hook for both Claude Code and Codex
#
# Detects cross-boundary source file changes and verifies that corresponding
# vertical slice tests exist with realistic mock state. Blocks completion if
# tests are missing or obviously shallow.
#
# Exit codes:
#   0 + {"decision":"approve"}  — pass (no cross-boundary changes, or tests look good)
#   0 + {"decision":"block"}    — fail (missing or shallow tests detected)

set -euo pipefail

# Read hook input from stdin (contains stop_hook_active flag)
INPUT=$(cat /dev/stdin 2>/dev/null || echo '{}')

# Guard against infinite loops — if we're already in a forced continuation, pass
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Get modified files (staged + unstaged relative to HEAD)
CHANGED=$(git diff --name-only HEAD 2>/dev/null || git diff --cached --name-only 2>/dev/null || echo "")

if [ -z "$CHANGED" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Identify cross-boundary source files (not test files themselves)
BOUNDARY_FILES=$(echo "$CHANGED" | grep -E "(routes/|durable-objects/|services/|hooks/use.*\.ts$)" | grep -vE "\.(test|spec)\.(ts|tsx)$" | grep -vE "node_modules" || true)

if [ -z "$BOUNDARY_FILES" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# For each boundary file, check if a corresponding test exists
MISSING_TESTS=""
SHALLOW_TESTS=""

for SRC_FILE in $BOUNDARY_FILES; do
  # Derive expected test file locations
  BASENAME=$(basename "$SRC_FILE" | sed 's/\.\(ts\|tsx\)$//')
  DIR=$(dirname "$SRC_FILE")

  # Search for test files matching this source
  TEST_FILE=$(find . -path "*/tests/*" -name "*${BASENAME}*" \( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" \) 2>/dev/null | head -1)

  if [ -z "$TEST_FILE" ]; then
    # Also check co-located tests
    TEST_FILE=$(find . -path "*${DIR}*" -name "*${BASENAME}*.test.*" 2>/dev/null | head -1)
  fi

  if [ -z "$TEST_FILE" ]; then
    MISSING_TESTS="${MISSING_TESTS}\n  - ${SRC_FILE} (no test file found)"
    continue
  fi

  # Check for shallow mock patterns (empty objects, minimal stubs)
  SHALLOW_PATTERNS=$(grep -cE "mockResolvedValue\(\s*\{\}\s*\)|mockReturnValue\(\s*\{\}\s*\)|as unknown as \{\}" "$TEST_FILE" 2>/dev/null || true)
  SHALLOW_PATTERNS=${SHALLOW_PATTERNS:-0}
  REALISTIC_PATTERNS=$(grep -cE "mockResolvedValue\(\s*\{[[:space:]]*[a-z]|toArray|createMock|makeFake|createTest|factory|fixture" "$TEST_FILE" 2>/dev/null || true)
  REALISTIC_PATTERNS=${REALISTIC_PATTERNS:-0}

  # If we find empty mocks and no realistic patterns, flag it
  if [ "$SHALLOW_PATTERNS" -gt 2 ] && [ "$REALISTIC_PATTERNS" -eq 0 ]; then
    SHALLOW_TESTS="${SHALLOW_TESTS}\n  - ${TEST_FILE} (${SHALLOW_PATTERNS} empty mock patterns, 0 realistic patterns)"
  fi
done

# Build result
if [ -n "$MISSING_TESTS" ] || [ -n "$SHALLOW_TESTS" ]; then
  REASON="Cross-boundary test quality gate failed."
  if [ -n "$MISSING_TESTS" ]; then
    REASON="${REASON}\n\nMissing tests for boundary files:${MISSING_TESTS}"
  fi
  if [ -n "$SHALLOW_TESTS" ]; then
    REASON="${REASON}\n\nShallow tests detected (empty mocks, no realistic state):${SHALLOW_TESTS}"
  fi
  REASON="${REASON}\n\nWrite vertical slice tests that mock at system boundaries with realistic state. See .claude/rules/35-vertical-slice-testing.md."

  # Escape for JSON
  REASON_JSON=$(echo -e "$REASON" | jq -Rs .)

  echo "{\"decision\":\"block\",\"reason\":${REASON_JSON}}"
  exit 0
fi

echo '{"decision":"approve"}'
exit 0
