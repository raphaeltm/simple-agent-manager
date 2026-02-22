# Tasks: Multi-Agent Support via ACP

**Input**: Design documents from `/specs/007-multi-agent-acp/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested — test tasks are omitted. Tests can be added incrementally.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Monorepo**: `apps/api/`, `apps/web/`, `packages/shared/`, `packages/acp-client/`, `packages/vm-agent/`, `packages/cloud-init/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new `packages/acp-client` package, add ACP dependencies, define shared agent types

- [x] T001 Create `packages/acp-client/` package scaffolding with `package.json` (name: `@simple-agent-manager/acp-client`), `tsconfig.json`, and `src/index.ts` barrel export — follow `packages/terminal/` conventions (ESM, React 18 peer dep, tsup build)
- [x] T002 [P] Add `@agentclientprotocol/sdk` (v0.14.x) as a dependency to `packages/acp-client/package.json` — this is the official ACP TypeScript SDK providing `ClientSideConnection`, typed ACP messages, and the `ndJsonStream` helper
- [x] T003 [P] Add `github.com/coder/acp-go-sdk` (v0.10.7) to `packages/vm-agent/go.mod` via `go get github.com/coder/acp-go-sdk@v0.10.7` — this Go SDK provides `NewClientSideConnection`, typed ACP `Client` interface, and `SessionNotification`/`SessionUpdate` types for the WebSocket-to-stdio bridge
- [x] T004 Define agent registry types and catalog in `packages/shared/src/agents.ts` — export `AgentType` union (`'claude-code' | 'openai-codex' | 'google-gemini'`), `AgentDefinition` interface (id, name, description, provider, envVarName, acpCommand, acpArgs, supportsAcp, credentialHelpUrl, installCommand), and `AGENT_CATALOG` constant array with all three agent definitions per data-model.md
- [x] T005 Export agent types from `packages/shared/src/index.ts` barrel — add `export * from './agents'`
- [x] T006 Register `packages/acp-client` in root `pnpm-workspace.yaml` and add workspace dependency `@simple-agent-manager/acp-client` to `apps/web/package.json`, then run `pnpm install` to link

**Checkpoint**: New package scaffolded, ACP SDKs available, agent types shared across all packages

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extend database schema for agent credentials and add API endpoints that multiple user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Extend credentials table in `apps/api/src/db/schema.ts` — add `credentialType` column (`text('credential_type').notNull().default('cloud-provider')`) and `agentType` column (`text('agent_type')`) per data-model.md. Add unique index on `(userId, credentialType, agentType)`. Export updated `Credential`/`NewCredential` types.
- [x] T008 Create D1 migration SQL in `apps/api/migrations/` — `ALTER TABLE credentials ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'cloud-provider'; ALTER TABLE credentials ADD COLUMN agent_type TEXT;` plus the unique index. Follow existing migration file naming convention.
- [x] T009 Create agent catalog API route in `apps/api/src/routes/agents-catalog.ts` — implement `GET /api/agents` endpoint per `contracts/api.yaml`. Query the user's agent credentials from D1 to populate the `configured` boolean per agent. Use `requireAuth()` middleware, `getUserId(c)` helper, and the `AGENT_CATALOG` from `@simple-agent-manager/shared`. Return `{ agents: AgentInfo[] }`.
- [x] T010 Mount the new agent catalog route in `apps/api/src/index.ts` — add `app.route('/api/agents', agentsCatalogRoutes)` alongside existing route registrations
- [x] T011 Add agent credential CRUD to `apps/api/src/routes/credentials.ts` — implement three new endpoints per `contracts/api.yaml`: (1) `PUT /agent` to save/update an encrypted agent API key (validate `agentType` against `AGENT_CATALOG`, encrypt with existing `encrypt()` helper, upsert into D1 with `credentialType='agent-api-key'`), (2) `GET /agent` to list the user's agent credentials with masked keys (last 4 chars), (3) `DELETE /agent/:agentType` to remove a specific agent credential. Follow existing encryption pattern (AES-256-GCM with separate IV).
- [x] T012 Add internal endpoint `POST /api/workspaces/:id/agent-key` in `apps/api/src/routes/workspaces.ts` — per `contracts/api.yaml`, this is called by the VM Agent to fetch a decrypted agent API key for a running workspace. Authenticate via the VM Agent's workspace JWT (the same JWT used for WebSocket PTY auth — the agent sends it as a Bearer token; the control plane validates the JWT signature and `workspace` claim matches `:id`). Look up the workspace owner's credential for the requested `agentType`, decrypt it using `ENCRYPTION_KEY`, and return `{ apiKey }`. Return 404 if no credential configured. The decrypted key MUST NOT be logged or included in error messages (SC-006).
- [x] T013 Add `AgentCredentialInfo`, `SaveAgentCredentialRequest`, and `AgentInfo` response types to `packages/shared/src/types.ts` — these types match the `contracts/api.yaml` component schemas and are used by both API and web app

