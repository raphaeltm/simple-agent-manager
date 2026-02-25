# Feature Specification: Simplified Chat-First UX

**Feature Branch**: `022-simplified-chat-ux`
**Created**: 2026-02-25
**Status**: Draft
**Input**: Radically simplify the project page to a chat-first interface. Strip away complexity (kanban, tasks tab, activity, sessions, overview tabs). Users import a project (repo), click on it, and chat with an agent about what they want done. The platform ensures GitHub credentials are properly injected so the agent can push branches, create PRs, and merge when asked.

## Background

The current project page has 7 tabs (Overview, Chat, Kanban, Tasks, Sessions, Settings, Activity), exposing internal complexity like 8 task states, infrastructure provisioning stages, and delegation workflows. This creates cognitive overload for users whose mental model is simple: "I have a repo, I want something done, go do it."

The existing task and chat infrastructure (spec 021) works well under the hood — task creation, node provisioning, workspace creation, agent session management, message streaming, and warm node pooling are all functional. The problem is purely UX: too many surfaces, too many concepts exposed.

This spec simplifies the user-facing experience to match how users actually think about the product: **import a repo → chat about what you want → agent does it**.

### Relationship to Prior Specs

- **Spec 021 (Task-Chat Architecture)**: This spec builds on 021's infrastructure. The task system, chat sessions, message persistence, and autonomous execution all remain unchanged. This spec reshapes the UI layer on top of them.
- **Spec 019 (UI Overhaul)**: The persistent sidebar navigation from 019 remains. This spec supersedes 019's project page tab structure by collapsing it to a single chat view with a settings drawer.

### Existing Infrastructure (No Changes Needed)

- Task state machine (draft → ready → queued → delegated → in_progress → completed/failed/cancelled)
- Node provisioning, warm pooling, and claiming
- Workspace creation during task execution
- Agent session creation and management
- Chat session + message streaming via WebSocket and polling
- Session sidebar component (already exists in current Chat tab)
- GitHub App installation tokens for repo access
- Git credential helper for fresh tokens on every git operation

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chat With a Project (Priority: P1)

A user navigates to a project and immediately sees a chat interface. Previous chat sessions are listed in a sidebar on the left. The most recent session is selected by default. A message input is at the bottom. The user types what they want done (e.g., "Add input validation to the signup form"), hits enter, and the system provisions infrastructure and starts an agent. Messages flow in real-time as the agent works. The user can switch between previous chats in the sidebar to review past work.

**Why this priority**: This is the entire product experience. Everything else exists to support this flow. If this doesn't work, nothing else matters.

**Independent Test**: Navigate to a project, type a task description, verify infrastructure provisions and messages start flowing. Switch between sessions in the sidebar and verify message history loads correctly.

**Acceptance Scenarios**:

1. **Given** a user navigates to a project, **When** the page loads, **Then** they see a chat interface with a session sidebar on the left, a message area in the center, and an input field at the bottom.
2. **Given** a project has existing chat sessions, **When** the page loads, **Then** the most recent session is selected and its messages are displayed.
3. **Given** a project has no chat sessions yet, **When** the page loads, **Then** the user sees an empty state prompting them to start their first chat.
4. **Given** a user types a message and submits it, **When** the system processes the request, **Then** a task is created under the hood, infrastructure provisions, and agent messages begin streaming into the chat within a reasonable time.
5. **Given** an agent is actively working, **When** the user watches the chat, **Then** messages appear in near-real-time without requiring page refresh.
6. **Given** multiple sessions exist in the sidebar, **When** the user clicks a different session, **Then** the message area switches to show that session's history.
7. **Given** a session is linked to a completed task, **When** the user views it, **Then** they can see what was accomplished (branch name, PR link if created) in the session header area.

---

### User Story 2 - Simplified Dashboard (Priority: P1)

A user logs in and sees a clean dashboard showing their projects. Each project card shows the repo name, a brief description, and last activity time. Clicking a project goes directly to the chat interface. An "Import Project" button is prominently available. The dashboard does not show standalone workspaces, nodes, or infrastructure details.

**Why this priority**: The dashboard is the entry point to the entire product. It must communicate the core value proposition — "pick a project, start chatting" — without exposing infrastructure concepts. This is tied to P1 because without a simplified entry point, the simplified chat experience is undermined by a complex landing page.

