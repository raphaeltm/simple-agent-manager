# Feature Specification: Worktree Context Switching

**Feature Branch**: `015-worktree-context`
**Created**: 2026-02-16
**Status**: Draft
**Input**: User description: "Deep git worktree integration for workspace context switching — worktree-scoped terminals, file browser, git tooling, and agent chat sessions with instant context switching between branches"

## User Scenarios & Testing *(mandatory)*

### User Story 1 — View and Switch Between Worktrees (Priority: P1)

A developer working in a SAM workspace wants to work on multiple branches simultaneously. They see a worktree selector in the workspace header that lists all active worktrees (each showing its branch name). They click it to switch context — the file browser and git viewer immediately reflect the selected worktree's files and changes. The primary worktree (the originally cloned branch) is always present and visually distinguished.

**Why this priority**: This is the foundational interaction. Without the ability to see and switch worktrees, no other worktree feature delivers value. It also covers the most common need: quickly checking files or git status on a different branch without disrupting current work.

**Independent Test**: Can be fully tested by listing worktrees via the selector and switching between them to verify the file browser and git viewer update. Delivers the value of instant branch context switching for read-only browsing.

**Acceptance Scenarios**:

1. **Given** a running workspace with one worktree (the primary clone), **When** the user opens the worktree selector, **Then** it shows exactly one entry with the current branch name, marked as "primary."
2. **Given** a workspace with three worktrees (main, feature-auth, bugfix-42), **When** the user selects "feature-auth" from the worktree selector, **Then** the file browser shows the file tree of the feature-auth worktree and the git viewer shows staged/unstaged changes in that worktree.
3. **Given** the user has switched the active worktree to "feature-auth," **When** they open the git changes panel, **Then** the panel shows only the changes in the feature-auth worktree directory — not changes from the primary worktree or other worktrees.
4. **Given** the user switches worktrees, **When** they reload the page, **Then** the previously selected worktree is restored (via URL state).

---

### User Story 2 — Create and Remove Worktrees (Priority: P1)

A developer wants to start work on a new branch without losing context on their current branch. From the worktree selector, they choose "New worktree," pick an existing branch (or type a new branch name to create one), and the system creates a new worktree. The new worktree appears in the selector and can be immediately switched to. When done, the developer removes the worktree via the selector's context menu.

**Why this priority**: Creating worktrees is the entry point for the entire feature. Without it, users can only interact with the single primary worktree — which is the status quo.

**Independent Test**: Can be fully tested by creating a worktree from a branch, verifying it appears in the selector, switching to it, and then removing it. Delivers the value of on-demand parallel branch checkouts.

**Acceptance Scenarios**:

1. **Given** a running workspace, **When** the user chooses "New worktree" and selects an existing remote branch "feature-auth," **Then** a new worktree is created for that branch and appears in the selector within a few seconds.
2. **Given** the branch "feature-auth" is already checked out in a worktree, **When** the user tries to create another worktree for "feature-auth," **Then** the system shows an error explaining the branch is already checked out and in which worktree.
3. **Given** the user types a new branch name "experiment/new-ui" that does not exist, **When** they confirm, **Then** the system creates a new branch from the current HEAD of the primary worktree and creates a worktree for it.
4. **Given** a worktree "feature-auth" with no uncommitted changes, **When** the user selects "Remove" from the worktree's context menu, **Then** the worktree is removed and disappears from the selector.
5. **Given** a worktree "bugfix-42" with uncommitted changes, **When** the user selects "Remove," **Then** the system shows a warning with the count of dirty files and asks for confirmation before force-removing.
6. **Given** the user removes the currently active worktree, **When** the removal completes, **Then** the active worktree automatically switches to the primary worktree.
7. **Given** the primary worktree, **When** the user attempts to remove it, **Then** the remove option is disabled or hidden (the primary worktree cannot be removed).

---

### User Story 3 — Worktree-Scoped Terminals (Priority: P2)

A developer wants new terminal sessions to open in the currently selected worktree's directory. They also want to see which worktree each existing terminal belongs to, so they can keep track when running commands across multiple branches.

**Why this priority**: Terminals are the primary interaction surface. Making them worktree-aware delivers the "parallel development" value — e.g., running tests on main in one terminal while coding on a feature branch in another. It depends on the selector (P1) being in place.

**Independent Test**: Can be fully tested by selecting a worktree, opening a new terminal, and verifying the shell's working directory matches the selected worktree. Delivers the value of branch-specific command execution.

**Acceptance Scenarios**:

1. **Given** the active worktree is "feature-auth" (at `/workspaces/my-repo-feature-auth`), **When** the user creates a new terminal tab, **Then** the terminal shell starts with its working directory set to the feature-auth worktree's root.
2. **Given** a terminal was created while "main" was the active worktree, **When** the user switches the active worktree to "feature-auth," **Then** the existing terminal keeps its original working directory (it does not change) and its tab shows a badge indicating it belongs to "main."
3. **Given** multiple terminals across different worktrees, **When** the user views the tab strip, **Then** each terminal tab displays a short label identifying which worktree it belongs to (e.g., "main: Terminal 1," "feat: Terminal 2").
4. **Given** all worktrees have associated terminals, **When** the user views the tab strip, **Then** all terminal tabs are visible regardless of the active worktree (terminals are not filtered by worktree selection).

---

### User Story 4 — Worktree-Scoped Agent Chat Sessions (Priority: P2)

A developer wants each AI agent chat session to operate in the context of a specific worktree. When they create a new agent session, it is bound to the currently active worktree. The agent reads, writes, and navigates files within that worktree's directory. This enables parallel AI-assisted work — Claude on main reviewing code while another Claude instance implements a feature on a different branch.

**Why this priority**: Agent sessions are the core value prop of SAM. Making them worktree-aware unlocks the most powerful use case: parallel AI work across branches. It depends on the selector (P1) being in place.

**Independent Test**: Can be fully tested by selecting a worktree, creating a new agent session, and verifying the agent's working directory is the selected worktree (e.g., asking the agent to run `pwd`). Delivers the value of branch-specific AI assistance.

**Acceptance Scenarios**:

1. **Given** the active worktree is "feature-auth," **When** the user creates a new agent chat session, **Then** the agent process starts with its working directory set to the feature-auth worktree root.
2. **Given** an agent session was created in the "main" worktree, **When** the user switches the active worktree to "feature-auth," **Then** the existing agent session continues to operate in "main" (its CWD does not change).
3. **Given** agent sessions in both "main" and "feature-auth" worktrees, **When** the user views the tab strip, **Then** each agent session tab displays a badge showing which worktree it belongs to.
4. **Given** an agent session bound to worktree "bugfix-42," **When** that worktree is removed, **Then** the agent session is stopped with a notification explaining the worktree was removed.
5. **Given** the user reloads the page, **When** agent sessions are restored, **Then** each session retains its worktree association and the chat tab shows the correct worktree badge.

---

### User Story 5 — Worktree-Aware File Browser and Git Viewer (Priority: P2)

A developer wants the file browser and git changes viewer to automatically scope to the active worktree. When browsing files in "feature-auth," they see only that worktree's directory tree. When viewing git changes, they see only the staged/unstaged changes in that worktree. Cross-worktree file navigation (jumping to a file in a different worktree) is not needed.

**Why this priority**: File browsing and git status are already built. This story scopes them to the worktree, which is a small incremental change but essential for a coherent context-switching experience. It depends on the selector (P1).

**Independent Test**: Can be fully tested by selecting different worktrees and verifying the file browser root and git status output change accordingly. Delivers the value of branch-specific file and change visibility.

**Acceptance Scenarios**:

1. **Given** worktree "feature-auth" is active, **When** the user opens the file browser at path ".", **Then** the browser lists files from the feature-auth worktree root, not the primary worktree.
2. **Given** worktree "feature-auth" has staged changes to `auth.ts`, **When** the user opens the git changes panel, **Then** it shows `auth.ts` as staged and does not show changes from other worktrees.
3. **Given** the user is viewing a diff in the "main" worktree's git panel, **When** they switch the active worktree to "feature-auth," **Then** the git panel closes or refreshes to show the feature-auth worktree's changes (not stale data from main).

---

### Edge Cases