**Checkpoint**: Foundation ready — database supports agent credentials, API can serve agent catalog and manage keys, VM Agent can fetch decrypted keys

---

## Phase 3: User Story 1 — Choose an Agent in a Running Workspace (Priority: P1) 🎯 MVP

**Goal**: Users can open a running workspace, see a list of available agents, select one, and start/switch agent sessions

**Independent Test**: Open a workspace → see agent selector → pick an agent → agent process starts on VM → ACP initialize succeeds → user sees "ready" status

### Implementation for User Story 1

#### VM Agent: ACP Gateway (Go)

- [x] T014 [US1] Create ACP process manager in `packages/vm-agent/internal/acp/process.go` — implement `AgentProcess` struct that spawns an agent subprocess inside the devcontainer via `docker exec -i <container-id> <acpCommand> <acpArgs...>` with the API key injected as an environment variable (`-e ANTHROPIC_API_KEY=...`). Pipe stdin/stdout for NDJSON communication. Implement `Start()`, `Stop()`, and `Wait()` methods. Use the existing container discovery from `internal/container/discovery.go` to resolve the container ID. Handle process crash with auto-restart (up to 3 attempts per research.md).
- [x] T015 [US1] Create ACP gateway in `packages/vm-agent/internal/acp/gateway.go` — implement `Gateway` struct that bridges a gorilla/websocket connection to an `AgentProcess`. Use `coder/acp-go-sdk`'s `NewClientSideConnection(client, stdin, stdout)` to create a typed ACP connection to the agent's stdio. Implement the `acp.Client` interface: `SessionUpdate()` forwards `SessionNotification` as JSON WebSocket frames to the browser, `RequestPermission()` forwards permission requests to the browser and waits for the response via a channel. Handle the `select_agent` control message from the browser (stop current process, fetch API key from control plane via `POST /api/workspaces/:id/agent-key`, start new agent process). Send `agent_status` control messages (`starting`, `ready`, `error`, `restarting`) per `contracts/websocket.md`.
- [x] T016 [US1] Create ACP transport handler in `packages/vm-agent/internal/acp/transport.go` — implement the WebSocket ↔ NDJSON frame mapping. Each incoming WebSocket text message is either an ACP JSON-RPC message (forwarded to agent stdin) or a control message (`select_agent`). Each NDJSON line from agent stdout is forwarded as a WebSocket text frame. Parse the `type` field to distinguish control messages from ACP messages.
- [x] T017 [US1] Register ACP WebSocket endpoint in `packages/vm-agent/internal/server/` — add `/agent/ws` route that upgrades to WebSocket (same JWT auth as existing `/ws` PTY endpoint), creates an `acp.Gateway`, and runs the bidirectional bridge. Wire up activity callbacks to the idle detection system so ACP interactions count toward keeping the workspace alive (FR-018).
- [x] T018 [US1] Add ACP configuration to `packages/vm-agent/internal/config/config.go` — add configurable values per Constitution Principle XI: `ACP_INIT_TIMEOUT_MS` (default 30000), `ACP_RECONNECT_DELAY_MS` (default 2000 — initial backoff delay between retry attempts), `ACP_RECONNECT_TIMEOUT_MS` (default 30000 — total time to attempt reconnection before giving up), `ACP_MAX_RESTART_ATTEMPTS` (default 3), `CONTROL_PLANE_URL` (required, used for agent-key fetch). Use existing `getEnv()`/`getEnvInt()` helpers.

#### Web App: Agent Selector & Session Management