**Independent Test**: Log in, verify the dashboard shows only projects with a clean card layout. Click a project and verify it navigates directly to the chat interface.

**Acceptance Scenarios**:

1. **Given** a user logs in, **When** the dashboard loads, **Then** they see a list of their projects as cards, each showing project name, repository, and last activity time.
2. **Given** the user has no projects, **When** the dashboard loads, **Then** they see an empty state with a clear call-to-action to import their first project.
3. **Given** the user clicks a project card, **When** the navigation occurs, **Then** they land directly on the project chat interface.
4. **Given** the user clicks "Import Project," **When** the import flow starts, **Then** they can select a GitHub installation and repository, name the project, and complete import with minimal steps.
5. **Given** the dashboard previously showed workspaces, nodes, and onboarding checklists, **When** the simplified dashboard loads, **Then** those elements are not visible (workspaces and nodes are accessible through other navigation paths for power users).

---

### User Story 3 - Project Settings as a Drawer (Priority: P2)

A user is on the project chat page and wants to configure the default VM size or set environment variables. They click a settings gear icon in the project header. A drawer (slide-over panel) opens with project settings: default node size selection, environment variables, and runtime files. The user makes changes, saves, and the drawer closes — all without leaving the chat context.

**Why this priority**: Settings are necessary but secondary to the chat experience. Putting them in a drawer keeps the user in context and avoids a separate page navigation. This is P2 because the chat can function with default settings; configuration is an enhancement.

**Independent Test**: Open the settings drawer from the chat page, change the default node size, add an environment variable, save, close the drawer, and verify settings persist on the next task run.

**Acceptance Scenarios**:

1. **Given** a user is on the project chat page, **When** they click the settings icon in the header, **Then** a drawer slides in from the right showing project settings.
2. **Given** the settings drawer is open, **When** the user selects a default node size (Small/Medium/Large), **Then** the selection is saved and will apply to all future task runs for this project.
3. **Given** the settings drawer is open, **When** the user adds an environment variable, **Then** it is persisted and injected into future workspaces created for this project.
4. **Given** the settings drawer is open, **When** the user clicks outside the drawer or clicks a close button, **Then** the drawer closes and the chat is fully visible again.
5. **Given** the user has unsaved changes in the drawer, **When** they attempt to close it, **Then** they are prompted to save or discard changes.

---

### User Story 4 - Descriptive Branch Naming (Priority: P2)

When a user starts a chat and the agent begins working, the system creates a git branch with a human-readable name derived from the chat content (e.g., `sam/add-input-validation`, `sam/fix-login-timeout`). This replaces the current `task/{taskId}` naming which is meaningless to users reviewing branches or PRs.

**Why this priority**: Branch names are visible in GitHub, in PRs, and in git logs. A descriptive name makes it immediately clear what work was done without looking up task IDs. This is P2 because the system works with the current naming — this is a quality-of-life improvement.

**Independent Test**: Start a chat with a descriptive task, verify the branch created by the agent uses a slug derived from the chat content rather than a task ID.

**Acceptance Scenarios**:

1. **Given** a user submits a chat message like "Add dark mode toggle to settings," **When** the task is created and a branch name is generated, **Then** the branch name is a human-readable slug like `sam/add-dark-mode-toggle` (prefixed with `sam/` to identify platform-created branches).
2. **Given** a chat message is very long or contains special characters, **When** the branch name is generated, **Then** it is truncated and sanitized to a reasonable length (max 60 characters) with only alphanumeric characters, hyphens, and forward slashes.
3. **Given** a branch with the same generated name already exists in the repo, **When** a new branch name is needed, **Then** a numeric suffix is appended (e.g., `sam/add-dark-mode-toggle-2`).
4. **Given** the task completes and the agent pushes to the branch, **When** the user views the completed chat session, **Then** the branch name is displayed in the session header as a clickable link to the branch on GitHub.

---

### User Story 5 - Idle Auto-Push Safety Net (Priority: P2)

When an agent finishes working (or becomes idle), and the user does not respond within 15 minutes, the system automatically pushes all changes to a PR branch to preserve work. This is a safety net — not an auto-merge. The PR is created with the chat title as the PR title and a summary of what was done.

**Why this priority**: Without this, work can be lost if a workspace is cleaned up before changes are pushed. This is a critical reliability feature, but it's P2 because the agent typically pushes changes as part of its workflow — this is a fallback for when it doesn't.

