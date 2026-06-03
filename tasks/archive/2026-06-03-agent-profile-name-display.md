# Fix Agent Profile Name Display

## Problem

Project chat session headers and related task-display surfaces can show a raw agent profile ULID instead of the human-readable profile name. The shared session type documents `agentProfileHint` as a human-readable label, but task submission stores the resolved profile ID in `tasks.agentProfileHint`. Existing persisted tasks may already contain IDs, while draft tasks can contain free-text hints that are already names.

## Research Findings

- `apps/api/src/routes/chat.ts` builds the chat session task embed from the D1 `tasks` row and currently returns `taskRow.agentProfileHint` directly.
- `apps/web/src/components/project-message-view/SessionHeader.tsx` renders the embed `agentProfileHint` directly in the session header details.
- `apps/api/src/lib/mappers.ts` maps `TaskDetailResponse`/task list responses through `toTaskResponse()` and currently returns the stored hint directly, which can also expose profile IDs in `apps/web/src/pages/ProjectTasks.tsx`.
- `apps/api/src/routes/tasks/submit.ts`, `apps/api/src/services/trigger-submit.ts`, MCP dispatch, and SAM-session dispatch persist resolved profile IDs into `tasks.agentProfileHint`.
- `workspaces.agentProfileHint` is a distinct storage location set from TaskRunner config and used by `apps/api/src/services/github-cli-policy.ts` to look up platform policy by profile ID. This must remain unchanged.
- `tasks/archive/2026-04-29-session-header-agent-info.md` introduced the header display of `agentProfileHint` as task metadata.
- `.claude/rules/02-quality-gates.md` requires regression tests and a task-record post-mortem for bug fixes.

## Implementation Checklist

- [x] Add a small API helper that resolves a task `agentProfileHint` from profile ID to profile name at read time, falling back to the original value when no profile matches.
- [x] Use the helper in `apps/api/src/routes/chat.ts` when building `ChatSessionTaskEmbed`.
- [x] Use the helper for task list/detail mapper surfaces without changing the shared response shape.
- [x] Add regression coverage for chat task embeds resolving a valid profile ID to the profile name.
- [x] Add regression coverage for chat task embeds falling back to the raw hint when no profile matches.
- [x] Add guard coverage that the workspace `agentProfileHint` used by GitHub CLI policy/task-runner startup remains the profile ID.
- [x] Run targeted tests and the required quality suite.
- [x] Verify on staging by creating a task through project chat and confirming the session header details show the profile name, not a ULID.

## Acceptance Criteria

- Session task embeds return a human-readable agent profile name when `tasks.agentProfileHint` contains a valid profile ID.
- Session task embeds preserve unmatched/free-text hints.
- Task display API surfaces such as project tasks/detail consistently return the display name when the stored hint matches an agent profile ID.
- Workspace creation and GitHub CLI policy enforcement continue to receive the profile ID.
- Regression tests cover the resolved-name, fallback, and policy-path guard cases.

## Post-Mortem

### What Broke

The UI rendered `agentProfileHint` exactly as received from the API. The API field was documented and displayed as a human-readable label, but submit/dispatch paths store profile IDs for execution metadata.

### Root Cause

The same generic field name was used for both display metadata and downstream execution/profile lookup. When agent profile selection moved to resolved profile IDs, the read side was not updated to translate the persisted task value back to a display label.

### Process Fix

Add regression tests at the read boundary and a policy-path guard test so future changes must preserve the distinction between task display metadata and workspace policy profile IDs.

## References

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1197
- `packages/shared/src/types/session.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/lib/mappers.ts`
- `apps/api/src/routes/tasks/submit.ts`
- `apps/api/src/services/github-cli-policy.ts`
- `.claude/rules/02-quality-gates.md`