- [x] T019 [P] [US1] Create WebSocket ACP transport adapter in `packages/acp-client/src/transport/websocket.ts` — implement a function `createAcpWebSocketTransport(ws: WebSocket)` that returns a bidirectional stream compatible with `@agentclientprotocol/sdk`'s `ClientSideConnection`. Each WebSocket text message maps to one ACP JSON-RPC message. Handle WebSocket lifecycle (open, close, error). Also handle `agent_status` control messages separately from ACP messages, exposing them via a callback. This is ~50 lines per research.md.
- [x] T020 [P] [US1] Define ACP message types in `packages/acp-client/src/transport/types.ts` — export TypeScript types for the VM Agent control messages: `AgentStatusMessage` (`{ type: 'agent_status', status: 'starting' | 'ready' | 'error' | 'restarting', agentType: string, error?: string }`), `SelectAgentMessage` (`{ type: 'select_agent', agentType: string }`). Also re-export relevant types from `@agentclientprotocol/sdk` for convenience.
- [x] T021 [US1] Create `useAcpSession` hook in `packages/acp-client/src/hooks/useAcpSession.ts` — manage the ACP session lifecycle: (1) connect to `/agent/ws?token=JWT` WebSocket, (2) send `select_agent` control message when user picks an agent, (3) listen for `agent_status` messages to track state (`no_session` → `initializing` → `ready`), (4) on `ready`, create `ClientSideConnection` from the SDK using the WebSocket transport adapter, (5) call `initialize()` and `newSession()`, (6) expose `prompt(text)`, `cancel()`, `respondToPermission(requestId, response)` actions, (7) expose session state, agent info, and available modes. Return `{ state, agentType, agentInfo, modes, prompt, cancel, switchAgent, respondToPermission }`.
- [x] T022 [US1] Create `AgentSelector` component in `apps/web/src/components/AgentSelector.tsx` — display the agent catalog (fetched from `GET /api/agents`) as cards showing agent name, description, icon, and connection status (whether the user has an API key configured). Clicking an agent with a configured key calls the `switchAgent(agentType)` callback. Clicking an agent without a key shows a message directing to Settings. Highlight the currently active agent. Use Tailwind CSS following existing `apps/web/` component patterns.
- [x] T023 [US1] Modify workspace page in `apps/web/src/pages/Workspace.tsx` — add the `AgentSelector` above or alongside the terminal. When a workspace is in `running` state, show the agent selector and a persistent active agent indicator in the workspace header displaying the agent name, icon, and session state (e.g., "Claude Code: Ready", "Initializing...", "No Agent Selected"). This indicator MUST be visible in both terminal and conversation view modes (FR-019). Connect the `useAcpSession` hook. For MVP, the actual conversation UI comes in US3 — here just show agent status and keep the existing terminal as the primary interface. Add a "Structured View" / "Terminal" toggle that will be wired up in US3/US4.

**Checkpoint**: User can open a workspace, see available agents, select one, and the ACP session initializes on the VM. Agent status is visible in the workspace UI. Terminal remains the primary interaction mode for now.

---

## Phase 4: User Story 2 — Manage Agent API Keys (Priority: P2)

**Goal**: Users can add, view (masked), update, and remove API keys for each supported agent from the Settings page

**Independent Test**: Navigate to Settings → see "Agent API Keys" section → add an Anthropic key → see "Connected" status → update it → remove it → see "Not Configured"

### Implementation for User Story 2

- [x] T024 [P] [US2] Create `AgentKeyCard` component in `apps/web/src/components/AgentKeyCard.tsx` — display a single agent's API key status card: agent name, description, provider icon, connection status badge ("Connected" / "Not Configured"), masked key display (`...7x9Q`), "Get API Key" link (opens provider's key page in new tab), input field for entering/updating key, Save button, and Remove button with confirmation dialog. Follow existing `HetznerTokenForm` component patterns from Settings page.
- [x] T025 [US2] Create `AgentKeysSection` component in `apps/web/src/components/AgentKeysSection.tsx` — fetch agent credentials from `GET /api/credentials/agent` and agent catalog from `GET /api/agents`, render an `AgentKeyCard` for each supported agent, handle save (`PUT /api/credentials/agent`), and delete (`DELETE /api/credentials/agent/:agentType`) operations with optimistic UI updates and error handling.
- [x] T026 [US2] Integrate `AgentKeysSection` into `apps/web/src/pages/Settings.tsx` — add a new "Agent API Keys" section below the existing "Cloud Provider Credentials" section. Follow the existing card/section layout pattern. The section header should explain that API keys are stored encrypted and used across all workspaces.

**Checkpoint**: Users can manage all agent API keys from Settings. Connection status is visible. Keys are encrypted in D1.

---

## Phase 5: User Story 3 — Structured Agent Conversation (Priority: P3)

