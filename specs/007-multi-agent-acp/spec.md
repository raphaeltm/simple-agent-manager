# Feature Specification: Multi-Agent Support via ACP

**Feature Branch**: `007-multi-agent-acp`
**Created**: 2026-02-06
**Status**: Draft
**Input**: Support multiple AI coding agents (Claude Code, OpenAI Codex, Google Gemini CLI) via the Agent Client Protocol, with a structured web UI replacing the raw terminal experience.

## Context

SAM currently supports only Claude Code as its AI coding agent. Users who prefer other coding agents cannot use the platform. The Agent Client Protocol (ACP) — an emerging industry standard for editor-to-agent communication (created by Zed Industries in partnership with Google) — provides a standardized way to communicate with multiple agents through a single protocol.

As of February 2026, ACP is supported by Claude Code (via adapter), OpenAI Codex CLI (via adapter), Google Gemini CLI (native), GitHub Copilot CLI (public preview), and 30+ other agents. The protocol SDK is at v0.14.1 with 160+ downstream dependents. Remote agent support via HTTP/WebSocket is a work in progress but functional for our architecture.

This feature extends SAM to support multiple AI coding agents and replaces the raw terminal experience with a rich, structured conversation interface — while keeping the terminal available as a fallback.

## User Scenarios & Testing

### User Story 1 — Choose an Agent in a Running Workspace (Priority: P1)

A user opens a running workspace and selects which AI coding agent to use from the available agents. All supported agents are pre-installed in every workspace, so the user can switch between agents at any time without reprovisioning. The user's API key for the selected agent is required before starting a session.

**Why this priority**: Agent selection is the foundational UX change that everything else builds on. Pre-installing all agents removes provisioning complexity and lets users experiment freely.

**Independent Test**: A user can open a workspace, see the list of available agents, select one, and start a conversation — then switch to a different agent and start a new conversation.

**Acceptance Scenarios**:

1. **Given** a user opens a running workspace, **When** they view the agent selector, **Then** they see all supported agents with names, descriptions, and visual indicators of which agents they have API keys configured for
2. **Given** a user selects "Google Gemini CLI" from the agent selector, **When** the agent session starts, **Then** the Gemini CLI agent is active and ready for prompts
3. **Given** a user has not configured an API key for the selected agent, **When** they attempt to start a session, **Then** they see a clear message directing them to Settings to add the required API key, and the session does not start
4. **Given** a user is in an active session with one agent, **When** they switch to a different agent, **Then** the current session ends and a new session begins with the newly selected agent
5. **Given** a workspace with all agents pre-installed, **When** the user views the workspace, **Then** the currently active agent (if any) is displayed in the workspace interface

---

### User Story 2 — Manage Agent API Keys (Priority: P2)

A user navigates to Settings and configures API keys for one or more coding agents. Keys are stored securely per-user following the same model as existing cloud provider credentials.

**Why this priority**: Without API keys, agents cannot authenticate with their AI providers. This extends the existing Bring-Your-Own-Key model and must be in place before any agent can be used.

**Independent Test**: A user can add, view (masked), update, and remove an API key for each supported agent, and see the connection status change immediately.

**Acceptance Scenarios**:

1. **Given** a user on the Settings page, **When** they view the "Agent API Keys" section, **Then** they see a card for each supported agent showing its name, description, and current connection status (Connected / Not Configured)
2. **Given** a user enters a valid API key for an agent, **When** they save it, **Then** the key is stored securely and the card updates to show "Connected"
3. **Given** a user has a saved API key, **When** they view it, **Then** only the last 4 characters are visible (e.g., `sk-ant-...7x9Q`)
4. **Given** a user removes an API key for an agent, **When** they confirm removal, **Then** they see a warning that any active sessions using that agent will end, and future sessions with that agent will require reconfiguring the key
5. **Given** a user updates an existing API key, **When** they save the new key, **Then** the old key is replaced and new workspaces use the updated key
6. **Given** a user views the agent API key section, **When** they click a "Get API Key" link on any agent card, **Then** they are directed to the appropriate provider's key management page

---

### User Story 3 — Structured Agent Conversation (Priority: P3)

A user opens a running workspace and interacts with the agent through a rich, structured interface showing formatted responses, tool execution cards, permission request dialogs, file change diffs, and thinking/reasoning indicators — instead of a raw terminal.

**Why this priority**: This is the core UX improvement that multi-agent protocol support enables. A structured conversation interface is dramatically better than watching raw terminal output, and it's the primary value proposition for adopting ACP.

**Independent Test**: A user can send a prompt, see a streaming formatted response, observe tool execution cards, approve or reject a permission request, and view a file diff — all within the browser.

**Acceptance Scenarios**:

