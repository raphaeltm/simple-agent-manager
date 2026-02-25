# Research: Simplified Chat-First UX

**Feature Branch**: `022-simplified-chat-ux`
**Date**: 2026-02-25

## Research Areas

### R1: Single-Action Task Submission

**Decision**: New `POST /api/projects/:projectId/tasks/submit` endpoint that inserts task directly as `queued` status (skipping `draft` and `ready` intermediates), then kicks off `executeTaskRun` via `waitUntil`.

**Rationale**: The current 3-call sequence (create draft → transition to ready → call /run) exists for the task management workflow where tasks may sit in backlog. For the "Run Now" chat flow, intermediate states serve no purpose and create atomicity gaps. A `draft` task orphaned by a failure between calls 1 and 3 is invisible to the stuck-task cron (which only watches `queued`/`delegated`/`in_progress`).

**Alternatives considered**:
- Wrapper that calls existing 3 endpoints sequentially: rejected because atomicity gap remains, and it triplicates validation (project ownership checked 3x).
- Insert as `draft` then transition internally: rejected because if the transition fails after the insert, we have an orphaned draft.

**Key constraint**: The existing `initiateTaskRun` validates `task.status === 'ready'`. The new endpoint must either bypass this check or inline the equivalent logic. Recommendation: inline the synchronous portion of `initiateTaskRun` into the submit handler, calling `executeTaskRun` directly.

---

### R2: Agent Completion Signal and Git Push

**Decision**: When the ACP session ends (agent completes), the VM agent performs git operations (commit + push) while the container is still running, then reports results via the existing task completion callback.

**Rationale**: The VM agent has the container context needed for git operations. Pushing at agent completion time guarantees the container is running. Deferring push to a later timer (DO alarm or cron) risks the container being stopped before the push.

Research confirmed that Cloudflare DO `alarm()` handlers have wall-clock limits (~30s). Orchestrating cross-network git push + PR creation within an alarm handler would exceed this limit on large repos.

**Alternatives considered**:
- DO alarm triggers auto-push after idle timeout: rejected because (1) alarm handler wall-clock limits, (2) workspace may already be stopped, (3) DO single-alarm constraint complicates multi-session management.
- Cron sweep detects idle sessions: rejected because too coarse-grained (cron intervals) and adds a polling pattern instead of event-driven.
- API orchestrates push via HTTP call to VM agent: rejected for the idle-timeout case because workspace may be gone. Acceptable for the agent-completion case where VM agent initiates it locally.

**Implementation**: Add to `SessionHost.OnPromptComplete` (or `monitorProcessExit`):
1. `git status --porcelain` to check for changes
2. If changes: `git add -A && git commit -m "..."` (respecting .gitignore)
3. `git push origin {branch}`
4. Include results in the task completion callback payload

---

### R3: Idle Cleanup Timer

**Decision**: Use ProjectData DO "earliest alarm" pattern for cleanup scheduling only (not git push). The alarm fires 15 minutes after the agent's last message (agent completion signal). When it fires, it calls a lightweight API endpoint that triggers workspace cleanup.

**Rationale**: The DO alarm is appropriate for a lightweight action (triggering cleanup via an API call). It should NOT orchestrate multi-step git/GitHub operations. The "earliest alarm" pattern handles the CF DO single-alarm constraint by scheduling for the soonest-expiring session.

**Key design**: The idle timer starts when the agent completion callback is received (not based on message timestamps). This avoids false positives where the user is active in the terminal but not chatting. The timer resets if the user sends a follow-up message.

**References**:
- NodeLifecycle DO alarm pattern: `apps/api/src/durable-objects/node-lifecycle.ts` (lines 72, 96, 127, 153-192)
- `SESSION_IDLE_TIMEOUT_MINUTES` env var already declared but unused (wrangler.toml)
- GitHub Codespaces uses 30-min default idle timeout ([docs](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle))
- Google Cloud Workstations idle detection based on active connections ([blog](https://oneuptime.com/blog/post/2026-02-17-how-to-configure-idle-timeout-and-auto-stop-policies-to-reduce-google-cloud-workstation-costs/view))

---

### R4: GH_TOKEN Refresh for Long-Running Sessions

**Decision**: Shell wrapper script for `gh` CLI that fetches a fresh token via the existing `git-credential-sam` helper before each invocation. Installed by the bootstrap process post-build.

**Rationale**: GitHub App installation tokens expire after 1 hour and cannot be refreshed — a new token must be generated ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)). The existing `git-credential-sam` helper already fetches fresh tokens for every git operation by calling back to the VM agent, which calls the control plane. The wrapper extends this mechanism to `gh` CLI.

**Implementation**:
```sh
#!/bin/sh
# /usr/local/bin/gh-sam-wrapper
export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)
exec /usr/local/bin/gh.real "$@"
```

Installed by `ensureGitCredentialHelper` in bootstrap.go (runs after devcontainer build):
1. Check if `/usr/local/bin/gh` exists in the container
2. If yes: move to `gh.real`, install wrapper as `gh`
3. If `gh` is at a different path (e.g., `/usr/bin/gh`): adjust paths accordingly

**Alternatives considered**:
- Background token refresh daemon: rejected — too invasive, requires running additional processes in the user's container.
- Modify ACP session to inject fresh tokens: rejected — env vars are baked in at `docker exec` invocation time, can't be updated mid-process.
- Token file that gets refreshed: rejected — `gh` doesn't support reading GH_TOKEN from a file natively.