**Goal**: Users interact with agents through a rich, structured interface showing formatted responses, tool execution cards, permission dialogs, file diffs, and thinking indicators

**Independent Test**: Open workspace → select agent → send a prompt → see streaming formatted response → see tool execution card → approve a permission request → see file diff → see thinking indicator

### Implementation for User Story 3

#### ACP Client Components (packages/acp-client)

- [x] T027 [P] [US3] Create `useAcpMessages` hook in `packages/acp-client/src/hooks/useAcpMessages.ts` — manage streaming message state from ACP session updates. Process `SessionNotification.Update` variants: `AgentMessageChunk` (append text to current agent message), `AgentThoughtChunk` (append to thinking block), `ToolCall` (add new tool call card with status "running"), `ToolCallUpdate` (update tool call status to "completed"/"failed", attach output), `Plan` (update plan entries). For unknown/unsupported `SessionUpdate` variants, render as raw JSON text with a "Rich rendering unavailable" visual indicator (spec edge case: unsupported content type). Maintain an ordered array of `ConversationItem` union type (user_message | agent_message | tool_call | thinking | plan | raw_fallback). Handle `PromptResponse` to finalize the turn and record token usage.
- [x] T028 [P] [US3] Create `MessageBubble` component in `packages/acp-client/src/components/MessageBubble.tsx` — render a single agent or user message with full markdown support. Use a markdown renderer (e.g., `react-markdown` with `remark-gfm`) for headings, lists, links, bold/italic. Render code blocks with syntax highlighting (e.g., `react-syntax-highlighter` or `shiki`). Differentiate agent messages (left-aligned, agent icon) from user messages (right-aligned). Support streaming — render partial text as it arrives.
- [x] T029 [P] [US3] Create `ToolCallCard` component in `packages/acp-client/src/components/ToolCallCard.tsx` — render a visual card for agent tool executions. Show tool name (e.g., "read_file", "write_file", "bash"), target/input summary, and real-time status indicator (spinner for "running", checkmark for "completed", X for "failed"). When completed, show collapsible output. For file edits, render the output as a diff (delegate to `FileDiffView`). For terminal commands, render output in a `TerminalBlock`.
- [x] T030 [P] [US3] Create `PermissionDialog` component in `packages/acp-client/src/components/PermissionDialog.tsx` — render an interactive approval dialog when the agent requests permission to perform an action. Show the tool name, description, and input details (e.g., file path, diff preview). Provide "Approve" and "Reject" buttons that call `respondToPermission(requestId, 'allow_once' | 'deny')` from the `useAcpSession` hook. For file edits, show a preview diff. Auto-scroll to make the dialog visible.
- [x] T031 [P] [US3] Create `ThinkingBlock` component in `packages/acp-client/src/components/ThinkingBlock.tsx` — render a collapsible "Thinking..." section that can be expanded to view the agent's reasoning text. Show animated ellipsis while thinking is in progress. When the thinking phase ends (next agent message or tool call arrives), collapse by default but keep expandable.
- [x] T032 [P] [US3] Create `FileDiffView` component in `packages/acp-client/src/components/FileDiffView.tsx` — render file modifications as a unified diff with syntax highlighting. Parse the diff string (standard unified diff format) and render additions in green, removals in red, context in gray. Show file path header. Use a monospace font. Can be embedded inside `ToolCallCard` for write_file/edit_file tool results.
- [x] T033 [P] [US3] Create `TerminalBlock` component in `packages/acp-client/src/components/TerminalBlock.tsx` — render shell command output within the conversation flow. Show the command that was run in a header bar, and the output in a scrollable monospace block with a dark background. Limit height with scroll overflow for long outputs.
- [x] T034 [P] [US3] Create `UsageIndicator` component in `packages/acp-client/src/components/UsageIndicator.tsx` — display cumulative token usage for the current session (input tokens, output tokens). Update after each `PromptResponse`. Render as a small status bar element.
- [x] T035 [US3] Create `AgentPanel` component in `packages/acp-client/src/components/AgentPanel.tsx` — the main conversation container. Render a scrollable message list using `useAcpMessages` state — map each `ConversationItem` to the appropriate component (`MessageBubble`, `ToolCallCard`, `ThinkingBlock`). Render active `PermissionDialog` overlays. Include a prompt input area at the bottom with a text input, send button, and cancel button (visible during prompting). Auto-scroll to bottom on new messages. Show `UsageIndicator` in a status bar. Accept `useAcpSession` state as props.
- [x] T036 [US3] Export all components and hooks from `packages/acp-client/src/index.ts` barrel — export `AgentPanel`, `MessageBubble`, `ToolCallCard`, `PermissionDialog`, `ThinkingBlock`, `FileDiffView`, `TerminalBlock`, `UsageIndicator`, `useAcpSession`, `useAcpMessages`, and transport utilities
- [x] T037 [US3] Add required dependencies to `packages/acp-client/package.json` — add `react-markdown`, `remark-gfm`, and a syntax highlighter for code blocks. Keep these as dependencies (not peer deps) since they're internal to the package.