- **Branch already checked out**: When a user attempts to create a worktree for a branch that is already checked out in another worktree, the system must display a clear error identifying which worktree holds that branch.
- **Concurrent worktree operations**: If two browser tabs attempt to create or remove the same worktree simultaneously, only one should succeed and the other should receive a conflict error.
- **Maximum worktree count**: The system should enforce a configurable limit on the number of worktrees per workspace to prevent unbounded disk usage.
- **Worktree on detached HEAD**: The system should handle worktrees that are in a detached HEAD state (e.g., checking out a tag or specific commit) and display the commit hash instead of a branch name.
- **Long-running operations during worktree removal**: If a terminal or agent session is actively running in a worktree that is being removed, the system should warn the user and require confirmation.
- **Stale worktree detection**: If a worktree directory is manually deleted (e.g., via terminal `rm -rf`), `git worktree list` will show it as prunable. The system should detect this and offer to prune.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an endpoint to list all git worktrees for a workspace, returning each worktree's path, branch name, HEAD commit, and whether it is the primary worktree.
- **FR-002**: System MUST provide an endpoint to create a new worktree from an existing branch or by creating a new branch from a specified base ref.
- **FR-003**: System MUST provide an endpoint to remove a worktree, with optional force removal for dirty worktrees.
- **FR-004**: System MUST validate that the requested branch is not already checked out in another worktree before creating a new worktree.
- **FR-005**: System MUST display a worktree selector in the workspace header that lists all active worktrees with their branch names.
- **FR-006**: System MUST allow instant switching of the active worktree, updating file browser and git viewer context without page reload or container restart.
- **FR-007**: System MUST scope the file browser to the active worktree's directory — file listing and file viewing operations use the active worktree as the root.
- **FR-008**: System MUST scope the git viewer (status, diff, file content) to the active worktree's directory.
- **FR-009**: System MUST open new terminal sessions with the working directory set to the active worktree's root.
- **FR-010**: Existing terminal sessions MUST NOT change their working directory when the user switches the active worktree.
- **FR-011**: Terminal tabs MUST display a label indicating which worktree they belong to.
- **FR-012**: System MUST bind new agent chat sessions to the active worktree at creation time, setting the agent's working directory to that worktree's root.
- **FR-013**: Agent sessions MUST retain their worktree binding for their entire lifetime — switching the active worktree does not affect running agent sessions.
- **FR-014**: Agent session tabs MUST display a badge indicating which worktree they are bound to.
- **FR-015**: System MUST prevent removal of the primary worktree (the original clone directory).
- **FR-016**: System MUST warn users before removing a worktree that has uncommitted changes, showing the number of dirty files.
- **FR-017**: System MUST validate worktree paths server-side against the output of `git worktree list` to prevent directory traversal.
- **FR-018**: System MUST enforce a configurable maximum number of worktrees per workspace.
- **FR-019**: System MUST persist the active worktree selection in the URL (as a search parameter) so it survives page reload and is shareable.
- **FR-020**: System MUST persist agent session worktree associations so they are restored after page reload.
- **FR-021**: When a worktree is removed, the system MUST stop any agent sessions bound to that worktree and notify the user.
- **FR-022**: System MUST ensure worktree directories are accessible inside the devcontainer (worktrees created as sibling directories to the primary clone must be visible within the container's filesystem).

### Key Entities

- **Worktree**: A git worktree checked out at a specific directory path, associated with a branch (or detached HEAD). Has attributes: path, branch name, HEAD commit hash, is-primary flag, dirty-state.
- **Active Worktree**: The currently selected worktree in the UI. Determines the context for file browser, git viewer, and new terminal/agent session creation. Stored as a URL search parameter.
- **Worktree Binding** (on Terminal/Agent Session): An association between a terminal or agent session and the worktree in which it was created. Immutable after creation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a new worktree and switch to it in under 10 seconds (wall-clock time from clicking "New worktree" to seeing the new worktree's files in the file browser).
- **SC-002**: Switching between existing worktrees updates the file browser and git viewer in under 1 second (no page reload, no container restart).
- **SC-003**: Users can run parallel agent sessions across at least 2 different worktrees simultaneously, each correctly scoped to its own branch.
- **SC-004**: Users can run terminals in multiple worktrees simultaneously, with each terminal tab clearly labeled with its worktree.
- **SC-005**: All worktree operations (create, switch, remove) are usable on mobile viewports (375px width) with touch targets meeting the 56px minimum.
- **SC-006**: Worktree path validation prevents 100% of directory traversal attempts (no worktree parameter can reference a path outside the workspace's worktree set).
- **SC-007**: The worktree selector correctly reflects worktree state within 5 seconds of any create/remove operation.

## Assumptions

- Users are working with git repositories that support the `git worktree` feature (available in Git 2.5+, released 2015). All modern devcontainer images include a compatible git version.
- The devcontainer filesystem mount can be adjusted to make sibling worktree directories accessible inside the container without requiring a container rebuild for each new worktree.
- The ACP protocol's `NewSession` CWD parameter is sufficient to scope an agent to a worktree — no additional agent-side changes are needed.
- Worktree operations (create, remove, list) complete within seconds for typical repositories. Very large repositories (>10GB) may be slower but this is not a primary target.
- The maximum worktree count default is reasonable (e.g., 5-10 worktrees per workspace) and can be adjusted via environment configuration.
- All worktrees within a workspace belong to the same user and share the same git credentials — no per-worktree authentication is needed.

## Scope Boundaries

### In Scope

- Worktree CRUD (list, create, remove) via UI and backend endpoints
- Worktree selector UI with instant context switching
- Worktree-scoped file browser and git viewer
- Worktree-scoped terminal creation with tab labeling
- Worktree-scoped agent session creation with tab badging
- Server-side worktree path validation
- URL-based active worktree persistence
- Mobile-responsive worktree selector

### Out of Scope

- Cross-worktree file comparison (diff between two worktrees)
- Automatic worktree creation on workspace bootstrap (users create worktrees manually)
- Worktree-level resource isolation (CPU/memory limits per worktree)
- Git submodule-specific worktree handling
- Worktree templates or presets
- Bulk worktree operations (create/remove multiple at once)