1. **Given** a running workspace with a supported agent, **When** the user opens the workspace, **Then** they see a conversation interface with a prompt input area and message history
2. **Given** the user sends a prompt (e.g., "read the README and summarize it"), **When** the agent responds, **Then** the response streams in as formatted content with proper headings, code blocks with syntax highlighting, and inline formatting
3. **Given** the agent wants to read or edit a file, **When** the tool execution begins, **Then** the user sees a visual card showing the tool name, the file being accessed, and a real-time status indicator (running / completed / failed)
4. **Given** the agent needs permission to perform an action (e.g., editing a file), **When** the permission request arrives, **Then** the user sees a dialog with the action description, the target file, and clear Approve / Reject buttons
5. **Given** the agent edits a file, **When** the edit completes, **Then** the user sees a visual diff showing the exact changes made (additions highlighted in green, removals in red)
6. **Given** the agent is processing internally before responding, **When** thinking/reasoning chunks arrive, **Then** the user sees a collapsible "Thinking..." section that can be expanded to view the agent's reasoning
7. **Given** the agent runs a shell command, **When** the command executes, **Then** the output appears in an embedded output block within the conversation flow
8. **Given** the user is in the conversation view, **When** they scroll up through message history, **Then** all previous messages, tool calls, and responses remain visible and properly formatted

---

### User Story 4 — Terminal Fallback (Priority: P4)

A user can switch between the structured conversation view and a raw terminal at any time. If the structured connection fails to establish, the raw terminal is shown automatically. The terminal fallback ensures that workspaces are always usable regardless of agent protocol compatibility.

**Why this priority**: ACP is a pre-1.0 protocol and agents may have compatibility issues. Users need a reliable escape hatch to raw terminal access to ensure no workspace becomes unusable.

**Independent Test**: A user can toggle between conversation view and terminal, and when the structured connection is intentionally broken, the terminal appears automatically.

**Acceptance Scenarios**:

1. **Given** a user in the structured conversation view, **When** they click a "Switch to Terminal" control, **Then** they see the familiar raw terminal with a shell prompt
2. **Given** the structured connection fails during workspace startup, **When** the workspace loads, **Then** the raw terminal is shown automatically with a visible notification: "Structured view unavailable — using terminal mode"
3. **Given** a user in the raw terminal, **When** they click "Switch to Conversation View", **Then** they return to the structured interface (the agent session continues from where it was)
4. **Given** an agent that does not support the structured communication protocol, **When** the workspace opens, **Then** only the raw terminal is available and no toggle is shown
5. **Given** the structured connection drops mid-conversation, **When** the disconnection is detected, **Then** the system attempts reconnection for up to 30 seconds before automatically switching to terminal mode with a notification

---

### User Story 5 — Agent Operating Modes (Priority: P5)

A user can switch between agent-specific operating modes for their active session, such as conversational, architectural, and code-writing modes. Available modes vary by agent and are dynamically reported.

**Why this priority**: Power users need fine-grained control over agent behavior. This story is lower priority because the default mode works for most interactions.

**Independent Test**: A user can see available modes for their agent, switch modes, and observe the agent's behavior change accordingly.

**Acceptance Scenarios**:

1. **Given** a workspace with an agent that supports operating modes, **When** the user views the mode selector, **Then** they see the available modes as reported by the agent (e.g., "Ask", "Code", "Architect")
2. **Given** the user selects a different mode, **When** the mode changes, **Then** the agent switches behavior and the interface updates to show the active mode
3. **Given** an agent that does not support operating modes, **When** the user views the workspace, **Then** no mode selector is shown

---

### Edge Cases

- **Agent process crashes mid-session**: The system attempts to restart the agent automatically. If restart fails after 3 attempts, the user is notified and offered the terminal fallback.
- **API key becomes invalid after workspace creation**: The agent fails to authenticate on next prompt. The user sees a clear error message directing them to update their API key in Settings.
- **Network interruption during streaming response**: The system buffers partial messages and resumes streaming on reconnection. If reconnection fails, the partial response is preserved and the user is notified.
- **User switches agents mid-conversation**: The current agent session ends gracefully. Any in-progress tool executions are cancelled. The new agent starts a fresh session with no conversation history carried over.
- **Existing workspaces created before multi-agent support**: Default to Claude Code with no migration required. The existing terminal-based experience continues to work.
- **Multiple browser tabs open to the same workspace**: Only one active structured session is allowed at a time. Additional tabs see the terminal fallback with a notification that the conversation view is active in another tab.
- **Agent responds with unsupported content type**: Unsupported content types are displayed as raw text with a visual indicator that rich rendering is unavailable.

## Requirements

### Functional Requirements