#### Web App Integration

- [x] T038 [US3] Integrate `AgentPanel` into `apps/web/src/pages/Workspace.tsx` — when the user is in "Structured View" mode and an ACP session is active (`state === 'ready'`), render the `AgentPanel` component from `@simple-agent-manager/acp-client` in place of the terminal. Pass the `useAcpSession` hook state and actions. The terminal remains mounted but hidden (for instant fallback switching).

**Checkpoint**: Users can have full structured conversations with agents — formatted responses, tool cards, permission dialogs, diffs, and thinking indicators all work.

---

## Phase 6: User Story 4 — Terminal Fallback (Priority: P4)

**Goal**: Users can switch between structured conversation view and raw terminal at any time. If structured connection fails, terminal appears automatically.

**Independent Test**: Open workspace → start agent in structured view → click "Switch to Terminal" → see terminal → click "Switch to Conversation" → see conversation. Then: intentionally break ACP connection → terminal appears automatically with notification.

### Implementation for User Story 4

- [x] T039 [US4] Implement view mode toggle in `apps/web/src/pages/Workspace.tsx` — add a toggle control (tab bar or segmented control) with "Conversation" and "Terminal" options. Track `viewMode` state (`'conversation' | 'terminal'`). When in conversation mode, show `AgentPanel`; when in terminal mode, show `Terminal`. Both remain mounted for instant switching. Default to conversation mode when an ACP session is active, terminal mode otherwise.
- [x] T040 [US4] Implement automatic fallback logic in `apps/web/src/pages/Workspace.tsx` — when the ACP session state transitions to `error` or the WebSocket connection fails and reconnection times out (total timeout configurable via `ACP_RECONNECT_TIMEOUT_MS`, default 30000ms), automatically switch `viewMode` to `'terminal'` and show a notification banner: "Structured view unavailable — using terminal mode". If the agent doesn't support ACP, hide the toggle entirely and only show the terminal (FR-021).
- [x] T041 [US4] Add reconnection logic to `useAcpSession` hook in `packages/acp-client/src/hooks/useAcpSession.ts` — when the WebSocket disconnects unexpectedly, attempt reconnection with exponential backoff (initial delay from `ACP_RECONNECT_DELAY_MS`, total timeout from `ACP_RECONNECT_TIMEOUT_MS`). Track `reconnecting` state. Preserve existing `useAcpMessages` state across reconnects (the React component stays mounted, so message history is retained — verify the hook does not reset state on reconnect). After total timeout expires, transition to `error` state which triggers the terminal fallback. Follow the existing reconnection pattern from `packages/terminal/src/useWebSocket.ts`.

**Checkpoint**: Seamless switching between conversation and terminal. Automatic fallback when ACP fails.

---

## Phase 7: User Story 5 — Agent Operating Modes (Priority: P5)

**Goal**: Users can switch between agent-specific operating modes (e.g., "Ask", "Code", "Architect")

**Independent Test**: Open workspace → start Claude Code agent → see mode selector showing "Ask", "Code", "Architect" → switch to "Architect" mode → see mode update in UI

### Implementation for User Story 5

- [x] T042 [P] [US5] Create `ModeSelector` component in `packages/acp-client/src/components/ModeSelector.tsx` — render a segmented control or dropdown showing the available modes reported by the agent's `InitializeResponse.capabilities.modes`. Highlight the current active mode. Clicking a mode calls `setSessionMode()` from the `useAcpSession` hook. If the agent reports no modes (empty array or undefined), render nothing (FR-021).
- [x] T043 [US5] Wire mode selector into `AgentPanel` in `packages/acp-client/src/components/AgentPanel.tsx` — add `ModeSelector` to the panel header/toolbar area, passing `modes` from `useAcpSession`'s `agentInfo.capabilities.modes` and `currentMode` from session state. The `setSessionMode` action calls `connection.setSessionMode()` from the ACP SDK and updates local state.
- [x] T044 [US5] Export `ModeSelector` from `packages/acp-client/src/index.ts` barrel

