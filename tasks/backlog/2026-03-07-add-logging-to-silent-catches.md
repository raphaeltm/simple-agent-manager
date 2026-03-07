# Add Logging to Silent Error Catches

## Problem

The codebase has numerous `.catch(() => {})` and `catch { }` blocks that silently swallow errors with no logging. When these operations fail systematically (e.g., cleanup not running, sessions stuck, containers orphaned), there is zero signal to operators. Things "fall through the cracks" invisibly.

## Research Findings

Audit found 6 critical, 7 high-severity, and 6+ medium-severity silent catch patterns.

### Critical (resource leaks, invisible to operators)
- `task-submit.ts:286`, `task-runs.ts:260` — orphaned session stop `.catch(() => {})`
- `tasks.ts:827` — `cleanupTaskRun` fire-and-forget (workspace/node never cleaned up)
- `tasks.ts:634,819` — session stop IIFE `.catch(() => {})` (chat session stuck active)
- `workspaces.ts:829-833` — `deleteWorkspaceOnNode` catch (container orphaned on VM)
- `workspaces.ts:1030-1032,1088-1092` — agent session stop/suspend catch (agent process orphaned)

### High (broken UX, invisible misconfiguration)
- `project-data.ts:821-823` — DO notification insert catch (SQLite errors invisible)
- `nodes.ts:687`, `client-errors.ts:150` — observability persistence double-silent catch

### Medium (degraded functionality, hard to diagnose)
- `auth.ts:95-97` — optional auth catch (auth outage looks like no-auth)
- `workspaces.ts:652,712,766` — activity event recording catch
- `tasks.ts:618,723,801` — task activity event recording catch

## Implementation

- [x] Add `console.error` with context to all critical silent catches in API
- [x] Add `console.warn` to high and medium-severity silent catches in API
- [x] Add `console.warn` to key frontend silent catches
- [x] Run typecheck, lint, test, build

## Acceptance Criteria

- [ ] Every previously-silent catch in the API logs the error with enough context to identify the failing operation
- [ ] Logging uses `console.error` for critical operations, `console.warn` for best-effort operations
- [ ] No changes to control flow — all operations remain best-effort where they were before
- [ ] All quality gates pass