- **FR-001**: System MUST support at least three AI coding agents at launch: Claude Code, OpenAI Codex, and Google Gemini CLI
- **FR-002**: System MUST pre-install all supported agents in every workspace environment
- **FR-003**: System MUST allow users to select which agent to use from within a running workspace
- **FR-004**: System MUST allow users to switch between agents within a running workspace, ending the current session and starting a new one
- **FR-005**: System MUST allow users to store one API key per supported agent type
- **FR-006**: System MUST encrypt all stored agent API keys using the same security model as existing cloud provider credentials
- **FR-007**: System MUST display stored API keys in masked form, showing only the last 4 characters
- **FR-008**: System MUST prevent starting an agent session if the user has not configured the required API key for the selected agent
- **FR-009**: System MUST display a supported agents catalog with names, descriptions, and connection status
- **FR-010**: System MUST render agent responses as structured, formatted content with markdown support and syntax-highlighted code blocks
- **FR-011**: System MUST display agent tool executions as visual cards with tool name, target, and real-time status
- **FR-012**: System MUST present agent permission requests as interactive dialogs with Approve and Reject options
- **FR-013**: System MUST display file modifications as visual diffs showing additions and removals
- **FR-014**: System MUST display agent reasoning/thinking in a collapsible section
- **FR-015**: System MUST provide a raw terminal fallback for every workspace, accessible via a toggle control
- **FR-016**: System MUST automatically fall back to the raw terminal if structured communication fails to establish within a configurable timeout
- **FR-017**: System MUST attempt automatic reconnection before falling back to terminal mode
- **FR-018**: System MUST count agent activity (prompts, tool executions) toward the workspace idle detection timer
- **FR-019**: System MUST display the currently active agent in the workspace interface
- **FR-020**: System MUST support agent operating mode switching where the agent advertises available modes
- **FR-021**: System MUST gracefully hide UI features that the current agent does not support (e.g., modes, model selection)

### Key Entities

- **Workspace**: An AI coding environment tied to a repository. All supported agents are pre-installed. The active agent is selected at runtime by the user, not at creation time.
- **Agent Credential**: A user's API key for a specific AI coding agent. Encrypted per-user, one per agent type. Follows the same security model as cloud provider credentials.
- **Agent Definition**: A catalog entry describing a supported coding agent — its name, description, required credential type, connection status, and capabilities.
- **Agent Session**: An active conversation between a user and an agent within a workspace. Includes message history, tool call state, and permission request state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users can switch between agents and start a new session within 10 seconds
- **SC-002**: 90% of users successfully configure an agent API key on their first attempt without consulting documentation
- **SC-003**: The structured conversation view becomes interactive within 5 seconds of the workspace reaching "ready" state
- **SC-004**: Users can respond to an agent permission request (approve or reject) in 2 or fewer interactions
- **SC-005**: When structured communication fails, fallback to raw terminal completes within 5 seconds
- **SC-006**: Agent API keys are never visible in plaintext in the user interface, application logs, or network traffic
- **SC-007**: 80% of users prefer the structured conversation view over the raw terminal for daily agent interactions (measured via view toggle analytics)
- **SC-008**: Workspace idle detection accuracy remains at or above current levels when structured agent activity is the primary interaction mode

## Assumptions

- **One active agent at a time**: Multi-agent orchestration (running multiple agents cooperatively) is out of scope. Only one agent session is active at a time per workspace, but the user can switch between agents freely.
- **User-global API keys**: API keys are stored per-user, not per-workspace. All workspaces using the same agent type share the user's key for that agent.
- **Initial three agents**: Launch supports Claude Code, OpenAI Codex, and Google Gemini CLI. Additional agents can be added to the catalog without architectural changes.
- **ACP as structured protocol**: The Agent Client Protocol (v0.14.x) is sufficiently stable for the session, prompt, tool call, and permission features we need, despite being pre-1.0.
- **Remote WebSocket bridge**: Since ACP's remote transport is still work-in-progress, we bridge between the browser (WebSocket) and the agent process (stdio/NDJSON) at the VM level. This is a thin translation layer, not a custom protocol.
- **Terminal always available**: The existing raw terminal infrastructure remains unchanged and is always available as a fallback, regardless of ACP status.
- **All agents pre-installed**: Every workspace includes all supported agents. This simplifies provisioning and lets users experiment without reprovisioning. The marginal disk/install cost is acceptable given the flexibility gained.
- **Backward compatible**: Existing workspaces created before this feature continue to work with the current terminal experience. No data migration is required.
- **Agent adapters accepted**: Not all agents have native ACP support. Claude Code and Codex CLI currently use community-maintained ACP adapters. This is acceptable for launch as long as the adapter quality is verified.

## Out of Scope

- Multi-agent orchestration (running multiple agents cooperating on the same task)
- Custom agent definitions (users adding their own agent CLI commands)
- Session history persistence (saving and resuming conversations across workspace restarts)
- Voice or audio interaction
- Agent-to-agent communication (A2A protocol)
- Agent marketplace (third-party agent discovery and installation)
- Per-workspace agent configuration files
