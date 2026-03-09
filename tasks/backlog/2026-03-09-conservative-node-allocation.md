# Conservative Node Allocation Thresholds

## Problem

Nodes frequently run out of resources because the default allocation thresholds are too aggressive. Multiple tasks starting on the same node consume more resources than expected, leading to resource exhaustion. The system needs to spin up new nodes more frequently rather than packing workspaces onto existing nodes.

## Research Findings

### Current Defaults (in `packages/shared/src/constants.ts`)

| Setting | Current Default | Effect |
|---------|----------------|--------|
| `DEFAULT_MAX_WORKSPACES_PER_NODE` | 10 | Up to 10 workspaces per node |
| `DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT` | 80% | Node considered full only above 80% CPU |
| `DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT` | 80% | Node considered full only above 80% memory |

### Bug: Hardcoded Fallbacks in task-runner.ts

The `findNodeWithCapacity()` method in `apps/api/src/durable-objects/task-runner.ts` uses hardcoded fallback values instead of importing the shared constants:
- CPU threshold: hardcoded `80` (line 1294)
- Memory threshold: hardcoded `85` (line 1297) — doesn't even match the constant (80)!
- Max workspaces: hardcoded `10` (line 1299)

The `node-selector.ts` service correctly imports CPU/memory constants but hardcodes `10` for max workspaces (line 128).

### Key Files

- `packages/shared/src/constants.ts` — default constants
- `apps/api/src/durable-objects/task-runner.ts` — `findNodeWithCapacity()` (lines 1292-1377)
- `apps/api/src/services/node-selector.ts` — `selectNodeForTaskRun()`, `nodeHasCapacity()`

## Implementation Checklist

- [ ] Lower `DEFAULT_MAX_WORKSPACES_PER_NODE` from 10 to 3
- [ ] Lower `DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT` from 80 to 50
- [ ] Lower `DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT` from 80 to 50
- [ ] Fix `task-runner.ts:findNodeWithCapacity()` to import and use shared constants instead of hardcoded values
- [ ] Fix `node-selector.ts` to use `DEFAULT_MAX_WORKSPACES_PER_NODE` constant instead of hardcoded 10
- [ ] Update any existing tests that reference the old default values
- [ ] Run full quality suite (lint, typecheck, test, build)

## Acceptance Criteria

- [ ] Default thresholds are more conservative (max 3 workspaces/node, 50% CPU, 50% memory)
- [ ] All threshold code paths use imported shared constants (no hardcoded fallbacks)
- [ ] All env var overrides still work (existing configurability preserved)
- [ ] Tests pass with new defaults
- [ ] No hardcoded values violating Constitution Principle XI