**References**:
- [GitHub App Token Refresh Pattern](https://github.com/cvega/githubapp-token-refresh)
- [GitHub Best Practices for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)

---

### R5: Ensuring gh CLI Availability in Custom Devcontainers

**Decision**: Post-build installation check. After `devcontainer up` completes, the bootstrap checks if `gh` exists in the container. If not, install it via `docker exec`.

**Rationale**: Blanket injection via `--additional-features` is unsafe for custom devcontainer configs because (1) it can conflict with pinned versions, (2) it doesn't work with Docker Compose-based configs, (3) minimal images may not support the feature's dependencies.

**Implementation**: Add `ensureGitHubCLI` step in `PrepareWorkspace` (after `ensureDevcontainerReady`):
1. `docker exec <container> which gh` — check if gh exists
2. If not found: install via the official install script for the detected OS (Debian/Alpine/etc.)
3. Log the result

**Alternatives considered**:
- Always pass `--additional-features` with github-cli: rejected due to breaking changes for repos with pinned versions, Compose-based configs, or minimal images.
- Require users to include gh in their devcontainer: rejected — platform should ensure its own tooling works.

**References**:
- [Devcontainer Features](https://containers.dev/features)
- [Adding Features to devcontainer.json](https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/configuring-dev-containers/adding-features-to-a-devcontainer-file)

---

### R6: Branch Name Generation

**Decision**: Server-side slugification with task ID suffix for guaranteed uniqueness. Format: `sam/{slug}-{short-task-id}`.

**Rationale**: Pure slugification has a TOCTOU race condition — two concurrent tasks with similar titles can both generate the same branch name, both check GitHub and find no collision, then collide on push. Appending a short task ID (first 6 chars of the ULID) guarantees uniqueness without network checks.

**Algorithm**:
1. Lowercase the message text
2. Remove non-alphanumeric characters (except spaces, hyphens)
3. Filter stop words
4. Take first 3-4 meaningful words
5. Join with hyphens
6. Append `-{first 6 chars of task ID}`
7. Prefix with configurable prefix (default: `sam/`)
8. Truncate to configurable max length (default: 60 chars)

Example: "Add dark mode toggle to settings" with task ID `01JK9M2X4N` → `sam/add-dark-mode-toggle-01jk9m`

**Alternatives considered**:
- LLM-based summarization: rejected — adds latency, cost, and an external dependency at task creation time.
- Pure `task/{taskId}`: rejected by spec — user wants human-readable names.
- Pure slugification with deduplication check: rejected due to TOCTOU race condition.

**References**:
- [Git Branch Naming Best Practices](https://www.tilburgsciencehub.com/topics/automation/version-control/advanced-git/naming-git-branches/)
- [Graphite Guide](https://graphite.dev/guides/git-branch-naming-conventions)

---

### R7: Session State Derivation

**Decision**: Derive `isIdle` at query time from timestamps. Do not add `idle` to the `ChatSessionStatus` enum.

**Rationale**: Adding `idle` as a stored state requires synchronization between the VM agent (which knows the agent status) and the DO (which stores the session state). This creates race conditions and ordering issues. Computing `isIdle` at read time is simpler, always consistent, and requires no schema changes.

**Implementation**: API response for sessions includes computed fields:
- `isIdle: boolean` — true when `(now - updatedAt) > idleThreshold` and session is `active`
- `isTerminated: boolean` — true when session is `stopped` (workspace cleaned up)

Frontend uses these for visual styling (green = active, amber = idle, gray = terminated).

---

### R8: User Message Relay for Active Sessions

**Decision**: Browser establishes a direct WebSocket connection to the VM agent when viewing an active session from the project chat page. Messages flow bidirectionally through this WebSocket, same as the current workspace page chat.

**Rationale**: The existing architecture (spec 021) deliberately moved message persistence to the VM agent side. Adding an HTTP relay from the browser through the API back to the VM agent would reverse this decision, introduce ordering issues (no guaranteed delivery order for concurrent HTTP POSTs), and create persist-but-not-relay failures.

**Implementation**: When `ProjectMessageView` detects the session is active and has a `workspaceId`:
1. Establish WebSocket to `wss://ws-{workspaceId}.${BASE_DOMAIN}/acp/{sessionId}` (authenticated with workspace JWT)
2. User messages flow through this WebSocket to the ACP session
3. Agent responses flow back through the same WebSocket AND through the existing persistence pipeline (VM agent → API → DO → broadcast)
4. When the workspace is stopped (session terminated), the WebSocket closes and the input is disabled

**Alternatives considered**:
- API HTTP relay: rejected due to ordering issues, persist-but-not-relay risk, and reversal of spec 021 architecture.
- WebSocket proxy through the API: rejected — Cloudflare Workers have WebSocket limitations for long-lived proxying; direct connection is simpler and more reliable.

---

### R9: Git Identity Fallback

**Decision**: Use GitHub's noreply email format: `{github_id}+{name}@users.noreply.github.com`.

**Rationale**: The initial proposal used SAM's ULID-based `userId`, which doesn't link to GitHub profiles. GitHub's actual noreply format uses the numeric GitHub ID, which is stored in the `users.githubId` column.

**Implementation**: In `ensureGitIdentity` (bootstrap.go), when `gitUserEmail` is empty:
- Fallback to `{githubId}+{sanitized-name}@users.noreply.github.com`
- Requires passing `githubId` to the workspace creation flow (add to `createWorkspaceOnNode` payload)

---

### R10: Finalization Guard

**Decision**: Add `finalizedAt` timestamp field to the tasks table. Set on first successful git push + PR creation. Skip finalization if already set.

**Rationale**: Without a guard, the agent completion push (Decision 2) and idle cleanup (Decision 3) could both trigger finalization. A timestamp field makes the operation idempotent.

**Implementation**: Before executing git push or PR creation, check `task.finalizedAt`. If non-null, skip. After successful push + PR, set `finalizedAt = now`.
