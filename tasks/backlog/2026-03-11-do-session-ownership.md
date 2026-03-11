# DO-Owned ACP Session Lifecycle

**Created**: 2026-03-11
**Spec**: `specs/027-do-session-ownership/spec.md`
**Branch**: `027-do-session-ownership`

## Problem

ACP sessions are currently owned by VM agents (in-memory Go maps). If a VM dies, session state is lost. This prevents multi-VM orchestration, session continuity after VM death, and reliable session state tracking.

## What Needs to Happen

Shift ACP session ownership from VM agents to ProjectData Durable Objects:

- [ ] Run `/speckit.plan` to generate implementation plan from the spec
- [ ] Run `/speckit.tasks` to generate task breakdown
- [ ] Implement DO-owned session state machine (pending → assigned → running → completed/failed/interrupted)
- [ ] Enforce workspace-project binding for ACP sessions
- [ ] Add VM failure detection → session interruption flow
- [ ] Implement session forking (new ACP session with context from original when VM is gone)
- [ ] Simplify VM agent to executor role (remove state machine ownership, add reconciliation on restart)
- [ ] Add `parentSessionId` to session data model for future sub-agent orchestration
- [ ] Update UI to show session states (running, completed, interrupted, forked) and fork lineage
- [ ] Verify PTY sessions remain unaffected (VM-agent owned, no DO involvement)

## Key Design Decisions

- **DO is source of truth** for all ACP session state. VM agent is an executor.
- **No ACP history injection** — continuing a session on a new VM means forking with a context summary, not replaying history. The UI must clearly show this.
- **PTY sessions unchanged** — interactive terminal remains VM-agent owned.
- **Bare workspaces still allowed** — but cannot run ACP sessions without a project.

## Context

This emerged from architectural discussion about whether VM agent or DO should own ACP sessions. The multi-VM orchestration future (subtasks, sub-agents via MCP) makes DO ownership the clear choice — no single VM can orchestrate across machines. See spec for full rationale.
