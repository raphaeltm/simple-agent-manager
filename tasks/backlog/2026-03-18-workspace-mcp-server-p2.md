# Workspace-Aware MCP Server — Priority 2 (Extended Tools)

**Created**: 2026-03-18
**Depends on**: `tasks/backlog/2026-03-18-workspace-mcp-server-p1.md` (server scaffold and core tools must exist first)
**Context**: Second batch of workspace MCP tools. These are useful but less urgent — they enhance agent intelligence, enable advanced workflows, and improve the developer experience.

## Implementation Checklist

### A) Advanced self-awareness tools

- [ ] `get_agent_capabilities` — returns which MCP servers are connected, what model is running, auth type (API key vs OAuth), available tool count. Agent self-awareness for deciding approach.
- [ ] `get_project_conventions` — returns structured summary of project setup: test framework, linter, formatter, language versions, key patterns from CLAUDE.md. Faster than parsing a long markdown file.
- [ ] `get_connected_services` — discovers external services accessible from the workspace (databases, APIs, their endpoints). Derived from env vars, Docker Compose, or service discovery.

### B) Advanced multi-agent tools

- [ ] `share_artifact` — publish a named key-value artifact (test results, analysis, benchmark data) visible to peer agents on the same project. Structured inter-agent communication faster than git.
- [ ] `annotate_workspace` — leave persistent notes attached to the workspace for the next session. Workspace hand-off context that survives session restart.
- [ ] `get_branch_conflicts` — checks if the current branch has merge conflicts with other active branches in the project. Pre-emptive conflict detection.
- [ ] `transfer_to_specialist` — request hand-off to a different agent type (security, UI, Go specialist). Platform provisions a specialist session on the same workspace or a linked one.

### C) Historical learning tools

- [ ] `get_similar_past_tasks` — finds completed tasks with similar descriptions, returns their branches, PRs, approach summaries. Learn from history instead of solving the same problem differently each time.
- [ ] `get_pr_review_feedback` — fetches PR review comments for the current branch's PR. Agent can read and respond to review feedback programmatically.

### D) Advanced project awareness tools

- [ ] `get_project_context` — returns project settings, default VM size, active task count, recent activity summary. Broader situational awareness beyond current task.
- [ ] `get_project_secret` — retrieve a project-level secret by name (rate-limited, audited). Access secrets that shouldn't live in env vars permanently.

### E) Advanced observability tools

- [ ] `report_progress_metrics` — structured progress update with quantitative data (% complete, files changed, tests passing/failing, lines added/removed). Dashboard can show progress bars and test counts.
- [ ] `get_workspace_logs` — filtered system/VM-agent logs by time range. Not container stdout (agent has that), but boot logs, networking events, VM agent lifecycle events.

### F) Workspace lifecycle tools

- [ ] `request_larger_vm` — signals current resources are insufficient, suggests a VM size. Self-healing when agent detects OOM or slow builds.
- [ ] `request_workspace_extension` — extends warm pool timeout or prevents workspace recycle. Agent is mid-work and knows it needs more time.
- [ ] `check_warm_pool_status` — returns whether this node is warm-pooled, time until recycle, whether extension is possible.
- [ ] `create_checkpoint` — tags current workspace state (git stash + metadata) as a named rollback point. Lighter than a full snapshot, useful before risky operations.
- [ ] `get_workspace_diff_summary` — all changes since workspace creation, organized by area, for hand-off to another agent.

### G) Testing

- [ ] Unit tests for each new tool handler
- [ ] Integration tests for tools that interact with external services (share_artifact, get_project_secret)
- [ ] Test that `share_artifact` + `get_peer_agent_output` work together (write artifact from one session, read from another)

## Acceptance Criteria

- [ ] All tools listed above are implemented and return structured JSON
- [ ] `share_artifact` persists artifacts accessible across sessions on the same project
- [ ] `get_similar_past_tasks` returns relevant results based on description similarity
- [ ] `transfer_to_specialist` creates a linked session with specialist context
- [ ] `request_larger_vm` signals the control plane and reports result to agent
- [ ] `create_checkpoint` creates a recoverable state marker
- [ ] Unit tests for all tool handlers
- [ ] Integration tests for cross-session tools

## References

- `tasks/backlog/2026-03-18-workspace-mcp-server-p1.md` — prerequisite (server scaffold + core tools)
- `apps/api/src/routes/mcp.ts` — existing SAM MCP server
- `packages/vm-agent/internal/server/` — VM agent HTTP API
- `apps/api/src/services/project-data.ts` — control plane data access