**Checkpoint**: Power users can switch agent modes. Modes gracefully hidden when unsupported.

---

## Phase 8: Cloud-Init & Agent Installation

**Purpose**: Ensure all three agents are pre-installed in every workspace

- [x] T045 Extend cloud-init template in `packages/cloud-init/src/template.ts` — add installation commands for all three agents to the devcontainer post-create script: (1) `npm install -g @zed-industries/claude-code-acp` for Claude Code ACP adapter, (2) `npm install -g @google/gemini-cli` for Gemini CLI, (3) `npx --yes @zed-industries/codex-acp --version` for OpenAI Codex ACP adapter (this pre-downloads and caches the Rust binary via npm; at runtime, use `npx @zed-industries/codex-acp` to invoke it). Ensure npm and Node.js are available in the devcontainer. All three commands run during workspace provisioning so agents are ready for instant switching at runtime.
- [x] T046 [P] Update `CLAUDE.md` at repository root — add the new API endpoints (`GET /api/agents`, `PUT /api/credentials/agent`, `GET /api/credentials/agent`, `DELETE /api/credentials/agent/:agentType`, `POST /api/workspaces/:id/agent-key`), new packages (`packages/acp-client`), and new VM Agent endpoints (`/agent/ws`) to the relevant sections.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T047 Add `ACP_INIT_TIMEOUT_MS`, `ACP_RECONNECT_DELAY_MS`, `ACP_RECONNECT_TIMEOUT_MS`, and `ACP_MAX_RESTART_ATTEMPTS` to `Env` interface in `apps/api/src/index.ts` as optional string fields — these are passed to VMs via environment configuration (Constitution Principle XI)
- [x] T048 [P] Validate all hardcoded values against Constitution Principle XI — audit all new files for hardcoded URLs (must derive from `BASE_DOMAIN`), timeouts (must be configurable via env vars), limits (must be configurable), and magic strings (must be constants). Also audit for accidental API key exposure: verify that decrypted agent API keys never appear in application logs, error messages, or debug output (SC-006).
- [x] T049 [P] Ensure idle detection integration — verify that ACP activity (prompts, tool calls, permission responses) properly triggers the workspace idle timer reset in the VM Agent, counting structured agent interactions the same as terminal keystrokes (FR-018)
- [x] T050 Handle edge case: existing workspaces created before multi-agent support — ensure they default to terminal mode with no agent selected, and the agent selector is available once the workspace is running
- [x] T051 Handle edge case: multiple browser tabs — only one active ACP session per workspace. If a second tab connects to `/agent/ws`, the VM Agent should reject with a clear error or notify the first session. Additional tabs fall back to terminal with a notification (per spec edge cases).
- [x] T052 Handle edge case: invalid API key at runtime — when the agent process fails to authenticate (API key rejected by provider), the VM Agent gateway should detect the auth error in the agent's stderr/exit code, send an `agent_status: error` message with an actionable description ("API key for Claude Code is invalid or expired — update it in Settings"), and transition to `error` state. The `useAcpSession` hook should surface this error in the UI. (Spec edge case: "API key becomes invalid after workspace creation")
- [x] T053 Run `pnpm typecheck && pnpm lint && pnpm build` from repo root to verify all new packages compile and integrate correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (needs shared types from T004)
- **User Story 1 (Phase 3)**: Depends on Phase 2 (needs agent credential API + DB schema)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (needs agent credential API)
- **User Story 3 (Phase 5)**: Depends on Phase 3 (needs ACP session hook + gateway)
- **User Story 4 (Phase 6)**: Depends on Phase 5 (needs conversation view to toggle with terminal)
- **User Story 5 (Phase 7)**: Depends on Phase 5 (needs AgentPanel to add mode selector)
- **Cloud-Init (Phase 8)**: Independent — can run in parallel with any phase
- **Polish (Phase 9)**: Depends on all previous phases

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational only — MVP standalone
- **US2 (P2)**: Depends on Foundational only — can run in parallel with US1
- **US3 (P3)**: Depends on US1 (needs ACP session infrastructure)
- **US4 (P4)**: Depends on US3 (needs conversation view for toggle)
- **US5 (P5)**: Depends on US3 (needs AgentPanel for mode selector)