**Independent Test**: Start a task, let the agent complete, wait 15 minutes without responding, verify a PR is automatically created with the agent's changes.

**Acceptance Scenarios**:

1. **Given** an agent sends its last message in a chat session, **When** the user does not send any message for 15 minutes, **Then** the system automatically commits any uncommitted changes and pushes to the chat's branch.
2. **Given** the auto-push is triggered, **When** there are changes on the branch that aren't in a PR, **Then** the system creates a pull request with the chat title as the PR title and a summary of the work done.
3. **Given** the auto-push is triggered, **When** there are no uncommitted changes and no unpushed commits, **Then** the system skips the push (no empty commits or PRs).
4. **Given** the user responds before the 15-minute timeout, **When** the message is sent, **Then** the idle timer resets and auto-push is deferred.
5. **Given** auto-push completes and a PR is created, **When** the user views the chat session, **Then** the PR link is displayed in the session, and the workspace enters cleanup.

---

### User Story 6 - Reliable GitHub Credentials for Agent Operations (Priority: P1)

The agent running inside a workspace must be able to perform all GitHub operations: push branches, create PRs, merge PRs, and interact with the GitHub API via `gh` CLI. The platform ensures that valid GitHub credentials are always available, even for long-running sessions that exceed the 1-hour token lifetime.

**Why this priority**: This is P1 because the entire chat-first UX depends on the agent being able to act on GitHub. If the agent can't push a branch or create a PR, the product's core promise is broken. This is infrastructure work that must be solid before the UX simplification delivers value.

**Independent Test**: Start a workspace, wait over 1 hour, verify `gh pr create` still works. Start a workspace with a repo that has a custom devcontainer config, verify `gh` CLI is available.

**Acceptance Scenarios**:

1. **Given** an agent session has been running for more than 1 hour, **When** the agent tries to use `gh` CLI (e.g., `gh pr create`), **Then** the operation succeeds because the system has refreshed the GitHub token.
2. **Given** a workspace is created for a repo with a custom `.devcontainer/devcontainer.json`, **When** the workspace provisions, **Then** the `gh` CLI is available inside the container regardless of whether the repo's devcontainer config includes it.
3. **Given** a user's GitHub profile has no public email address, **When** a workspace provisions, **Then** git identity is configured with a fallback email (e.g., `{userId}@users.noreply.github.com`) so that `git commit` works without manual configuration.
4. **Given** a workspace is about to be cleaned up (task completed or idle timeout), **When** cleanup begins, **Then** the system first ensures all changes are committed and pushed to the task branch before stopping the workspace.

---

### Edge Cases

- What happens when the user submits a chat message but has no cloud provider credentials configured? The system shows an inline error directing them to Settings to add their Hetzner token, without leaving the chat page.
- What happens when node provisioning fails mid-task? The chat session shows a system message explaining the failure, and the task transitions to failed status. The user can retry by sending another message.
- What happens when the user sends a message while a previous task is still running? A new task and session are created in parallel — the system supports concurrent task execution on separate workspaces.
- What happens when the GitHub App is not installed for the project's repository? The system shows an inline error directing the user to install the GitHub App in Settings.
- What happens when the auto-push creates a PR but CI fails? The PR remains open for the user to review. The system does not auto-merge — that's the user's decision (they can ask the agent to merge in a follow-up chat).
- What happens when the idle auto-push fires but the git push fails (e.g., auth error, protected branch)? The system logs the failure, keeps the workspace alive longer (additional 5-minute grace period), retries once, and if still failing, notifies the user via a system message in the chat session.

## Requirements *(mandatory)*

### Functional Requirements

#### UI Simplification

- **FR-001**: The project page MUST default to a chat interface with a session sidebar, message area, and input field — no other tabs or navigation within the project.
- **FR-002**: The dashboard MUST show projects as the primary content, with each project card navigating directly to the chat interface on click.
- **FR-003**: The dashboard MUST NOT show standalone workspaces, node lists, or infrastructure details. Nodes remain accessible via the main sidebar navigation for power users.
- **FR-004**: Project settings (default node size, environment variables, runtime files) MUST be accessible via a drawer/slide-over panel from the project chat page, triggered by a gear icon.
- **FR-005**: The existing project tabs (Overview, Kanban, Tasks, Sessions, Activity) MUST be removed from the project page navigation. Their route handlers MAY be preserved for direct URL access but MUST NOT appear in the UI.
- **FR-006**: Task submission from the chat input MUST be a single user action (type message, press enter/click send). The system handles task creation, status transitions, and execution internally.

