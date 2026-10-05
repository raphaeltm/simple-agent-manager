# Simplify Shared Packages

> **Reconciliation 2026-10-05:** #2225 (9ef726c20) deleted the unused `AGENT_PERMISSION_MODE_DESCRIPTIONS`. Only `AGENT_PERMISSION_MODE_LABELS` remains (`packages/shared/src/constants/agent-settings.ts:24-30`), so the labels/descriptions merge is done. Still open:
>
> - Move the computed `isIdle`, `isTerminated` and `workspaceUrl` out of the API response type (`packages/shared/src/types/session.ts:23-27`).
> - Decide `toolMetadata`: `z.string()` at `vm-agent-contract.ts:202` vs a Record at `types/session.ts:62`.
> - Remove the `HETZNER_IMAGE` alias (`constants/hetzner.ts:20-21`).
> - Remove the positional-args overload (`packages/acp-client/src/transport/websocket.ts:91-128`).

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - `types.ts` split into `packages/shared/src/types/*` with a barrel (PR #588, e5d155c7e).
>   - Hetzner no longer inlines cloud-init; it passes `config.userData`
>     (`packages/providers/src/hetzner-server-create.ts:207`; 714ebee9b).
>   - `serverSessionId` is on the terminal session type
>     (`packages/terminal/src/types/multi-terminal.ts:43`); no `as any` left in the package.
> - **Still open:**
>   - Move computed `isIdle`, `isTerminated` and `workspaceUrl` out of the API response type
>     (`packages/shared/src/types/session.ts:22-27`).
>   - Decide on `toolMetadata`: `z.string()` in `vm-agent-contract.ts:193` vs a Record in
>     `session.ts:62` (possibly an intentional wire-vs-parsed split; document it either way).
>   - Remove the unused `HETZNER_IMAGE` alias (`constants/hetzner.ts:20-21`) and the
>     positional-args overload in `packages/acp-client/src/transport/websocket.ts:94-115`; merge
>     `AGENT_PERMISSION_MODE_LABELS`/`_DESCRIPTIONS` (`constants/agent-settings.ts:12,21`).
> - **Moot/dropped:** the Tokyo Night palette dedupe; `semantic-tokens.ts` was deleted in PR #1239
>   (0c3f3e3be).

**Status:** backlog
**Priority:** medium
**Estimated Effort:** 3 days
**Created:** 2026-03-03

## Problem Statement

The shared packages (`packages/shared/`, `providers/`, `cloud-init/`, `terminal/`, `ui/`, `acp-client/`) contain several complexity issues that affect the entire codebase:

- `packages/shared/src/types.ts` is 1,134 lines with 50+ type definitions and no logical grouping — difficult to navigate
- Overlapping types without clear differentiation (`ProjectSummary` vs `ProjectDetail` vs `ProjectDetailResponse`)
- Computed client-side properties (`isIdle`, `isTerminated`) mixed into API response types
- 6 scattered status enums with inconsistent naming patterns
- `packages/terminal/src/useTerminalSessions.ts` (359 lines) has a type casting hack (`as any` for `serverSessionId`)
- `packages/terminal/src/MultiTerminal.tsx` (250+ lines) has deep closure chains and potential memory leaks
- `packages/providers/src/hetzner.ts` has a 120-line cloud-init template duplicating `packages/cloud-init/`
- `packages/ui/src/tokens/semantic-tokens.ts` duplicates Tokyo Night palette 3 times across modes
- `packages/acp-client/src/transport/websocket.ts` uses duck-typing to support backward-compatible overload
- `packages/shared/src/constants.ts` has duplicate aliases (`HETZNER_IMAGE` duplicates `DEFAULT_HETZNER_IMAGE`)
- `vm-agent-contract.ts` has type mismatch: `toolMetadata` is `z.string()` in Zod but `Record<string, unknown>` in types.ts

## Acceptance Criteria

- [ ] Split `packages/shared/src/types.ts` into semantic modules:
  - `types/user.ts` — User, AdminUser, UserRole, UserStatus
  - `types/project.ts` — Project, ProjectSummary, ProjectDetail variants
  - `types/task.ts` — Task, TaskStatus, TaskDependency, TaskStatusEvent, execution steps
  - `types/workspace.ts` — Workspace, Node, AgentSession, etc.
  - `types/chat.ts` — ChatSession, ChatMessage
  - Keep `types.ts` as barrel re-export for backward compatibility
- [ ] Remove computed client-side properties from API response types — move `isIdle`, `isTerminated`, `workspaceUrl` to web-only utility
- [ ] Fix `toolMetadata` type mismatch between `vm-agent-contract.ts` (Zod string) and `types.ts` (Record)
- [ ] Remove duplicate constant aliases in `constants.ts`
- [ ] Fix `useTerminalSessions.ts` type hack — add `serverSessionId` to `TerminalSession` type properly
- [ ] Extract Tokyo Night base palette in `semantic-tokens.ts` — share across all 3 mode variants
- [ ] Clean up `acp-client/transport/websocket.ts` — remove backward-compatible positional args overload, use options object only
- [ ] Remove parallel config objects in `constants.ts` — merge `AGENT_PERMISSION_MODE_LABELS` and `AGENT_PERMISSION_MODE_DESCRIPTIONS` into single Record
- [ ] Move cloud-init template logic in `providers/hetzner.ts` to use `packages/cloud-init/` instead of inline string
- [ ] All packages build and tests pass after changes

## Key Files

- `packages/shared/src/types.ts` (1,134 lines)
- `packages/shared/src/constants.ts` (228 lines)
- `packages/shared/src/vm-agent-contract.ts` (235 lines)
- `packages/terminal/src/useTerminalSessions.ts` (359 lines)
- `packages/terminal/src/MultiTerminal.tsx` (250+ lines)
- `packages/providers/src/hetzner.ts` (310 lines)
- `packages/ui/src/tokens/semantic-tokens.ts` (236 lines)
- `packages/acp-client/src/transport/websocket.ts`

## Approach

1. Split types.ts first — most impactful, affects all consumers
2. Fix type mismatches and remove duplicates — quick wins
3. Clean up terminal package — fix type hack and memory leak potential
4. UI token deduplication — low risk
5. Run `pnpm build && pnpm typecheck && pnpm test` after each change