### Within Each User Story

- Models/types before services/hooks
- Services/hooks before UI components
- Backend (VM Agent) before frontend (Web) for US1
- Core components before integration for US3

### Parallel Opportunities

**Phase 1 (Setup)**:
- T002, T003, T004 can all run in parallel (different packages)

**Phase 2 (Foundational)**:
- T009, T011 can start in parallel after T007/T008 (different route files)
- T013 can run in parallel with route work (different file)

**Phase 3 (US1)**:
- T014–T018 (VM Agent Go work) can run in parallel with T019–T020 (TS transport)
- T022 (AgentSelector) can run in parallel with gateway work

**Phase 4 (US2)**:
- T024 (AgentKeyCard) runs in parallel with gateway work from US1
- US2 can start as soon as Phase 2 is complete, in parallel with US1

**Phase 5 (US3)**:
- T027–T034 (all individual components) can ALL run in parallel
- T035 (AgentPanel) depends on T027–T034 being complete

**Phase 7 (US5)**:
- T042 can run in parallel with US4 work

**Phase 8 (Cloud-Init)**:
- T045, T046 are independent of all other phases

---

## Parallel Example: User Story 3 Components

```bash
# Launch all component tasks in parallel (all different files):
Task T027: "useAcpMessages hook in packages/acp-client/src/hooks/useAcpMessages.ts"
Task T028: "MessageBubble component in packages/acp-client/src/components/MessageBubble.tsx"
Task T029: "ToolCallCard component in packages/acp-client/src/components/ToolCallCard.tsx"
Task T030: "PermissionDialog component in packages/acp-client/src/components/PermissionDialog.tsx"
Task T031: "ThinkingBlock component in packages/acp-client/src/components/ThinkingBlock.tsx"
Task T032: "FileDiffView component in packages/acp-client/src/components/FileDiffView.tsx"
Task T033: "TerminalBlock component in packages/acp-client/src/components/TerminalBlock.tsx"
Task T034: "UsageIndicator component in packages/acp-client/src/components/UsageIndicator.tsx"

# Then after all complete:
Task T035: "AgentPanel container in packages/acp-client/src/components/AgentPanel.tsx"
Task T036: "Export all from packages/acp-client/src/index.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (T001–T006)
2. Complete Phase 2: Foundational (T007–T013)
3. Complete Phase 3: User Story 1 — Agent Selection (T014–T023)
4. Complete Phase 4: User Story 2 — API Key Management (T024–T026)
5. **STOP and VALIDATE**: Deploy to staging. Users can select agents and manage keys. Terminal is primary interaction. ACP session initializes in background.
6. Start Phase 8 (Cloud-Init) in parallel with validation.

### Full Feature Delivery

7. Complete Phase 5: User Story 3 — Structured Conversation (T027–T038)
8. Complete Phase 6: User Story 4 — Terminal Fallback (T039–T041)
9. Complete Phase 7: User Story 5 — Operating Modes (T042–T044)
10. Complete Phase 9: Polish (T047–T053)
11. **FINAL VALIDATION**: Full end-to-end test on staging with all three agents.

### Key Library Integration Points

| Task | Library | Key API |
|------|---------|---------|
| T003 | `coder/acp-go-sdk` v0.10.7 | `NewClientSideConnection(client, stdin, stdout)`, `Client` interface |
| T015 | `coder/acp-go-sdk` | `SessionNotification`, `RequestPermissionRequest/Response` |
| T019 | `@agentclientprotocol/sdk` v0.14.x | `ClientSideConnection`, `ndJsonStream` pattern |
| T021 | `@agentclientprotocol/sdk` | `connection.initialize()`, `newSession()`, `prompt()`, `cancel()` |
| T027 | `@agentclientprotocol/sdk` | `SessionUpdate` variants: `AgentMessageChunk`, `ToolCall`, `ToolCallUpdate` |
| T043 | `@agentclientprotocol/sdk` | `connection.setSessionMode()` |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The `codex-acp` adapter is Rust-based but distributed via npm (`npx @zed-industries/codex-acp`) — no Rust toolchain needed on VMs
- ACP protocol is pre-1.0 — expect minor breaking changes. Pin SDK versions.
- All agent commands and args are configurable via `AGENT_CATALOG` in shared package — no hardcoded CLI invocations in VM Agent