#### Chat Experience

- **FR-007**: The chat input MUST accept freeform text describing what the user wants done.
- **FR-008**: When a user submits a message, the system MUST create a task, provision infrastructure, and start an agent session without requiring additional user input.
- **FR-009**: The session sidebar MUST show all chat sessions for the project, ordered by most recent first, with an indicator for active sessions.
- **FR-010**: Clicking "New Chat" in the sidebar MUST clear the message area and present a fresh input, ready for a new task submission.
- **FR-011**: The chat MUST display a brief, non-technical status indicator while infrastructure provisions (e.g., "Setting up..." or a spinner), rather than exposing internal task states.

#### Branch Naming and Git Operations

- **FR-012**: When a task is created from a chat message, the system MUST generate a human-readable branch name derived from the message content, prefixed with `sam/`.
- **FR-013**: Branch names MUST be sanitized (lowercase, alphanumeric and hyphens only, max 60 characters) and deduplicated with numeric suffixes if a branch already exists.
- **FR-014**: The generated branch name MUST be stored on the task record and displayed in the chat session header once the agent begins working.

#### Idle Auto-Push

- **FR-015**: The system MUST track the time since the last agent message in each active session.
- **FR-016**: If 15 minutes elapse after the agent's last message with no user response, the system MUST trigger an auto-push sequence: commit uncommitted changes, push to the branch, and create a PR.
- **FR-017**: The idle timeout MUST be configurable via environment variable (default: 15 minutes).
- **FR-018**: If the user sends a message before the timeout, the idle timer MUST reset.
- **FR-019**: The auto-push MUST be skipped if there are no changes to commit or push.

#### GitHub Credential Reliability

- **FR-020**: The `gh` CLI MUST be available in all workspaces, including those with custom devcontainer configurations.
- **FR-021**: The `GH_TOKEN` environment variable MUST be refreshed before expiry for long-running agent sessions, not just at session start.
- **FR-022**: Git identity MUST be configured with a fallback noreply email address when the user's GitHub profile has no public email.
- **FR-023**: Before any workspace cleanup (task completion, idle timeout, manual stop), the system MUST ensure all changes are committed and pushed to the task branch.

### Key Entities

- **Project**: A GitHub repository imported into the platform. Primary organizational unit linking to chat sessions and tasks.
- **Chat Session**: A conversation between a user and an agent about a specific piece of work. Linked to a task under the hood. Displayed as the primary UI element.
- **Task** (internal): The execution unit behind a chat session. Manages infrastructure provisioning, agent lifecycle, and completion. Not directly exposed to users in the simplified UI.
- **Branch**: A git branch created for each chat session's work, named descriptively from the chat content.

### Assumptions

- The existing task infrastructure (spec 021) is stable and does not need modification — only the UI layer on top changes.
- The current persistent sidebar navigation (Dashboard, Projects, Nodes, Settings) from spec 019 remains unchanged.
- The Nodes page remains in the main navigation for power users who want to manage infrastructure directly.
- The workspace detail page (full-screen terminal/IDE) remains unchanged — users can still "Open Workspace" from an active chat session.
- GitHub App installations already have sufficient permissions (contents: write, pull_requests: write) for the agent to push branches and create/merge PRs. If not, this is a user configuration issue, not a platform issue.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can go from login to submitting their first task in under 2 minutes (excluding one-time credential setup).
- **SC-002**: The project page shows a single primary interface (chat) instead of 7 tabs, reducing the number of navigation choices by 85%.
- **SC-003**: Task submission requires exactly 1 user action (type + submit) instead of the current multi-step flow.
- **SC-004**: 100% of agent-created changes are preserved via the idle auto-push safety net — zero data loss from workspace cleanup.
- **SC-005**: GitHub operations (`gh pr create`, `git push`) succeed in 100% of workspaces, including those with custom devcontainer configs and sessions running longer than 1 hour.
- **SC-006**: The dashboard loads and displays projects without showing infrastructure concepts (nodes, standalone workspaces) to the user.
